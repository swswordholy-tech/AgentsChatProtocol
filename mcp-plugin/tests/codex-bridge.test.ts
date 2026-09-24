/** Perspective: operators connecting directory-specific agents.
 * Invariant: no identity fallback, cross-channel history, duplicate replies or secret output.
 * Goal: exercise disk state and actual WS/HTTP/stdio boundaries, including ambiguous delivery.
 * Migration: retain with the Codex bridge; fake only the external hub and model process.
 */
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { resolveConfig, type BridgeConfig } from "../codex/config.ts";
import { addressed, Bridge } from "../codex/bridge.ts";
import { AppServer } from "../codex/app-server.ts";
import { AgentsChatTransport } from "../codex/transport.ts";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-bridge-test-")); roots.push(root);
  const cwd = join(root, "project"); mkdirSync(join(cwd, ".agentschat"), { recursive: true });
  mkdirSync(join(root, ".agentschat"));
  for (const name of ["project", "global", "override", "profile"]) writeFileSync(join(root, `.agentschat/${name}.json`),
    JSON.stringify({ agent_id: name, token: `ac_${name.padEnd(24, "x")}` }), { mode: 0o600 });
  const config = (value: any) => writeFileSync(join(cwd, ".agentschat/config.json"), JSON.stringify(value));
  config({ profile: "project" });
  const c = resolveConfig({ cwd }, { AGENTSCHAT_PROFILE: "global" }, root);
  return { root, cwd, config, c };
}
const message = (id = "m1", channel_id = "dm-owner") => ({ id, channel_id, sender_id: "owner", content: "hello" });

test("project selector overrides env, CLI overrides project, agent_id is an assertion", () => {
  const f = fixture(); expect(f.c.agentId).toBe("project");
  expect(resolveConfig({ cwd: f.cwd, profile: "override" }, { AGENTSCHAT_PROFILE: "global" }, f.root).agentId).toBe("override");
  f.config({ profile: "project", agent_id: "global" });
  expect(() => resolveConfig({ cwd: f.cwd }, {}, f.root)).toThrow("does not match");
  f.config({ profile: "missing" });
  expect(() => resolveConfig({ cwd: f.cwd }, { AGENTSCHAT_PROFILE: "global" }, f.root)).toThrow("Selected profile missing");
});
test("local private profile beats env; no parent-directory identity inheritance", () => {
  const f = fixture(); f.config({});
  writeFileSync(join(f.cwd, ".agentschat/profile.json"), JSON.stringify({ agent_id: "local", token: "private-test-token" }), { mode: 0o600 });
  expect(resolveConfig({ cwd: f.cwd }, { AGENTSCHAT_PROFILE: "global" }, f.root).agentId).toBe("local");
  const nested = join(f.cwd, "nested"); mkdirSync(nested);
  expect(resolveConfig({ cwd: nested }, { AGENTSCHAT_PROFILE: "global" }, f.root).agentId).toBe("global");
  chmodSync(join(f.cwd, ".agentschat/profile.json"), 0o644);
  expect(() => resolveConfig({ cwd: f.cwd }, {}, f.root)).toThrow("chmod 600");
});
test("existing project Codex MCP profile beats global env, without importing token overrides", () => {
  const f = fixture(); f.config({}); mkdirSync(join(f.cwd, ".codex"));
  writeFileSync(join(f.cwd, ".codex/config.toml"), '[mcp_servers.agentschat]\nargs = ["agentschat-mcp", "--profile", "project"]\n[mcp_servers.agentschat.env]\nAGENTCHAT_TOKEN = "ignored-secret"\n');
  const c = resolveConfig({ cwd: f.cwd }, { AGENTSCHAT_PROFILE: "global" }, f.root);
  expect(c.source).toBe("project-codex"); expect(c.agentId).toBe("project"); expect(c.token).not.toBe("ignored-secret");
  f.config({ profile: "override" });
  expect(resolveConfig({ cwd: f.cwd }, {}, f.root).agentId).toBe("override");
});
test("bad JSON, dev tokens and inline credential config fail closed", () => {
  const f = fixture(); f.config({ profile: "project", token: "do-not-log-this" });
  expect(() => resolveConfig({ cwd: f.cwd }, {}, f.root)).toThrow("Unknown project config");
  f.config({ profile: "project" });
  writeFileSync(f.c.profileFile, '{"token":"secret-broken');
  expect(() => resolveConfig({ cwd: f.cwd }, {}, f.root)).toThrow("Cannot read valid JSON");
  writeFileSync(f.c.profileFile, JSON.stringify({ agent_id: "project", token: "dev-token" }));
  expect(() => resolveConfig({ cwd: f.cwd }, {}, f.root)).toThrow("Invalid identity profile");
});
test("TLS, same-project/server/identity state and explicit channel/sender filters", () => {
  const f = fixture(); f.config({ profile: "project", api_url: "http://example.com" });
  expect(() => resolveConfig({ cwd: f.cwd }, {}, f.root)).toThrow("TLS");
  f.config({ profile: "project", channels: ["dm-owner"], senders: ["owner"] });
  const c = resolveConfig({ cwd: f.cwd }, {}, f.root);
  expect(addressed(message(), c)).toBe(true);
  expect(addressed(message("m", "dm-other"), c)).toBe(false);
  expect(addressed({ ...message(), sender_id: "stranger" }, c)).toBe(false);
  expect(resolveConfig({ cwd: f.cwd, profile: "override" }, {}, f.root).stateDir).not.toBe(c.stateDir);
});
test("exact mentions only, self/typing/empty events ignored", () => {
  const { c } = fixture();
  expect(addressed(message(), c)).toBe(true);
  expect(addressed({ ...message(), sender_id: "project" }, c)).toBe(false);
  expect(addressed({ ...message(), content: "__typing__" }, c)).toBe(false);
  expect(addressed({ ...message("m", "group"), content: "@project-extra hello" }, c)).toBe(false);
  expect(addressed({ ...message("m", "group"), content: "@project hello" }, c)).toBe(true);
  expect(addressed({ ...message("m", "group"), content: "@Name(project) hello" }, c)).toBe(true);
  expect(addressed({ ...message("m", "group"), mentioned_ids: ["project"] }, c)).toBe(true);
  expect(addressed({ content: "x" }, c)).toBe(false);
});

const fakeAppServer = `
const rl = require('readline').createInterface({input: process.stdin});
const emit = m => process.stdout.write(JSON.stringify(m)+'\\n');
let next=0, configCwd;
rl.on('line', line => {
 const m=JSON.parse(line), p=m.params;
 if(m.method==='initialize') emit({id:m.id,result:{}});
 if(m.method==='config/read') { configCwd=p.cwd; emit({id:m.id,result:{config:{mcp_servers:{agentschat:{command:'must-disable',tool_timeout_sec:null}}}}}); }
 if(m.method==='thread/start'||m.method==='thread/resume') {
  if(configCwd!==p.cwd || p.config!==undefined || p.approvalPolicy!=='never' || p.sandbox!=='danger-full-access')
   return emit({id:m.id,error:{code:-32602,message:'unsafe'}});
  emit({id:m.id,result:{thread:{id:p.threadId||'thread-'+(++next)}}});
 }
 if(m.method==='turn/start') {
  if(p.approvalPolicy!=='never'||p.sandboxPolicy?.type!=='dangerFullAccess') return emit({id:m.id,error:{code:-32602,message:'wrong turn permissions'}});
  const t='turn-'+(++next);
  const done=(method,extra)=>emit({method,params:{threadId:p.threadId,turnId:t,...extra}});
  // Notifications deliberately race ahead of the response; unrelated turns must not leak.
  emit({method:'item/completed',params:{threadId:p.threadId,turnId:'other',item:{type:'agentMessage',id:'wrong',text:'WRONG'}}});
  done('item/completed',{item:{type:'agentMessage',id:'comment',phase:'commentary',text:'PRIVATE PROGRESS'}});
  const item={type:'agentMessage',id:'answer',phase:'final_answer',text:'Verified reply'};
  done('item/completed',{item});
  done('turn/completed',{turn:{id:t,status:'completed',items:[item]}});
  emit({id:m.id,result:{turn:{id:t}}});
 }
});`;
function server(script = fakeAppServer) { return new AppServer("node", ["-e", script], 2000); }

test("official JSON-RPC lifecycle correlates early events and returns only final output", async () => {
  const app = server();
  try { await app.start(); const id = await app.thread("/tmp"); expect(await app.generate(id, "hello")).toBe("Verified reply"); }
  finally { app.close(); }
});
test("failed turns and child exit reject promptly", async () => {
  const app = server(fakeAppServer.replace("status:'completed'", "status:'failed'"));
  try { await app.start(); const id = await app.thread("/tmp"); await expect(app.generate(id, "hello")).rejects.toThrow("failed"); }
  finally { app.close(); }
  const dead = server("process.exit(1)");
  await expect(dead.start()).rejects.toThrow("exited"); dead.close();
});
test("durable dedup, per-channel threads, lock and identity-secret redaction", async () => {
  const { c } = fixture(); const app = server(); await app.start();
  const sent: string[] = [];
  let bridge = new Bridge(c, app, async (_ch, text) => { sent.push(text); }, () => {});
  try {
    expect(() => new Bridge(c, app, async () => {})).toThrow("locked");
    expect(bridge.accept({ ...message(), content: `hi ${c.token}` })).toBe(true);
    expect(bridge.accept(message())).toBe(false);
    bridge.accept(message("m2", "dm-other")); await bridge.drain();
    expect(sent).toEqual(["Verified reply", "Verified reply"]);
    let state = JSON.parse(readFileSync(join(c.stateDir, "state.json"), "utf8"));
    expect(state.threads["dm-owner"]).not.toBe(state.threads["dm-other"]);
    expect(JSON.stringify(state)).not.toContain(c.token);
    await bridge.stop();
    bridge = new Bridge(c, app, async (_ch, text) => { sent.push(text); }, () => {});
    expect(bridge.accept(message())).toBe(false);
    bridge.accept(message("m3")); await bridge.drain();
    state = JSON.parse(readFileSync(join(c.stateDir, "state.json"), "utf8"));
    expect(state.entries.every((e: any) => e.status === "sent")).toBe(true);
  } finally { await bridge.stop(); app.close(); }
});
test("ambiguous delivery is persisted and never automatically resent on restart", async () => {
  const { c } = fixture(); const app = server(); await app.start(); let attempts = 0;
  let bridge = new Bridge(c, app, async () => { attempts++; throw new Error("timeout after commit"); }, () => {});
  try {
    bridge.accept(message()); await bridge.drain(); await bridge.stop();
    bridge = new Bridge(c, app, async () => { attempts++; }, () => {});
    await bridge.drain(); expect(attempts).toBe(1);
    expect(JSON.parse(readFileSync(join(c.stateDir, "state.json"), "utf8")).entries[0].status).toBe("uncertain");
  } finally { await bridge.stop(); app.close(); }
});
test("backend death pauses intake and preserves unstarted queued work", async () => {
  const { c } = fixture();
  const app = server(fakeAppServer.replace("const t='turn-'+(++next);", "process.exit(1); const t='turn-'+(++next);"));
  await app.start();
  const bridge = new Bridge(c, app, async () => { throw new Error("must not send"); }, () => {});
  app.onFatal = () => bridge.pause();
  try {
    bridge.accept(message("m1")); bridge.accept(message("m2"));
    await bridge.drain();
    expect(bridge.accept(message("m3"))).toBe(false);
    expect(JSON.parse(readFileSync(join(c.stateDir, "state.json"), "utf8")).entries.map((e: any) => e.status)).toEqual(["failed", "pending"]);
  } finally { await bridge.stop(); app.close(); }
});
test("restart rechecks allowlists before processing durable pending and ready replies", async () => {
  const { c } = fixture(); mkdirSync(c.stateDir, { recursive: true });
  writeFileSync(join(c.stateDir, "state.json"), JSON.stringify({ version: 1, threads: {}, entries: [
    { message: message("pending"), status: "pending" }, { message: message("ready"), status: "ready", answer: "must not send" },
  ] }));
  c.senders = ["someone-else"];
  const app = server(); let sends = 0;
  const bridge = new Bridge(c, app, async () => { sends++; }, () => {});
  try {
    await bridge.drain(); expect(sends).toBe(0);
    expect(JSON.parse(readFileSync(join(c.stateDir, "state.json"), "utf8")).entries.map((e: any) => e.status)).toEqual(["blocked", "blocked"]);
  } finally { await bridge.stop(); app.close(); }
});
test("real WS auth/membership → stdio generation → acknowledged WS reply roundtrip", async () => {
  const { c } = fixture(); const sent: any[] = [];
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${c.token}`) { res.writeHead(401).end(); return; }
    if (req.url === "/api/channels/mine") { res.end(JSON.stringify({ channels: [{ id: "dm-owner" }] })); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    sent.push({ url: req.url, body: JSON.parse(body) }); res.end('{"id":"reply1"}');
  });
  await new Promise<void>(r => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as any).port; c.apiUrl = `http://127.0.0.1:${port}`; c.wsUrl = `ws://127.0.0.1:${port}/ws`;
  const ws = new WebSocketServer({ server: http });
  ws.on("connection", socket => socket.on("message", raw => {
    const m = JSON.parse(String(raw));
    if (m.type === "auth" && m.agent_id === "project" && m.token === c.token) socket.send('{"type":"auth_ok"}');
    if (m.type === "message") {
      sent.push({ url: "/api/channels/dm-owner/messages", body: { sender_id: m.sender_id, content_type: m.content_type, content: m.content } });
      socket.send(JSON.stringify({type: "message_ack", message_id: m.id}));
    }
    if (m.type === "join_channel") {
      socket.send(JSON.stringify({ type: "message", ...message(), content: "Reply with exactly Verified reply. Do not use tools." }));
      socket.send(JSON.stringify({ type: "message", ...message(), content: "Reply with exactly Verified reply. Do not use tools." }));
    }
  }));
  const live = process.env.AGENTSCHAT_LIVE_CODEX_TEST === "1";
  const app = live ? new AppServer("codex", undefined, 90_000) : server();
  await app.start();
  const transport = new AgentsChatTransport(c, m => bridge.accept(m), () => {});
  let liveFailure: unknown;
  const checked = async <T>(label: string, call: () => Promise<T>): Promise<T> => {
    try { const value = await call(); if (live) console.error(`Live smoke: ${label} OK`); return value; }
    catch (e) { liveFailure = e; if (live) console.error(`Live smoke: ${label} failed`, e); throw e; }
  };
  const generator = { thread: (cwd: string, existing?: string) => checked("thread", () => app.thread(cwd, existing, live)), generate: (id: string, text: string) => checked("generation", () => app.generate(id, text, live ? "low" : undefined)) };
  const bridge = new Bridge(c, generator, (chat, text) => transport.send(chat, text), () => {});
  try {
    transport.start();
    const deadline = Date.now() + (live ? 95_000 : 4000);
    while (!sent.length && !liveFailure && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    await bridge.drain();
    if (liveFailure) throw liveFailure;
    expect(sent).toEqual([{ url: "/api/channels/dm-owner/messages", body: { sender_id: "project", content_type: "text", content: "Verified reply" } }]);
  } finally { transport.stop(); await bridge.stop(); app.close(); for (const client of ws.clients) client.terminate(); ws.close(); http.closeAllConnections(); await new Promise<void>(r => http.close(() => r())); }
}, 120_000);

test("lost WS acknowledgement stays uncertain without a second REST send", async () => {
  const { c } = fixture(); let posts = 0;
  const http = createServer((req, res) => { if (req.method === "POST") posts++; res.end('{"channels":[]}'); });
  await new Promise<void>(r=>http.listen(0,"127.0.0.1",r));
  c.apiUrl=`http://127.0.0.1:${(http.address() as any).port}`; c.wsUrl=c.apiUrl.replace("http","ws");
  const ws=new WebSocketServer({server:http});
  ws.on("connection",socket=>socket.on("message",raw=>{const m=JSON.parse(String(raw));
    if(m.type==="auth") socket.send('{"type":"auth_ok"}');
    if(m.type==="message") { socket.send(JSON.stringify({type:"message_ack",message_id:"unrelated"})); socket.close(); }
  }));
  let ready!:()=>void; const connected=new Promise<void>(r=>ready=r);
  const t=new AgentsChatTransport(c,()=>{},s=>{if(s.includes("connected as"))ready();});
  try {t.start();await connected;await expect(t.send("dm-owner","test")).rejects.toThrow("acknowledgement");expect(posts).toBe(0);}
  finally{t.stop();for(const c of ws.clients)c.terminate();ws.close();http.closeAllConnections();await new Promise<void>(r=>http.close(()=>r()));}
});

test("typing follows actual processing and clears on success or either failure", async () => {
  for (const failure of ["none", "generation", "send"]) {
    const { c } = fixture(); const activity: boolean[] = [];
    const bridge = new Bridge(c, { thread: async()=>"t", generate: async()=>{if(failure==="generation")throw Error("generation failed");return "reply";} },
      async()=>{if(failure==="send")throw Error("send failed");},()=>{},(_channel,active)=>activity.push(active));
    try {bridge.accept(message());await bridge.drain();expect(activity).toEqual([true,false]);}
    finally {await bridge.stop();}
  }
});


test("full access is default, read-only is explicit, invalid modes fail closed", () => {
  const f = fixture(); expect(f.c.permissions).toBe("full-access");
  f.config({profile: "project", permissions: "read-only"});
  expect(resolveConfig({cwd:f.cwd}, {}, f.root).permissions).toBe("read-only");
  f.config({profile: "project", permissions: "typo"});
  expect(() => resolveConfig({cwd:f.cwd}, {}, f.root)).toThrow("permissions");
});
test("create and resume both apply permissions and each turn preserves them", async () => {
  for (const mode of ["full-access", "read-only"] as const) {
    const script = mode === "full-access" ? fakeAppServer : fakeAppServer
      .replace("p.config!==undefined", "p.config?.mcp_servers?.agentschat?.enabled!==false")
      .replace("p.sandbox!=='danger-full-access'", "p.sandbox!=='read-only'")
      .replace("p.sandboxPolicy?.type!=='dangerFullAccess'", "p.sandboxPolicy?.type!=='readOnly'");
    const app = new AppServer("node", ["-e", script], 2000, mode);
    try {
      await app.start(); const id = await app.thread("/tmp");
      expect(await app.thread("/tmp", id)).toBe(id);
      expect(await app.generate(id, "test")).toBe("Verified reply");
    } finally { app.close(); }
  }
});
