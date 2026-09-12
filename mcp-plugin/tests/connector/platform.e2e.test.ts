import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { makeUpgradeToken } from "../../connector/auth.ts";

async function until(check: () => boolean, label: string) {
  for (let n = 0; n < 300; n++) { if (check()) return; await Bun.sleep(10); }
  throw new Error(`timeout: ${label}`);
}

test.each([
  ["source", process.execPath, "connector/run.ts"],
  ["Node bundle", "node", "dist/connector.js"],
])("real platform sockets fan out once and retain per-bot REST credentials (%s)", async (_label, runtime, entry) => {
  const ids = ["a", "b"].map(x => ({ botId: `agent-${x}`, agentId: `agent-${x}`, gatewayId: `gw-${x}`, secret: `secret-${x}`, token: `ac_${x}` }));
  const platform = new Map<string, any>();
  const rest: any[] = [];
  const hub = Bun.serve<{ botId?: string }>({
    port: 0, hostname: "127.0.0.1",
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws" && server.upgrade(req, { data: {} })) return;
      if (url.pathname === "/api/channels/mine") return Response.json({ channels: [{ id: "room" }] });
      if (req.method === "POST") {
        rest.push({ authorization: req.headers.get("authorization"), ...await req.json() as any });
        return Response.json({ id: `sent-${rest.length}` });
      }
      return Response.json({ messages: [] });
    },
    websocket: { message(ws, data) {
      const f = JSON.parse(String(data));
      if (f.type === "auth") { ws.data.botId = f.agent_id; platform.set(f.agent_id, ws); ws.send(JSON.stringify({ type: "auth_ok" })); }
      if (f.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    } },
  });
  const dir = mkdtempSync(join(tmpdir(), "connector-platform-"));
  const proc = Bun.spawn([runtime, entry], {
    cwd: new URL("../../", import.meta.url).pathname,
    env: { ...process.env, RELAY_IDENTITIES: JSON.stringify(ids), RELAY_IDENTITIES_FILE: "", RELAY_PORT: "0", RELAY_HOST: "127.0.0.1", AGENTCHAT_API_URL: `http://127.0.0.1:${hub.port}`, AGENTCHAT_WS_URL: `ws://127.0.0.1:${hub.port}/ws`, AGENTCHAT_CURSOR_DIR: dir },
    stdout: "ignore", stderr: "pipe",
  });
  let logs = "";
  const logTask = (async () => {
    const reader = proc.stderr.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; logs += new TextDecoder().decode(value); }
  })();
  const clients: WebSocket[] = [];
  try {
    await until(() => /listening on 127\.0\.0\.1:(\d+)/.test(logs) && platform.size === 2, "connector startup: " + logs);
    const port = logs.match(/listening on 127\.0\.0\.1:(\d+)/)![1];
    expect(port).not.toBe("0");
    const frames: any[][] = [];
    for (const id of ids) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`, { headers: { Authorization: `Bearer ${makeUpgradeToken(id.gatewayId, id.secret, 0)}` } });
      clients.push(ws);
      const inbox: any[] = []; frames.push(inbox);
      ws.on("message", d => inbox.push(JSON.parse(d.toString())));
      await new Promise<void>((r, j) => { ws.once("open", r); ws.once("error", j); });
      ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: id.botId }));
      await until(() => inbox.length === 1, "hello");
    }
    const push = (id: string, sender_id: string, channel_id = "room") => {
      const frame = JSON.stringify({ type: "message", id, channel_id, sender_id, content: "@agent-a @agent-b @agent-a", timestamp: "2026-09-01T00:00:00Z" });
      for (const ws of platform.values()) ws.send(frame);
    };
    push("human-multi", "human");
    await until(() => frames.every(fs => fs.some(f => f.event?.message_id === "human-multi")), "human fanout");
    await Bun.sleep(60);
    expect(frames.map(fs => fs.filter(f => f.type === "inbound").map(f => f.event.message_id))).toEqual([["human-multi"], ["human-multi"]]);
    // A's own socket is first: self-echo must not poison B's delivery dedup key.
    push("bot-multi", "agent-a");
    await Bun.sleep(100);
    expect(frames.map(fs => fs.filter(f => f.type === "inbound").map(f => f.event.message_id))).toEqual([["human-multi"], ["human-multi", "bot-multi"]]);
    push("bot-dm", "agent-a", "dm-a-b");
    await Bun.sleep(100);
    expect(frames.map(fs => fs.filter(f => f.type === "inbound").map(f => f.event.message_id))).toEqual([["human-multi"], ["human-multi", "bot-multi", "bot-dm"]]);
    // Separate gateways can safely omit botId; REST must use each connection's token.
    for (const i of [1, 0]) clients[i].send(JSON.stringify({ type: "outbound", requestId: `reply-${i}`, action: { op: "send", chat_id: "room", content: `reply-${i}` } }));
    await until(() => rest.length === 2, "REST replies");
    expect(rest.map(r => [r.sender_id, r.authorization]).sort()).toEqual([["agent-a", "Bearer ac_a"], ["agent-b", "Bearer ac_b"]]);
  } finally {
    clients.forEach(ws => ws.terminate());
    proc.kill(); await proc.exited; await logTask;
    hub.stop(true); rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
