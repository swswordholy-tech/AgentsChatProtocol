import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBots } from "../codex/bots-config.ts";
import { modelName, reasoningEffort, resolveConfig, type BridgeConfig } from "../codex/config.ts";
import { authorizedLoopTick } from "../codex/loop-grants.ts";
import { getBotOwner } from "../codex/owner.ts";
import { prepareRuntimeHome } from "../codex/runtime-home.ts";
import { preserveChannelHistory, priorChannelThreads } from "../codex/thread-history.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

test("authorizedLoopTick permits regular grant files on win32 without getuid while enforcing POSIX uid checks", () => {
  const stateDir = tempDir("codex-win32-grants-");
  const config: BridgeConfig = {
    stateDir,
    agentId: "bot-win",
    cwd: stateDir,
    permissions: "full-access",
    token: "ac_fixture",
    profileFile: "unused",
    source: "test",
    apiUrl: "https://agents-chat.com",
    wsUrl: "wss://agents-chat.com/ws",
    channels: [],
    senders: [],
    codexBin: "codex",
  };
  const grant = {
    loop_id: "loop-win",
    channel_id: "dm-owner",
    agent_id: "bot-win",
    owner_id: "owner-1",
    interval_ms: 600_000,
    prompt: "Check status",
  };
  const file = join(stateDir, "loop-grants.json");
  writeFileSync(file, JSON.stringify({ version: 1, grants: [grant] }), { mode: 0o600 });
  const raw = {
    id: "m1",
    channel_id: "dm-owner",
    sender_id: "bot-win",
    meta: {
      kind: "loop_tick" as const,
      loop_id: "loop-win",
      interval_ms: 600_000,
      next_tick_ms: 1_200_000,
      prompt: "Check status",
    },
  };
  expect(authorizedLoopTick(raw, config, { platform: "win32", getuid: undefined })).toEqual(grant);
  expect(authorizedLoopTick(raw, config, { platform: "linux", getuid: undefined })).toBeNull();
  expect(authorizedLoopTick(raw, config, { platform: "linux", getuid: () => (process.getuid?.() ?? 0) + 1 })).toBeNull();
});

test("getBotOwner cancels unconsumed response bodies on partial HTTP failure or peer rejection", async () => {
  for (const failOnboarding of [true, false]) {
    let okCancelled = false;
    let errCancelled = false;
    const makeStreamResponse = (payload: unknown, status: number, onCancel: () => void) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
          },
          cancel() {
            onCancel();
          },
        }),
        { status, headers: { "content-type": "application/json" } },
      );

    const request = (async (url: RequestInfo | URL) => {
      const onboarding = String(url).endsWith("/api/account/onboarding");
      if (onboarding === failOnboarding) {
        return makeStreamResponse({ error: "denied" }, 403, () => { errCancelled = true; });
      }
      return makeStreamResponse(
        onboarding ? { agent_id: "bot-1", claimed: true } : { owner_account_id: "owner-1" },
        200,
        () => { okCancelled = true; },
      );
    }) as typeof fetch;

    expect(await getBotOwner("https://test.invalid", "bot-1", "ac_test", request)).toBeNull();
    expect(okCancelled).toBe(true);
    expect(errCancelled).toBe(true);
  }

  let survivingCancelled = false;
  const rejectOne = (async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/api/account/onboarding")) throw new Error("network down");
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"owner_account_id":"owner-1"}'));
        },
        cancel() {
          survivingCancelled = true;
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  expect(await getBotOwner("https://test.invalid", "bot-1", "ac_test", rejectOne)).toBeNull();
  expect(survivingCancelled).toBe(true);

  for (const badOwner of [" owner-1 ", "owner\n1", "owner\x001"]) {
    const req = (async (url: RequestInfo | URL) =>
      Response.json(String(url).endsWith("/api/account/onboarding")
        ? { agent_id: "bot-1", claimed: true }
        : { owner_account_id: badOwner })) as typeof fetch;
    expect(await getBotOwner("https://test.invalid", "bot-1", "ac_test", req)).toBeNull();
  }
});

test("bots registry and config reject dot-dot segments, prototype selectors, control characters and directory profiles", () => {
  const home = tempDir("codex-cfg-hardening-");
  const profiles = join(home, ".agentschat/profiles");
  const cwd = join(home, "workspace");
  mkdirSync(profiles, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(profiles, "valid.json"), JSON.stringify({ agent_id: "bot-ok", token: "ac_ok_token" }), { mode: 0o600 });

  const regFile = join(home, "bots.json");
  for (const badName of ["constructor", "prototype", "CONSTRUCTOR", "bot\n1"]) {
    writeFileSync(regFile, JSON.stringify({ version: 1, default_workdir: cwd, bots: [{ name: badName, profile: "valid" }] }));
    expect(() => loadBots(regFile, home)).toThrow();
  }
  for (const badProfile of ["a..b", "valid..", "constructor", "constructor.json", "prototype.json", "__proto__.json"]) {
    writeFileSync(regFile, JSON.stringify({ version: 1, default_workdir: cwd, bots: [{ name: "one", profile: badProfile }] }));
    expect(() => loadBots(regFile, home)).toThrow("central profile");
    expect(() => resolveConfig({ cwd, profile: badProfile }, {}, home)).toThrow();
  }
  for (const ctrl of ["gpt-5\0bad", "gpt-5\nbad"]) {
    expect(() => modelName(ctrl)).toThrow("model");
    expect(() => reasoningEffort(ctrl)).toThrow("effort");
  }
  expect(() => resolveConfig({ cwd, profile: "valid", codexBin: "codex\0bad" }, {}, home)).toThrow("codex_bin");

  const dirProfile = join(home, "dir-profile.json");
  mkdirSync(dirProfile, { mode: 0o700 });
  expect(() => resolveConfig({ cwd, profile: dirProfile }, {}, home)).toThrow("regular file");
});

test("thread history rejects symlink clobbering, ignores prototype keys and tolerates malformed envelopes", () => {
  const map = JSON.parse('{"__proto__":"evil","constructor":"evil","prototype":"evil","chan":"t1","bad":""}');
  expect(priorChannelThreads(map, "chan")).toEqual(["t1"]);
  expect(priorChannelThreads(map, "constructor")).toEqual([]);

  const root = tempDir("codex-history-hardening-");
  const prompt = preserveChannelHistory(root, "chan", [
    {
      id: "h1",
      turns: [
        {
          id: "001",
          items: [
            { type: "userMessage", content: [{ type: "text", text: "AgentsChat message:\nnull" }] },
            { type: "userMessage", content: [{ type: "text", text: "AgentsChat message:\n[1,2,3]" }] },
            { type: "userMessage", content: null },
            { type: "agentMessage", phase: "final_answer", text: "clean reply" },
          ],
        },
      ],
    },
  ], s => s);
  expect(prompt).toContain("clean reply");
  const histDir = join(root, "history");
  expect(readdirSync(histDir).filter(f => f.endsWith(".tmp"))).toEqual([]);

  const outside = join(root, "outside.json");
  writeFileSync(outside, "do-not-overwrite");
  const archiveFile = join(histDir, readdirSync(histDir)[0]!);
  rmSync(archiveFile);
  symlinkSync(outside, archiveFile);
  expect(() => preserveChannelHistory(root, "chan", [], s => s)).toThrow("symlink");
});

test("independent runtime home rejects planted FIFO special files on POSIX", () => {
  if (process.platform === "win32") return;
  const root = tempDir("codex-fifo-home-");
  const runtime = prepareRuntimeHome(join(root, "bot"), join(root, "unused"), "isolated");
  const fifo = join(runtime.home, "planted.pipe");
  const mk = spawnSync("mkfifo", [fifo]);
  if (mk.status !== 0) return;
  expect(() => prepareRuntimeHome(join(root, "bot"), join(root, "unused"), "isolated")).toThrow("regular files");
});
