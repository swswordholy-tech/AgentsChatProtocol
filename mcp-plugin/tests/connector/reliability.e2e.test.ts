import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { makeUpgradeToken } from "../../connector/auth.ts";

const ids = ["a", "b"].map(x => ({ botId: `agent-${x}`, agentId: `agent-${x}`, gatewayId: `gw-${x}`, secret: `FAKE_SECRET_${x}`, token: `FAKE_TOKEN_${x}` }));
async function until(check: () => boolean, ms = 2500) {
  for (let n = 0; n < ms / 10; n++) { if (check()) return; await Bun.sleep(10); }
  expect(check()).toBe(true);
}
async function fixture(raw = JSON.stringify(ids), handler?: (req: Request) => Response | Promise<Response>) {
  const auth: any[] = [], platform = new Map<string, any>();
  const hub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req, server) {
    if (new URL(req.url).pathname === "/ws" && server.upgrade(req)) return;
    if (new URL(req.url).pathname === "/api/channels/mine") return Response.json({ channels: [] });
    return handler?.(req) ?? Response.json({ messages: [] });
  }, websocket: { message(ws, data) {
    const f = JSON.parse(String(data));
    if (f.type === "auth") { auth.push(f); platform.set(f.agent_id, ws); ws.send(JSON.stringify({ type: "auth_ok" })); }
    if (f.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
  } } });
  const dir = mkdtempSync(join(tmpdir(), "connector-review-")), file = join(dir, "identities.json");
  writeFileSync(file, raw);
  const proc = Bun.spawn([process.execPath, "connector/run.ts"], {
    cwd: new URL("../../", import.meta.url).pathname,
    env: { PATH: process.env.PATH, HOME: dir, RELAY_IDENTITIES_FILE: file, RELAY_PORT: "0", AGENTCHAT_API_URL: `http://127.0.0.1:${hub.port}`, AGENTCHAT_WS_URL: `ws://127.0.0.1:${hub.port}/ws`, AGENTCHAT_CURSOR_DIR: dir },
    stdout: "ignore", stderr: "pipe",
  });
  let logs = "";
  const logTask = (async () => { const reader = proc.stderr.getReader(); for (;;) { const { done, value } = await reader.read(); if (done) break; logs += new TextDecoder().decode(value); } })();
  const clients: WebSocket[] = [];
  return { auth, platform, proc, logs: () => logs, breakNetwork: () => hub.stop(true),
    async ready() { await until(() => auth.length === 2); },
    async reload(raw: string) { writeFileSync(file, raw); proc.kill("SIGHUP"); await until(() => logs.includes("hot-reload")); },
    async dial(hello: any = { type: "hello", platform: "agentschat", botId: ids[0].botId }) {
      const port = logs.match(/listening on 127\.0\.0\.1:(\d+)/)![1];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`, { headers: { Authorization: `Bearer ${makeUpgradeToken(ids[0].gatewayId, ids[0].secret, 0)}` } });
      clients.push(ws); const frames: any[] = [];
      ws.on("message", d => frames.push(JSON.parse(String(d))));
      await new Promise<void>((r, j) => { ws.once("open", r); ws.once("error", j); });
      let close: { code: number; reason: string } | undefined;
      ws.on("close", (code, reason) => { close = { code, reason: String(reason) }; });
      ws.send(JSON.stringify(hello));
      await until(() => frames.length > 0);
      return { ws, frames, closed: () => close };
    },
    async stop() { clients.forEach(c => c.terminate()); if (proc.exitCode === null) proc.kill(); await proc.exited; await logTask; hub.stop(true); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("hello rejection closes promptly with safe reasons and success logs identity", async () => {
  const f = await fixture();
  try {
    await f.ready();
    for (const [platform, botId, reason] of [["FAKE_SECRET_a\n", ids[0].botId, "unsupported_platform"], ["agentschat", "FAKE_TOKEN_a", "unknown_identity"], ["agentschat", ids[1].botId, "credential_mismatch"]]) {
      const c = await f.dial({ type: "hello", platform, botId });
      await until(() => !!c.closed(), 500);
      expect(c.closed()).toEqual({ code: 1002, reason: `hello rejected: ${reason}` });
      expect(c.frames.some(f => f.type === "descriptor")).toBe(false);
      expect(f.logs()).toContain(`reason=${reason}`);
    }
    await f.dial();
    expect(f.logs()).toContain("hello accepted");
    expect(f.logs()).toContain('botId="agent-a"');
    expect(f.logs()).not.toContain("FAKE_");
  } finally { await f.stop(); }
});

test("outbound network failure reports unknown outcome without exception details", async () => {
  const f = await fixture();
  try {
    await f.ready(); const c = await f.dial(); f.breakNetwork();
    c.ws.send(JSON.stringify({ type: "outbound", requestId: "network", action: { op: "send", chat_id: "room", content: "local fixture only" } }));
    await until(() => c.frames.some(f => f.requestId === "network"), 500);
    expect(c.frames.find(f => f.requestId === "network").result).toEqual({ success: false, error: "agentschat network failure; outcome unknown", code: "platform_network_error", ambiguous: true });
    expect(JSON.stringify(c.frames) + f.logs()).not.toContain("FAKE_");
  } finally { await f.stop(); }
});

test.each([401, 403, 429, 503])("outbound HTTP %s returns immediate sanitized correlated failure", async status => {
  const f = await fixture(JSON.stringify(ids), () => new Response("FAKE_TOKEN_a FAKE_SECRET_a", { status }));
  try {
    await f.ready(); const c = await f.dial();
    c.ws.send(JSON.stringify({ type: "outbound", requestId: "rejected", action: { op: "send", chat_id: "room", content: "local fixture only" } }));
    await until(() => c.frames.some(f => f.requestId === "rejected"), 500);
    const result = c.frames.find(f => f.requestId === "rejected").result;
    expect(result).toEqual({ success: false, error: `agentschat HTTP ${status}`, code: "platform_http_error", status, ambiguous: status >= 500 });
    expect(JSON.stringify(result) + f.logs()).not.toContain("FAKE_");
  } finally { await f.stop(); }
});

test("hung context HTTP falls back and releases ordered queued mentions", async () => {
  let requests = 0;
  const f = await fixture(JSON.stringify(ids), () => {
    requests++;
    return new Promise<Response>(() => {});
  });
  try {
    await f.ready(); const c = await f.dial();
    for (const id of ["first", "second"]) f.platform.get(ids[0].agentId).send(JSON.stringify({ type: "message", id, channel_id: "room", sender_id: "human", content: "@agent-a", timestamp: "2026-09-01T00:00:01Z" }));
    await until(() => c.frames.filter(f => f.type === "inbound").length === 2, 3500);
    expect(c.frames.filter(f => f.type === "inbound").map(f => [f.event.message_id, f.event.context])).toEqual([["first", undefined], ["second", undefined]]);
    expect(requests).toBe(2);
  } finally { await f.stop(); }
}, 6000);

test.each(["remove", "rotate"])("pending reconnect cannot resurrect old credentials after %s", async mode => {
  const f = await fixture();
  try {
    await f.ready(); f.platform.get(ids[0].agentId).close();
    await until(() => f.logs().includes("reconnecting in"));
    const next = mode === "remove" ? [ids[1]] : [{ ...ids[0], token: "FAKE_ROTATED" }, ids[1]];
    await f.reload(JSON.stringify(next));
    await Bun.sleep(1300);
    expect(f.auth.filter(a => a.agent_id === ids[0].agentId).map(a => a.token)).toEqual(mode === "remove" ? [ids[0].token] : [ids[0].token, "FAKE_ROTATED"]);
  } finally { await f.stop(); }
});

test("invalid configuration never echoes fake credentials at startup or reload", async () => {
  for (const raw of [JSON.stringify([{ token: "FAKE_TOKEN_LEAK", secret: "FAKE_SECRET_LEAK" }]), 'FAKE_TOKEN_LEAK FAKE_SECRET_LEAK', JSON.stringify([{ ...ids[0], botId: { token: "FAKE_TOKEN_LEAK" } }]), JSON.stringify([1, 2].map(() => ({ ...ids[0], botId: "FAKE_TOKEN_LEAK" })))]) {
    const f = await fixture(raw);
    try { expect(await f.proc.exited).toBe(1); await until(() => f.logs().length > 0); expect(f.logs()).not.toContain("FAKE_"); expect(f.logs()).toContain("RELAY_IDENTITIES_FILE"); }
    finally { await f.stop(); }
    const live = await fixture();
    try { await live.ready(); await live.reload(raw); expect(live.logs()).toContain("keeping previous identities"); expect(live.logs()).not.toContain("FAKE_"); }
    finally { await live.stop(); }
  }
});
