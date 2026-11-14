import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { atomicWriteJson, isFreshWakeTimestamp, readBody, redactWakeLog, runWakeCommand,
  signWakeBody, verifyWakeSignature, WAKE_BODY_MAX_BYTES, WAKE_REPLAY_WINDOW_MS } from "../scripts/example-url-wake-receiver.mjs";
import { isLockOwnerAlive, parseBinds, parseBindsText } from "../scripts/ensure-grok-wakes.mjs";

test("HMAC rejects nonhex extension, odd nibble, whitespace and wrong bodies", () => {
  const body = '{"channel_id":"room"}', secret = "test-secret", sig = signWakeBody(body, secret);
  expect(verifyWakeSignature(body, sig.toUpperCase(), secret)).toBe(true);
  for (const bad of [sig + "x", sig + "0", sig + "00", sig + "\n", " " + sig, sig.slice(1), "g".repeat(64)])
    expect(verifyWakeSignature(body, bad, secret)).toBe(false);
  expect(verifyWakeSignature(body + " ", sig, secret)).toBe(false);
});

test("signed timestamp freshness bounds reject replay, future and missing values", () => {
  const now = Date.now();
  for (const offset of [-WAKE_REPLAY_WINDOW_MS, 0, WAKE_REPLAY_WINDOW_MS])
    expect(isFreshWakeTimestamp(new Date(now + offset).toISOString(), now)).toBe(true);
  for (const value of [undefined, 0, "yesterday", "2026-01-01", new Date(now - WAKE_REPLAY_WINDOW_MS - 1).toISOString(), new Date(now + WAKE_REPLAY_WINDOW_MS + 1).toISOString()])
    expect(isFreshWakeTimestamp(value, now)).toBe(false);
});

test("body cap counts actual bytes across chunks and rejects aborted input", async () => {
  const exact = new PassThrough();
  const accepted = readBody(exact);
  exact.end(Buffer.alloc(WAKE_BODY_MAX_BYTES, 65));
  expect(Buffer.byteLength(await accepted)).toBe(WAKE_BODY_MAX_BYTES);
  const large = new PassThrough();
  const rejected = readBody(large);
  large.write(Buffer.alloc(WAKE_BODY_MAX_BYTES - 1));
  large.end("汉");
  await expect(rejected).rejects.toMatchObject({ statusCode: 413 });
  const aborted = new PassThrough();
  const fail = readBody(aborted);
  aborted.emit("aborted");
  await expect(fail).rejects.toThrow("aborted");
});

test("atomic JSON replacement is private and leaves no temporary files", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-atomic-"));
  try {
    const file = join(dir, "state.json");
    writeFileSync(file, "broken", { mode: 0o644 });
    atomicWriteJson(file, { ok: 1 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ok: 1 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["state.json"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("binds reject prototype/path rows and invalid top-level shapes before pruning", () => {
  for (const text of ['null', '[]', '42', '"str"', '{broken', '{"constructor":"Bot"}', '{"__proto__":"Bot"}', '{"id":"../Bot"}', '{"id":4}'])
    expect(parseBindsText(text).malformed).toBe(true);
  expect(parseBindsText('{}')).toEqual({ binds: {}, malformed: false });
  expect(parseBindsText('{"id":"Bot"}').binds).toEqual({ id: "Bot" });
  expect(Object.hasOwn(parseBinds(JSON.parse('{"__proto__":"Bot","prototype":"Bot","ok":"Bot"}')), "__proto__")).toBe(false);
});

test("PID check never signals process groups and preserves uncertain live owners", () => {
  for (const pid of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(isLockOwnerAlive(pid, { kill: () => { throw new Error("must not signal"); } })).toBe(false);
  expect(isLockOwnerAlive(23, { kill: () => { throw Object.assign(new Error(), { code: "EPERM" }); }, readCmdline: () => null })).toBe(true);
  expect(isLockOwnerAlive(23, { kill: () => {}, readCmdline: () => "node\0unrelated" })).toBe(false);
});

test("child deadline kills shell descendants and failed commands surface safe errors", async () => {
  await runWakeCommand("cat >/dev/null", "input", process.env, 1000);
  await expect(runWakeCommand("sleep 10", "", process.env, 50)).rejects.toThrow("timed out");
  await expect(runWakeCommand("exit 7", "", process.env, 1000)).rejects.toThrow("command failed");
});

test("logs scrub credential and newline injection", () => {
  const clean = redactWakeLog("ac_private_123 sk-private_123 Bearer token123\nforged");
  expect(clean).not.toContain("private");
  expect(clean).not.toContain("token123");
  expect(clean).not.toContain("\n");
});

test("registration atomically writes 0600 JSON and refuses malformed unsafe binds", () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-register-"));
  const script = resolve(import.meta.dir, "../scripts/grok-bind-register.sh");
  const binds = join(dir, "grok-binds.json");
  const uuid = "11111111-1111-1111-1111-111111111111";
  const env = { ...process.env, AGENTSCHAT_DIR: dir, AGENTCHAT_GROK_BINDS: binds, CURSOR_CONVERSATION_ID: uuid };
  try {
    writeFileSync(join(dir, "Bot.json"), "{}");
    let result = spawnSync("sh", [script, "Bot"], { env, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(binds, "utf8"))).toEqual({ [uuid]: "Bot" });
    for (const file of [binds, join(dir, "grok-binds.meta.json"), binds + ".lock"])
      expect(statSync(file).mode & 0o777).toBe(0o600);
    for (const malformed of ["{bad", '{"__proto__":"Bot"}', '{"id":"../../Bot"}', "[]"]) {
      writeFileSync(binds, malformed);
      result = spawnSync("sh", [script, "Bot"], { env, encoding: "utf8" });
      expect(result.status).toBe(6);
      expect(readFileSync(binds, "utf8")).toBe(malformed);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("HTTP receiver enforces signature, timestamp, size and dedupe before queueing", async () => {
  const { spawn } = await import("node:child_process");
  const { createServer } = await import("node:net");
  const portProbe = createServer();
  await new Promise<void>((ok) => portProbe.listen(0, "127.0.0.1", ok));
  const port = (portProbe.address() as { port: number }).port;
  await new Promise<void>((ok) => portProbe.close(() => ok()));
  const dir = mkdtempSync(join(tmpdir(), "wake-http-"));
  const child = spawn("node", [resolve(import.meta.dir, "../scripts/example-url-wake-receiver.mjs")], {
    env: { ...process.env, AGENTCHAT_WAKE_SECRET: "test-secret", AGENTCHAT_URL_WAKE_PORT: String(port),
      AGENTCHAT_URL_WAKE_PROFILE: "Bot", AGENTCHAT_URL_WAKE_AGENT_ID: "bot-id", AGENTCHAT_URL_WAKE_DIR: dir,
      AGENTCHAT_URL_WAKE_CMD: "" }, stdio: "ignore",
  });
  try {
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(url + "/health")).ok) { ready = true; break; } } catch {}
      await new Promise((ok) => setTimeout(ok, 10));
    }
    expect(ready).toBe(true);
    const post = (body: string, sig = signWakeBody(body, "test-secret")) => fetch(url + "/wake", {
      method: "POST", headers: { "x-agentschat-signature": sig }, body,
    });
    const body = JSON.stringify({ channel_id: "room", message_id: "one", timestamp: new Date().toISOString() });
    expect((await post(body, signWakeBody(body, "test-secret") + "x")).status).toBe(401);
    expect((await post(JSON.stringify({ channel_id: "room" }))).status).toBe(400);
    expect((await post(JSON.stringify({ channel_id: "room", timestamp: "2000-01-01T00:00:00Z" }))).status).toBe(400);
    expect((await post("x".repeat(WAKE_BODY_MAX_BYTES + 1))).status).toBe(413);
    expect((await post(body)).status).toBe(202);
    expect((await (await post(body)).json()).deduped).toBe(true);
  } finally {
    const closed = new Promise((ok) => child.once("close", ok));
    child.kill("SIGTERM");
    await closed;
    rmSync(dir, { recursive: true, force: true });
  }
});
