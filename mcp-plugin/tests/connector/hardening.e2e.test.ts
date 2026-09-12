import { afterEach, expect, test } from "bun:test";
import WebSocket from "ws";
import { makeUpgradeToken } from "../../connector/auth.ts";
import { startConnector, type AgentsChatHooks } from "../../connector/server.ts";
import type { Identity } from "../../connector/identities.ts";

const a: Identity = { botId: "agent-a", agentId: "agent-a", token: "ac_a", gatewayId: "gw-a", secret: "secret-a" };
const b: Identity = { botId: "agent-b", agentId: "agent-b", token: "ac_b", gatewayId: "gw-b", secret: "secret-b" };
const cleanup: Array<() => void> = [];
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop(); });
const settle = () => new Promise(r => setTimeout(r, 30));
function setup(identities = [a, b], extra: Partial<AgentsChatHooks> = {}) {
  const calls: any[] = [];
  const secrets: Record<string, string[]> = {};
  for (const id of identities) (secrets[id.gatewayId] ??= []).push(id.secret);
  const server = startConnector({ port: 0, identities, secrets, agentschat: {
    async sendMessage(botId: string, chatId: string, content: string) { calls.push({ botId, chatId, content }); return { id: content }; },
    async sendTyping(botId, chatId) { calls.push({ botId, chatId, op: "typing" }); },
    async getChatInfo(botId, chatId) { calls.push({ botId, chatId, op: "get_chat_info" }); return { name: botId }; },
    ...extra,
  } });
  cleanup.push(() => server.stop());
  async function dial(id = a) {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/relay`, { headers: { Authorization: `Bearer ${makeUpgradeToken(id.gatewayId, id.secret, 0)}` } });
    cleanup.push(() => ws.terminate());
    const frames: any[] = [];
    ws.on("message", d => { for (const line of d.toString().trim().split("\n")) frames.push(JSON.parse(line)); });
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    async function request(frame: any) {
      const before = frames.length;
      ws.send(JSON.stringify(frame) + "\n");
      for (let n = 0; n < 100; n++) { if (frames.length > before) return frames[before]; await new Promise(r => setTimeout(r, 5)); }
      throw new Error("timed out waiting for frame " + JSON.stringify(frame));
    }
    return { ws, frames, request, hello: (botId = id.botId, platform = "agentschat") => request({ type: "hello", platform, botId }) };
  }
  return { server, calls, dial };
}
const outbound = (botId?: string, op = "send", content = "reply") => ({ type: "outbound", requestId: content, platform: "agentschat", ...(botId === undefined ? {} : { botId }), action: { op, chat_id: "same-chat", content } });
const message = (id: string, content: string, extra = {}) => ({ id, channel_id: "same-chat", sender_id: "human", content, ...extra });

test("single-identity DM compatibility never overrides an explicit unknown owner", async () => {
  const { server, dial } = setup([a]);
  const client = await dial(); await client.hello();
  for (const owner of [{ __botId: b.botId }, { dm_owner: b.botId }]) {
    await server.injectAgentsChatMessage(message(JSON.stringify(owner), "private", { channel_id: "dm-private", ...owner }));
  }
  await settle();
  expect(client.frames.filter(f => f.type === "inbound")).toEqual([]);
  await server.injectAgentsChatMessage(message("legacy-dm", "private", { channel_id: "dm-private" }));
  await settle();
  expect(client.frames.filter(f => f.type === "inbound").map(f => f.event.message_id)).toEqual(["legacy-dm"]);
});

test("shared repeated-hello clients must tag concurrent replies explicitly", async () => {
  const sharedB = { ...b, gatewayId: a.gatewayId, secret: a.secret };
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const completed: string[] = [];
  const { server, dial } = setup([a, sharedB], { async sendMessage(botId) {
    if (botId === a.botId) await gate;
    completed.push(botId); return { id: botId };
  } });
  cleanup.push(release);
  const client = await dial();
  expect((await client.hello(a.botId)).type).toBe("descriptor");
  expect((await client.hello(b.botId)).type).toBe("descriptor");
  await server.injectAgentsChatMessage(message("shared-multi", "@agent-a @agent-b"));
  await settle();
  expect(client.frames.filter(f => f.type === "inbound").map(f => f.event.source.profile).sort()).toEqual([a.botId, b.botId]);
  expect((await client.request(outbound())).result.success).toBe(false);
  client.ws.send(JSON.stringify(outbound(a.botId, "send", "slow-a")));
  client.ws.send(JSON.stringify(outbound(b.botId, "send", "fast-b")));
  await settle();
  expect(completed).toEqual([b.botId]);
  release(); await settle();
  expect(client.frames.filter(f => ["fast-b", "slow-a"].includes(f.requestId)).map(f => [f.requestId, f.result.message_id])).toEqual([["fast-b", b.botId], ["slow-a", a.botId]]);
});

test("concurrent mention context windows advance in arrival order per identity and chat", async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const contexts: any[] = [];
  const { server, dial } = setup([a], { async getChannelContext(botId, chatId, since, exclude) {
    contexts.push({ since, exclude });
    if (exclude === "first") await gate;
    return [];
  } });
  cleanup.push(release);
  const client = await dial(); await client.hello();
  const first = server.injectAgentsChatMessage(message("first", "@agent-a", { timestamp: "2026-09-01T00:00:01Z" }));
  const second = server.injectAgentsChatMessage(message("second", "@agent-a", { timestamp: "2026-09-01T00:00:02Z" }));
  await settle();
  expect(contexts).toEqual([{ since: undefined, exclude: "first" }]);
  release(); await Promise.all([first, second]); await settle();
  expect(contexts).toEqual([{ since: undefined, exclude: "first" }, { since: "2026-09-01T00:00:01Z", exclude: "second" }]);
  expect(client.frames.filter(f => f.type === "inbound").map(f => f.event.message_id)).toEqual(["first", "second"]);
  await server.injectAgentsChatMessage(message("older-backfill", "@agent-a", { timestamp: "2026-09-01T00:00:00Z" }));
  await server.injectAgentsChatMessage(message("after-backfill", "@agent-a", { timestamp: "2026-09-01T00:00:03Z" }));
  expect(contexts.at(-1).since).toBe("2026-09-01T00:00:02Z");
});

test("display-name text cannot impersonate a different exact mention target", async () => {
  const { server, dial } = setup();
  const ca = await dial(a), cb = await dial(b);
  await ca.hello(); await cb.hello();
  await server.injectAgentsChatMessage(message("display", "@agent-a(agent-b)"));
  await server.injectAgentsChatMessage(message("cross-text", "@someone unrelated text (agent-a)"));
  await settle();
  expect(ca.frames.filter(f => f.type === "inbound")).toEqual([]);
  expect(cb.frames.filter(f => f.type === "inbound").map(f => f.event.message_id)).toEqual(["display"]);
});

test("overlapping gateway reconnects do not duplicate one target delivery", async () => {
  const { server, dial } = setup([a]);
  const first = await dial(), second = await dial();
  await first.hello(); await second.hello();
  await server.injectAgentsChatMessage(message("overlap", "@agent-a hi"));
  await settle();
  expect([first, second].flatMap(c => c.frames.filter(f => f.type === "inbound"))).toHaveLength(1);
});

test("explicit malformed outbound identities are not treated as missing", async () => {
  const { dial, calls } = setup([a]);
  const client = await dial(); await client.hello();
  for (const botId of ["", null, 7, {}, "unknown"]) {
    expect((await client.request({ ...outbound(), botId })).result.success).toBe(false);
  }
  expect(calls).toEqual([]);
});

test("mirrored concurrent platform events dedupe per message and target", async () => {
  const { server, dial } = setup([a, b], { async getChannelContext() { await settle(); return []; } });
  const ca = await dial(a), cb = await dial(b);
  await ca.hello(); await cb.hello();
  await Promise.all([a, b].map(id => server.injectAgentsChatMessage(message("mirrored", "@agent-a @agent-b", { __botId: id.botId }))));
  await settle();
  for (const c of [ca, cb]) expect(c.frames.filter(f => f.type === "inbound").map(f => f.event.message_id)).toEqual(["mirrored"]);
  // Missing receiver does not consume that target's delivery key.
  const next = { ...b, botId: "agent-c", agentId: "agent-c" };
  server.reloadIdentities([a, b, next]);
  await server.injectAgentsChatMessage(message("late", "@agent-a @agent-c"));
  const cc = await dial(next); await cc.hello();
  await server.injectAgentsChatMessage(message("late", "@agent-a @agent-c"));
  await settle();
  expect(cc.frames.filter(f => f.type === "inbound").map(f => f.event.message_id)).toEqual(["late"]);
  expect(ca.frames.filter(f => f.type === "inbound").map(f => f.event.message_id)).toEqual(["mirrored", "late"]);
});

test("one exact multi-mention reaches each target on separate authenticated gateways", async () => {
  const { server, dial } = setup();
  const ca = await dial(a), cb = await dial(b);
  await ca.hello(); await cb.hello();
  await server.injectAgentsChatMessage(message("multi", "@agent-a and @Bee(agent-b) and @agent-a"));
  await settle();
  expect(ca.frames.filter(f => f.type === "inbound").map(f => f.event.message_id)).toEqual(["multi"]);
  expect(cb.frames.filter(f => f.type === "inbound").map(f => f.event.message_id)).toEqual(["multi"]);
  await server.injectAgentsChatMessage(message("not-exact", "@agent-a-suffix @agent-b-suffix (agent-a)"));
  await settle();
  expect(ca.frames.filter(f => f.type === "inbound")).toHaveLength(1);
  expect(cb.frames.filter(f => f.type === "inbound")).toHaveLength(1);
});

test("reload revokes old credentials even while inbound context is in flight", async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const { server, dial, calls } = setup([a], { async getChannelContext() { entered(); await gate; return []; } });
  cleanup.push(release);
  const client = await dial(); await client.hello();
  const pending = server.injectAgentsChatMessage(message("revoked", "@agent-a hi"));
  await started;
  server.reloadIdentities([{ ...a, secret: "rotated" }]);
  release(); await pending; await settle();
  expect(client.frames.filter(f => f.type === "inbound")).toEqual([]);
  expect((await client.request(outbound(a.botId))).result.success).toBe(false);
  expect((await client.hello()).type).toBe("error");
  expect(calls).toEqual([]);
  const fresh = await dial({ ...a, secret: "rotated" });
  expect((await fresh.hello()).type).toBe("descriptor");
});

test("reverse-order concurrent replies keep explicit identity despite interleaved same-chat inbound", async () => {
  let finishA!: () => void;
  let startedA!: () => void;
  const aStarted = new Promise<void>(r => { startedA = r; });
  const aRelease = new Promise<void>(r => { finishA = r; });
  const completed: string[] = [];
  const { server, dial } = setup([a, b], { async sendMessage(botId) {
    if (botId === a.botId) { startedA(); await aRelease; }
    completed.push(botId); return { id: botId };
  } });
  cleanup.push(finishA);
  const ca = await dial(a), cb = await dial(b);
  await ca.hello(); await cb.hello();
  await server.injectAgentsChatMessage(message("a-first", "@agent-a hi"));
  await server.injectAgentsChatMessage(message("b-second", "@agent-b hi"));
  await settle();
  const replyA = ca.request(outbound(a.botId, "send", "a-reply"));
  const replyB = cb.request(outbound(b.botId, "send", "b-reply"));
  expect((await replyB).result.message_id).toBe(b.botId);
  // A must be in flight, not incorrectly completed using B's sticky credentials.
  await Promise.race([aStarted, settle()]);
  expect(completed).toEqual([b.botId]);
  finishA();
  expect((await replyA).result.message_id).toBe(a.botId);
  expect(completed).toEqual([b.botId, a.botId]);
});

test("outbound requires an authorized hello on this connection for every operation", async () => {
  const { dial, calls } = setup();
  const client = await dial();
  expect((await client.request(outbound(a.botId))).result.success).toBe(false);
  await client.hello();
  for (const op of ["send", "typing", "get_chat_info"]) {
    expect((await client.request(outbound(b.botId, op))).result.success).toBe(false);
    expect((await client.request({ ...outbound(a.botId, op), platform: "other" })).result.success).toBe(false);
  }
  expect(calls).toEqual([]);
  expect((await client.request(outbound())).result.success).toBe(true);
  expect(calls).toEqual([{ botId: a.botId, chatId: "same-chat", content: "reply" }]);
});

test("configured single identity rejects unknown botId and wrong platform", async () => {
  const { dial } = setup([a]);
  // A rejected handshake now closes the connection; each attempt must redial.
  expect((await (await dial()).hello("unknown")).type).toBe("error");
  expect((await (await dial()).hello(a.botId, "other")).type).toBe("error");
  expect((await (await dial()).request({ type: "hello", platform: "agentschat" })).type).toBe("error");
  expect((await (await dial()).hello()).type).toBe("descriptor");
});

test("hello is bound to BOTH authenticated gateway and signing secret", async () => {
  const c = { ...b, botId: "agent-c", agentId: "agent-c", gatewayId: a.gatewayId };
  const { dial } = setup([a, b, c]);
  expect((await (await dial()).hello(b.botId)).type).toBe("error");
  expect((await (await dial()).hello(c.botId)).type).toBe("error");
  expect((await (await dial()).hello()).type).toBe("descriptor");
});
