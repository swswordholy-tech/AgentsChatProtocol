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
import { resolveConfig, type BridgeConfig, type PermissionMode } from "../codex/config.ts";
import { addressed, Bridge } from "../codex/bridge.ts";
import { AppServer, ThreadBusyError } from "../codex/app-server.ts";
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
const legacyLane = (channel: string, permissions: PermissionMode, source = "owner") => JSON.stringify([channel, permissions, source]);
const verifiedOwner = async () => "owner";
function ownedBridge(...args: ConstructorParameters<typeof Bridge>) {
  return new Bridge(args[0], args[1], args[2], args[3], args[4], verifiedOwner);
}

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
const permissions=new Map(), trace=[];
rl.on('line', line => {
 const m=JSON.parse(line), p=m.params;
 if(m.method==='test/trace') return emit({id:m.id,result:trace});
 if(['config/read','thread/start','thread/resume','turn/start'].includes(m.method)) trace.push({method:m.method,params:p});
 if(m.method==='thread/read') return emit({id:m.id,result:{thread:{id:p.threadId,turns:[{id:'001',items:[{type:'agentMessage',phase:'final_answer',text:'history from '+p.threadId}]}]}}});
 if(m.method==='thread/name/set') return emit({id:m.id,result:{}});
 if(m.method==='initialize') emit({id:m.id,result:{}});
 if(m.method==='config/read') { configCwd=p.cwd; emit({id:m.id,result:{config:{mcp_servers:{agentschat:{command:'must-disable',tool_timeout_sec:null},filesystem:{command:'also-disable'}}}}}); }
 if(m.method==='thread/start'||m.method==='thread/resume') {
  const full=p.sandbox==='danger-full-access';
  const configOK=full ? p.config===undefined : p.config?.mcp_servers?.agentschat?.enabled===false && p.config?.mcp_servers?.filesystem?.enabled===false;
  const instructionsOK=typeof p.developerInstructions==='string' && (full
    ? p.developerInstructions.includes('all accepted messages') && !p.developerInstructions.includes('not local user authorization')
    : p.developerInstructions.includes('read-only'));
  if(configCwd!==p.cwd || !configOK || !instructionsOK || p.approvalPolicy!=='never' || !['danger-full-access','read-only'].includes(p.sandbox))
   return emit({id:m.id,error:{code:-32602,message:'unsafe'}});
  const id=p.threadId||'thread-'+(++next); permissions.set(id,full?'dangerFullAccess':'readOnly');
  emit({id:m.id,result:{thread:{id}}});
 }
 if(m.method==='turn/start') {
  if(!permissions.has(p.threadId)||p.approvalPolicy!=='never'||p.sandboxPolicy?.type!==permissions.get(p.threadId)) return emit({id:m.id,error:{code:-32602,message:'wrong turn permissions'}});
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

async function routingFixture(owner?: () => Promise<string | null>, seed: {
  permissions?: PermissionMode; threads?: Record<string, string>; entries?: any[];
} = {}) {
  const f = fixture();
  if (seed.permissions) f.c.permissions = seed.permissions;
  if (seed.threads || seed.entries) {
    mkdirSync(f.c.stateDir, {recursive:true});
    writeFileSync(join(f.c.stateDir, "state.json"), JSON.stringify({version:1,threads:seed.threads ?? {},entries:seed.entries ?? []}));
  }
  const app = server(); await app.start();
  const sent: {channel: string; text: string}[] = [];
  const bridge = new Bridge(f.c, app, async (channel, text) => { sent.push({channel,text}); }, () => {}, () => {}, owner);
  const state = () => JSON.parse(readFileSync(join(f.c.stateDir,"state.json"),"utf8"));
  const trace = () => app.request("test/trace", {}) as Promise<{method:string;params:any}[]>;
  const deliver = async (raw: any) => {
    expect(bridge.accept(raw)).toBe(true); await bridge.drain();
    expect(state().entries.find((entry: any) => entry.message.id === raw.id)?.status).toBe("sent");
  };
  return {...f,app,bridge,sent,state,trace,deliver,close:async()=>{await bridge.stop();app.close();}};
}

test("official JSON-RPC lifecycle correlates early events and returns only final output", async () => {
  const app = server();
  try { await app.start(); const id = await app.thread("/tmp"); expect(await app.generate(id, "hello")).toBe("Verified reply"); }
  finally { app.close(); }
});
test("migration refuses incomplete App Server history", async () => {
  const app = server(fakeAppServer.replace("id:'001',items:", "id:'001',itemsView:'notLoaded',items:"));
  try { await app.start(); await expect(app.readThread("old")).rejects.toThrow("incomplete"); }
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
  let bridge = ownedBridge(c, app, async (_ch, text) => { sent.push(text); }, () => {});
  try {
    expect(() => ownedBridge(c, app, async () => {})).toThrow("locked");
    expect(bridge.accept({ ...message(), content: `hi ${c.token}` })).toBe(true);
    expect(bridge.accept(message())).toBe(false);
    bridge.accept(message("m2", "dm-other")); await bridge.drain();
    expect(sent).toEqual(["Verified reply", "Verified reply"]);
    let state = JSON.parse(readFileSync(join(c.stateDir, "state.json"), "utf8"));
    expect(state.channels["dm-owner"].thread).toBeString();
    expect(state.channels["dm-owner"].thread).not.toBe(state.channels["dm-other"].thread);
    expect(JSON.stringify(state)).not.toContain(c.token);
    await bridge.stop();
    bridge = ownedBridge(c, app, async (_ch, text) => { sent.push(text); }, () => {});
    expect(bridge.accept(message())).toBe(false);
    bridge.accept(message("m3")); await bridge.drain();
    state = JSON.parse(readFileSync(join(c.stateDir, "state.json"), "utf8"));
    expect(state.entries.every((e: any) => e.status === "sent")).toBe(true);
  } finally { await bridge.stop(); app.close(); }
});
test("ambiguous delivery is persisted and never automatically resent on restart", async () => {
  const { c } = fixture(); const app = server(); await app.start(); let attempts = 0;
  let bridge = ownedBridge(c, app, async () => { attempts++; throw new Error("timeout after commit"); }, () => {});
  try {
    bridge.accept(message()); await bridge.drain(); await bridge.stop();
    bridge = ownedBridge(c, app, async () => { attempts++; }, () => {});
    await bridge.drain(); expect(attempts).toBe(1);
    expect(JSON.parse(readFileSync(join(c.stateDir, "state.json"), "utf8")).entries[0].status).toBe("uncertain");
  } finally { await bridge.stop(); app.close(); }
});
test("backend death pauses intake and preserves unstarted queued work", async () => {
  const { c } = fixture();
  const app = server(fakeAppServer.replace("const t='turn-'+(++next);", "process.exit(1); const t='turn-'+(++next);"));
  await app.start();
  const bridge = ownedBridge(c, app, async () => { throw new Error("must not send"); }, () => {});
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
  const bridge = ownedBridge(c, app, async () => { sends++; }, () => {});
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
  const generator = { thread: (cwd: string, existing?: string, ephemeral = false, permissions?: PermissionMode) => checked("thread", () => app.thread(cwd, existing, live || ephemeral, permissions)), generate: (id: string, text: string) => checked("generation", () => app.generate(id, text, live ? "low" : undefined)) };
  const bridge = ownedBridge(c, generator, (chat, text) => transport.send(chat, text), () => {});
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
    const bridge = ownedBridge(c, { thread: async()=>"t", generate: async()=>{if(failure==="generation")throw Error("generation failed");return "reply";} },
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
    const app = new AppServer("node", ["-e", fakeAppServer], 2000, mode);
    try {
      await app.start(); const id = await app.thread("/tmp");
      expect(await app.thread("/tmp", id)).toBe(id);
      expect(await app.generate(id, "test")).toBe("Verified reply");
      const trace = await app.request("test/trace", {});
      const requests = trace.filter((entry: any) => entry.method.startsWith("thread/"));
      expect(requests.map((entry: any) => entry.method)).toEqual(["thread/start", "thread/resume"]);
      for (const {params} of requests) {
        expect(params.approvalPolicy).toBe("never");
        expect(params.sandbox).toBe(mode === "full-access" ? "danger-full-access" : "read-only");
        if (mode === "full-access") {
          expect(params.config).toBeUndefined();
          expect(params.developerInstructions).toContain("all accepted messages");
          expect(params.developerInstructions).not.toContain("not local user authorization");
        } else expect(params.config).toEqual({mcp_servers:{agentschat:{enabled:false},filesystem:{enabled:false}}});
      }
      expect(trace.find((entry: any) => entry.method === "turn/start").params.sandboxPolicy.type).toBe(mode === "full-access" ? "dangerFullAccess" : "readOnly");
    } finally { app.close(); }
  }
});

test("per-bot effort applies to new and resumed turns without changing model or conversation", async () => {
  for (const effort of [undefined, "medium"] as const) {
    const app = new AppServer("node", ["-e", fakeAppServer], 2000, "full-access", undefined, effort);
    try {
      await app.start();
      const id = await app.thread("/tmp");
      await app.generate(id, "first");
      expect(await app.thread("/tmp", id)).toBe(id);
      await app.generate(id, "second");
      const turns = (await app.request("test/trace", {})).filter((e: any) => e.method === "turn/start");
      expect(turns).toHaveLength(2);
      for (const { params } of turns) {
        expect(params.threadId).toBe(id);
        expect(params.effort).toBe(effort);
        expect(params.model).toBeUndefined();
      }
    } finally { app.close(); }
  }
});

test("all accepted senders share one group thread and configured tools; replies stay in the group", async () => {
  let ownerChecks = 0;
  const f = await routingFixture(async () => {ownerChecks++; throw Error("unavailable");});
  try {
    for (const [index,sender] of ["owner","alice","bob","owner"].entries()) {
      await f.deliver({...message("group-"+index,"shared-group"),sender_id:sender,mentioned_ids:["project"], permissions:"read-only"});
    }
    const trace = await f.trace();
    expect(trace.filter(e=>e.method==="thread/start")).toHaveLength(1);
    const turns = trace.filter(e=>e.method==="turn/start");
    expect(new Set(turns.map(e=>e.params.threadId)).size).toBe(1);
    expect(turns.every(e=>e.params.sandboxPolicy.type==="dangerFullAccess")).toBe(true);
    expect(ownerChecks).toBe(0);
    expect(f.sent.map(r=>r.channel)).toEqual(Array(4).fill("shared-group"));
    const wire=JSON.parse(turns[0]!.params.input[0].text.split("AgentsChat message:\n")[1]);
    expect(wire.permissions).toBeUndefined();
  } finally {await f.close();}
});

test("queued group messages preserve arrival order and share context", async () => {
  const f=await routingFixture();
  try {
    for(const id of ["first","second","third"]) expect(f.bridge.accept({...message(id,"group"),sender_id:id,mentioned_ids:["project"]})).toBe(true);
    await f.bridge.drain();
    const turns=(await f.trace()).filter(e=>e.method==="turn/start");
    expect(turns.map(t=>JSON.parse(t.params.input[0].text.split("AgentsChat message:\n")[1]).id)).toEqual(["first","second","third"]);
    expect(new Set(turns.map(t=>t.params.threadId)).size).toBe(1);
  } finally {await f.close();}
});

test("explicit read-only configuration applies to everyone without splitting context", async () => {
  const f=await routingFixture(verifiedOwner,{permissions:"read-only"});
  try {
    await f.deliver(message());await f.deliver({...message("second"),sender_id:"another"});
    const trace=await f.trace();
    expect(trace.filter(e=>e.method==="thread/start")).toHaveLength(1);
    expect(trace.filter(e=>e.method==="turn/start").every(e=>e.params.sandboxPolicy.type==="readOnly")).toBe(true);
  } finally {await f.close();}
});

test("legacy group lanes migrate once, retain history and never import another channel", async () => {
  const original={group:"legacy",[legacyLane("group","full-access")]:"owner-history",[legacyLane("group","read-only","chat")]:"peer-history",[legacyLane("dm-private","full-access")]:"PRIVATE"};
  const f=await routingFixture(undefined,{threads:original});
  try {
    const channel=await f.bridge.prepareChannel("group");
    expect(channel.importedThreads).toEqual(["legacy","owner-history","peer-history"]);
    expect(channel.bootstrap).toContain("history from peer-history");
    expect(channel.bootstrap).not.toContain("PRIVATE");
    expect(f.state().threads).toEqual(original);
    await f.deliver({...message("new","group"),mentioned_ids:["project"]});
    await f.deliver({...message("next","group"),sender_id:"peer",mentioned_ids:["project"]});
    const turns=(await f.trace()).filter(e=>e.method==="turn/start");
    expect(turns[0]!.params.input[0].text).toContain("history from owner-history");
    expect(turns[1]!.params.input[0].text).not.toContain("history from owner-history");
    expect(turns.map(t=>t.params.threadId)).toEqual([channel.thread,channel.thread]);
    expect(f.state().channels.group.bootstrap).toBeUndefined();
  } finally {await f.close();}
});

test("restart resumes the canonical thread and keeps an unconsumed migration context", async () => {
  const f=await routingFixture(undefined,{threads:{group:"legacy"}});
  let restored:Bridge|undefined;
  try {
    const channel=await f.bridge.prepareChannel("group");await f.bridge.stop();
    restored=new Bridge(f.c,f.app,async()=>{},()=>{});
    expect(restored.accept({...message("after-restart","group"),mentioned_ids:["project"]})).toBe(true);await restored.drain();
    const trace=await f.trace();
    expect(trace.filter(e=>e.method==="thread/start")).toHaveLength(1);
    expect(trace.filter(e=>e.method==="thread/resume")[0]!.params.threadId).toBe(channel.thread);
    expect(trace.find(e=>e.method==="turn/start")!.params.input[0].text).toContain("history from legacy");
  } finally {await restored?.stop();await f.close();}
});

test("failed history loading never discards legacy mappings or silently starts blank", async () => {
  const f=fixture();mkdirSync(f.c.stateDir,{recursive:true});
  writeFileSync(join(f.c.stateDir,"state.json"),JSON.stringify({version:1,threads:{group:"old"},entries:[]}));
  let starts=0;
  const b=new Bridge(f.c,{thread:async()=>{starts++;return "new";},readThread:async()=>{throw Error("missing history");},generate:async()=>"never"},async()=>{});
  try {await expect(b.prepareChannel("group")).rejects.toThrow("missing history");expect(starts).toBe(0);expect(JSON.parse(readFileSync(join(f.c.stateDir,"state.json"),"utf8")).threads.group).toBe("old");}
  finally {await b.stop();}
});

test("one App Server preserves each thread policy and rejects cross-permission reuse before RPC", async () => {
  const app = new AppServer("node",["-e",fakeAppServer],2000,"read-only");
  try {
    await app.start();
    const full = await app.thread("/tmp",undefined,true,"full-access");
    const chat = await app.thread("/tmp",undefined,false,"read-only");
    for (const id of [full,chat,full]) expect(await app.generate(id,"test")).toBe("Verified reply");
    const beforeRejectedResumes = await app.request("test/trace", {});
    await expect(app.thread("/tmp",full,false,"read-only")).rejects.toThrow("Cannot change permissions of a loaded thread");
    await expect(app.thread("/tmp",chat,false,"full-access")).rejects.toThrow("Cannot change permissions of a loaded thread");
    expect(await app.request("test/trace", {})).toEqual(beforeRejectedResumes);
    // Rejected changes must not alter the permission map used by later turns.
    for (const id of [full,chat]) expect(await app.generate(id,"test")).toBe("Verified reply");
    expect(await app.thread("/tmp",full,false,"full-access")).toBe(full);
    for (const id of [full,chat]) expect(await app.generate(id,"test")).toBe("Verified reply");
    await expect(app.generate("unconfigured-thread","test")).rejects.toThrow("permissions have not been configured");
    const trace = await app.request("test/trace", {});
    const threads = trace.filter((event: any) => event.method.startsWith("thread/"));
    expect(threads.map((event: any) => event.params.sandbox)).toEqual(["danger-full-access","read-only","danger-full-access"]);
    expect(threads[0].params.ephemeral).toBe(true);
    expect(threads[2].method).toBe("thread/resume");
    expect(trace.filter((event: any) => event.method === "config/read").every((event: any) => event.params.cwd === "/tmp" && event.params.includeLayers === false)).toBe(true);
    const turns = trace.filter((event: any) => event.method === "turn/start");
    expect(turns.map((event: any) => event.params.threadId)).toEqual([full,chat,full,full,chat,full,chat]);
    expect(turns.map((event: any) => event.params.sandboxPolicy.type)).toEqual(["dangerFullAccess","readOnly","dangerFullAccess","dangerFullAccess","readOnly","dangerFullAccess","readOnly"]);
    expect(turns.every((event: any) => event.params.approvalPolicy === "never")).toBe(true);
  } finally { app.close(); }
});

test("writer contention retains queued messages and resumes the same task after release", async () => {
  const {c}=fixture(); mkdirSync(c.stateDir,{recursive:true});
  writeFileSync(join(c.stateDir,"state.json"),JSON.stringify({version:1,threads:{},channels:{"dm-owner":{thread:"existing-task"}},entries:[]}));
  let resumes=0; const used:string[]=[]; const sent:string[]=[];
  const bridge=new Bridge(c,{thread:async(_cwd,existing)=>{expect(existing).toBe("existing-task");if(++resumes===1)throw new ThreadBusyError();return existing!;},generate:async(id)=>{used.push(id);return "done";}},async(_chat,text)=>{sent.push(text);},()=>{});
  try{
    bridge.accept(message("wait-1")); await bridge.drain();
    expect(JSON.parse(readFileSync(join(c.stateDir,"state.json"),"utf8")).entries[0].status).toBe("pending");
    bridge.accept(message("wait-2"));await bridge.drain();expect(resumes).toBe(1);
    await new Promise(r=>setTimeout(r,5100));await bridge.drain();
    expect(used).toEqual(["existing-task","existing-task"]);expect(sent).toEqual(["done","done"]);expect(resumes).toBe(2);
  }finally{await bridge.stop();}
},10000);

test("App Server identifies writer contention without exposing raw backend error text", async()=>{
  const app=server(fakeAppServer.replace("const m=JSON.parse(line), p=m.params;", "const m=JSON.parse(line), p=m.params; if(m.method==='thread/resume')return emit({id:m.id,error:{code:-32600,message:'thread x already has an active writer'}});"));
  try{await app.start();await expect(app.thread("/tmp","existing-task")).rejects.toBeInstanceOf(ThreadBusyError);}finally{app.close();}
});


test("move desktop conversation into bot namespace once, retaining every source and restart mapping", async()=>{
 const f=fixture();mkdirSync(f.c.stateDir,{recursive:true});
 writeFileSync(join(f.c.stateDir,"state.json"),JSON.stringify({version:1,threads:{group:"legacy",other:"private"},channels:{group:{thread:"desktop-current"}},entries:[]}));
 const reads:string[]=[],resumes:(string|undefined)[]=[];let starts=0;
 const generator={namespace:join(f.c.stateDir,"codex-home"),
  readLegacyThread:async(id:string)=>{reads.push(id);return{id,turns:[{id,items:[{type:"agentMessage",text:"from "+id}]}]};},
  readThread:async()=>{throw Error("Must read original namespace");},
  thread:async(_cwd:string,existing?:string)=>{resumes.push(existing);if(!existing)starts++;return existing??"bot-private";},generate:async()=>"reply"};
 const b=new Bridge(f.c,generator,async()=>{});
 try{const c=await b.prepareChannel("group");expect(c.namespace).toBe(generator.namespace);expect(c.importedThreads).toEqual(["legacy","desktop-current"]);expect(c.bootstrap).toContain("from desktop-current");expect(reads).toEqual(["legacy","desktop-current"]);}finally{await b.stop();}
 const restarted=new Bridge(f.c,generator,async()=>{});
 try{expect((await restarted.prepareChannel("group")).thread).toBe("bot-private");expect(starts).toBe(1);expect(resumes).toEqual([undefined,"bot-private"]);}finally{await restarted.stop();}
 const wrong=new Bridge(f.c,{...generator,namespace:"another-home"},async()=>{});
 try{await expect(wrong.prepareChannel("group")).rejects.toThrow("different runtime home");expect(starts).toBe(1);}finally{await wrong.stop();}
});
test("namespace migration failure retains original current thread without creating a blank replacement",async()=>{
 const f=fixture();mkdirSync(f.c.stateDir,{recursive:true});writeFileSync(join(f.c.stateDir,"state.json"),JSON.stringify({version:1,threads:{},channels:{group:{thread:"original"}},entries:[]}));let starts=0;
 const b=new Bridge(f.c,{namespace:"private",readLegacyThread:async()=>{throw Error("source unavailable");},thread:async()=>{starts++;return "bad";},generate:async()=>""},async()=>{});
 try{await expect(b.prepareChannel("group")).rejects.toThrow("source unavailable");expect(starts).toBe(0);expect(JSON.parse(readFileSync(join(f.c.stateDir,"state.json"),"utf8")).channels.group.thread).toBe("original");}finally{await b.stop();}
});
