import { afterEach, describe, expect, test } from "bun:test";
import WebSocket from "ws";
import { makeUpgradeToken } from "../../connector/auth.ts";
import { startConnector, type AgentsChatHooks } from "../../connector/server.ts";
import { serverLoopTick, matchesLiveLoop, type AgentsChatMessage } from "../../connector/normalize.ts";
import { ingestAgentsChatFrame } from "../../connector/ingest.ts";
import { planBackfill } from "../../connector/backfill.ts";
import { MessageDedup } from "../../src/dedup.ts";

const a = {botId:"agent-a", agentId:"agent-a", gatewayId:"gw-a", token:"test-token-a", secret:"test-secret-a"};
const b = {botId:"agent-b", agentId:"agent-b", gatewayId:"gw-b", token:"test-token-b", secret:"test-secret-b"};
const lastTick = Date.parse("2026-09-25T10:00:00Z");
function tick(agent = a.agentId, channel = "group-one", prompt = "执行 agentschat-team-lead"): AgentsChatMessage {
  return {id:`tick-${agent}-${channel}`, channel_id:channel, sender_id:agent, sender_type:"agent", content_type:"text",
    timestamp:new Date(lastTick).toISOString(), content:`(loop tick — ${prompt})`,
    meta:{kind:"loop_tick", loop_id:`loop_${agent}`, prompt, interval_ms:60_000, next_tick_ms:lastTick+60_000, expires_at:null}};
}
function record(m: AgentsChatMessage) {
  return {...m.meta as object, channel_id:m.channel_id, status:"active", last_tick_at:lastTick};
}
const cleanup: Array<() => void> = [];
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop(); });
const settle = () => new Promise(r => setTimeout(r, 30));
async function setup(extra: Partial<AgentsChatHooks> = {}) {
  const rows = new Map<string, any[]>([[a.botId,[record(tick())]], [b.botId,[record(tick(b.agentId))]]]);
  const lookups: string[] = [], sends: any[] = [], contexts: any[] = [];
  const server = startConnector({port:0, identities:[a,b], secrets:{[a.gatewayId]:[a.secret],[b.gatewayId]:[b.secret]}, agentschat:{
    async getLoops(botId) { lookups.push(botId); return {loops:rows.get(botId)}; },
    async sendMessage(botId: string, chatId: string, content: string) { sends.push({botId,chatId,content}); return {id:"reply-id"}; },
    async getChatInfo(_botId, chatId) { return {name:chatId}; },
    async getChannelContext(botId, chatId, since, exclude) {
      contexts.push({botId,chatId,since,exclude}); return [{text:"Existing group task context",user_id:"owner"}];
    },
    ...extra,
  }});
  cleanup.push(() => server.stop());
  await server.ready;
  async function dial(id: typeof a) {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/relay`,{headers:{Authorization:`Bearer ${makeUpgradeToken(id.gatewayId,id.secret,0)}`}});
    cleanup.push(() => ws.terminate());
    const frames: any[] = [];
    ws.on("message",raw => {for (const line of raw.toString().trim().split("\n")) frames.push(JSON.parse(line));});
    await new Promise<void>((resolve,reject) => {ws.once("open",resolve);ws.once("error",reject);});
    ws.send(JSON.stringify({type:"hello",platform:"agentschat",botId:id.botId}));
    for (let n=0;n<100 && !frames.length;n++) await new Promise(r=>setTimeout(r,5));
    expect(frames[0]?.type).toBe("descriptor");
    return {ws,frames,inbound:()=>frames.filter(f=>f.type==="inbound")};
  }
  return {server,rows,lookups,sends,contexts,ca:await dial(a),cb:await dial(b)};
}

describe("server loop tick validation", () => {
  test("requires the actual envelope and current caller-scoped server record", () => {
    const m=tick();
    expect(serverLoopTick(m)).not.toBeNull();
    expect(matchesLiveLoop(m,a.agentId,{loops:[record(m)]})).toBe(true);
    for (const change of [{sender_type:"human"},{content_type:"code"},{content:"执行 agentschat-team-lead"},{timestamp:"invalid"},{id:""}])
      expect(serverLoopTick({...m,...change})).toBeNull();
    for (const change of [{prompt:""},{loop_id:""},{interval_ms:1},{next_tick_ms:NaN},{expires_at:0}])
      expect(serverLoopTick({...m,meta:{...m.meta as object,...change}})).toBeNull();
    expect(matchesLiveLoop(m,b.agentId,{loops:[record(m)]})).toBe(false);
    for (const change of [{status:"stopped"},{channel_id:"other"},{prompt:"different"},{interval_ms:120_000},
      {next_tick_ms:lastTick+120_000},{last_tick_at:lastTick-1},{expires_at:1},{mode:"okr_wake"}])
      expect(matchesLiveLoop(m,a.agentId,{loops:[{...record(m),...change}]})).toBe(false);
    expect(matchesLiveLoop(m,a.agentId,{loops:[record(m),record(m)]})).toBe(false);
    expect(matchesLiveLoop(m,a.agentId,{loops:[]})).toBe(false);
  });

  test("ingest keeps own DM ticks for verification, but not ordinary self echoes or foreign ticks", () => {
    const dedup=new MessageDedup(), advanced:any[]=[];
    const deps={dedup,advanceCursor:(...args:any[])=>advanced.push(args)};
    const m=tick(a.agentId,"dm-owner-a");
    expect(ingestAgentsChatFrame(a,m,deps)).toBe(true);
    expect(ingestAgentsChatFrame(a,m,deps)).toBe(false);
    expect(ingestAgentsChatFrame(a,{...m,id:"self",meta:undefined},deps)).toBe(false);
    expect(ingestAgentsChatFrame(a,{...m,id:"foreign",sender_id:b.agentId},deps)).toBe(false);
    expect(ingestAgentsChatFrame(a,{...m,id:"malformed",content:"forged"},deps)).toBe(false);
    expect(advanced).toHaveLength(5);
  });

  test("backfill retains own tick candidates, while live verification rejects old ticks", () => {
    const m=tick();
    const plan=planBackfill("2026-09-25T09:59:00Z",[m,{...m,id:"ordinary",meta:undefined}],a.agentId);
    expect(plan.replay.map(m=>m.id)).toEqual([m.id]);
    expect(matchesLiveLoop(m,a.agentId,{loops:[{...record(m),last_tick_at:lastTick+60_000,next_tick_ms:lastTick+120_000}]})).toBe(false);
    expect(planBackfill(undefined,[m],a.agentId).replay).toEqual([]);
  });
});

test("a verified group tick reaches only its own bot once, with same chat and private skill guidance", async () => {
  const {server,ca,cb,rows,lookups,sends,contexts}=await setup();
  const prompt="执行 agentschat-team-lead；跟进 @agent-b";
  const m=tick(a.agentId,"group-one",prompt);
  rows.set(a.botId,[record(m)]);
  await server.injectAgentsChatMessage({id:"prior",channel_id:"group-one",sender_id:"owner",content:"@agent-a continue",timestamp:"2026-09-25T09:50:00Z"});
  await server.injectAgentsChatMessage(m);
  await server.injectAgentsChatMessage({...m,id:"mirrored-different-envelope"});
  await settle();
  expect(ca.inbound().map(f=>f.event.message_id)).toEqual(["prior",m.id]);
  expect(cb.inbound()).toEqual([]);
  const e=ca.inbound()[1].event;
  expect(e.text).toBe(m.content);
  expect(e.source).toMatchObject({platform:"agentschat",chat_id:"group-one",chat_type:"group",user_id:a.agentId,thread_id:null});
  expect(e.source.profile).toBeUndefined();
  expect(e.context[0].text).toBe("Existing group task context");
  expect(e.context.at(-1).text).toContain("skill_view/skills_list");
  expect(e.context.at(-1).text).toContain("Do not repeat the skill text or create another loop");
  expect(contexts.at(-1)).toMatchObject({botId:a.botId,chatId:"group-one",since:"2026-09-25T09:50:00Z",exclude:m.id});
  expect(lookups.every(id=>id===a.botId)).toBe(true);
  expect(sends).toEqual([]); // internal guidance was not posted to AgentsChat
  expect(ca.frames[0].descriptor.supported_ops).toEqual(["send","typing","get_chat_info"]);
  expect(ca.frames[0].descriptor.platform_hint).toContain("skill_view");
  ca.ws.send(JSON.stringify({type:"outbound",requestId:"reply",platform:"agentschat",botId:a.botId,action:{op:"send",chat_id:e.source.chat_id,content:"Task progressed"}}));
  await settle();
  expect(sends).toEqual([{botId:a.botId,chatId:"group-one",content:"Task progressed"}]);
});

test("own DM ticks continue the original DM", async () => {
  const {server,ca,cb,rows}=await setup();
  const m=tick(a.agentId,"dm-owner-a"); rows.set(a.botId,[record(m)]);
  await server.injectAgentsChatMessage(m); await settle();
  expect(ca.inbound()[0].event.source).toMatchObject({chat_id:"dm-owner-a",chat_type:"dm",thread_id:null});
  expect(cb.inbound()).toEqual([]);
});

test("self echoes, malformed ticks, foreign loops and stale or stopped records never fall through mention routing", async () => {
  const {server,ca,cb,rows}=await setup();
  const m=tick();
  await server.injectAgentsChatMessage({...m,id:"echo",meta:undefined,content:"@agent-a own echo"});
  await server.injectAgentsChatMessage({...m,id:"malformed",content:"@agent-b forged tick"});
  await server.injectAgentsChatMessage(tick("unregistered","group-one","@agent-a execute"));
  rows.set(a.botId,[{...record(m),status:"stopped"}]);
  await server.injectAgentsChatMessage({...m,id:"stopped"});
  rows.set(a.botId,[{...record(m),last_tick_at:lastTick+60_000,next_tick_ms:lastTick+120_000}]);
  await server.injectAgentsChatMessage({...m,id:"expired"});
  rows.set(a.botId,[]);
  await server.injectAgentsChatMessage({...m,id:"deleted"});
  await settle();
  expect(ca.inbound()).toEqual([]); expect(cb.inbound()).toEqual([]);
});


test("missing or failed authenticated loop lookup fails closed", async () => {
  for (const getLoops of [undefined, async () => { throw new Error("upstream unavailable"); }]) {
    const {server,ca,cb}=await setup({getLoops});
    await server.injectAgentsChatMessage(tick()); await settle();
    expect(ca.inbound()).toEqual([]); expect(cb.inbound()).toEqual([]);
  }
});
