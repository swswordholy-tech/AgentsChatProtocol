/** Perspective: owners scheduling privileged tasks.
 * Invariant: an exact private grant AND live owner/loop verification are required.
 * Goal: reject spoofing, revocation, replay and history crossover.
 * Migration: keep with bridge; stub only external hub/model boundaries.
 */
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Bridge, addressed, type Generator } from "../codex/bridge.ts";
import { verifyLoopTick } from "../codex/loop-grants.ts";
import type { BridgeConfig } from "../codex/config.ts";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
function fixture(channel = "dm-owner") {
  const stateDir = mkdtempSync(join(tmpdir(), "loop-grant-")); dirs.push(stateDir);
  const c: BridgeConfig = { stateDir, agentId: "bot", cwd: stateDir, permissions: "full-access", token: "test-token", profileFile: "unused", source: "test", apiUrl: "https://example.com", wsUrl: "wss://example.com/ws", channels: [], senders: [], codexBin: "unused" };
  const grant = { loop_id: "loop-one", channel_id: channel, agent_id: "bot", owner_id: "owner", interval_ms: 1800000, prompt: "Review assigned work." };
  const file = join(stateDir, "loop-grants.json");
  const save = (grants = [grant]) => writeFileSync(file, JSON.stringify({ version: 1, grants }), { mode: 0o600 }); save();
  const tick = { id: "tick1", channel_id: channel, sender_id: "bot", content: "UNTRUSTED WIRE CONTENT", meta: { kind: "loop_tick" as const, loop_id: "loop-one", interval_ms: 1800000, next_tick_ms: 2800000, prompt: "Review assigned work." } };
  const row = { ...grant, status: "active", expires_at: null, last_tick_at: 1000000, next_tick_ms: 2800000 };
  return { c, grant, tick, row, file, save };
}
test("self ticks require exact private local grant; slash echoes ignored", () => {
  const { c, tick, save, grant, file } = fixture(); expect(addressed(tick, c)).toBe(true);
  for (const change of [{ sender_id: "stranger" }, { channel_id: "dm-other" }, { meta: { ...tick.meta, prompt: "Run something else" } }, { meta: { ...tick.meta, interval_ms: 60000 } }, { meta: { ...tick.meta, next_tick_ms: 0 } }]) expect(addressed({ ...tick, ...change }, c)).toBe(false);
  c.channels = ["another"]; expect(addressed(tick, c)).toBe(false); c.channels = [];
  c.senders = ["another"]; expect(addressed(tick, c)).toBe(false); c.senders = [];
  save([grant, grant]); expect(addressed(tick, c)).toBe(false);
  save(); chmodSync(file, 0o644); expect(addressed(tick, c)).toBe(false);
  chmodSync(file, 0o600); rmSync(file); expect(addressed(tick, c)).toBe(false);
  const target = join(c.stateDir, "target"); writeFileSync(target, JSON.stringify({ version: 1, grants: [grant] }), { mode: 0o600 }); symlinkSync(target, file); expect(addressed(tick, c)).toBe(false);
  for (const kind of ["slash_input", "loop_status", "slash_response"]) expect(addressed({ ...tick, sender_id: "owner", meta: { kind } }, c)).toBe(false);
});
test("live check rejects owner changes, inactive/mismatched loops, failed lookup and concurrent local revocation", async () => {
  const { c, tick, row, save } = fixture(); expect(await verifyLoopTick(tick, c, "owner", async () => ({ loops: [row] }))).not.toBeNull();
  for (const owner of [null, "new-owner"]) expect(await verifyLoopTick(tick, c, owner, async () => ({ loops: [row] }))).toBeNull();
  for (const change of [{ status: "cancelled" }, { channel_id: "dm-other" }, { prompt: "Changed" }, { interval_ms: 60000 }, { expires_at: 9999999 }, { mode: "wake" }, { last_tick_at: null }, { next_tick_ms: 4600000 }]) expect(await verifyLoopTick(tick, c, "owner", async () => ({ loops: [{ ...row, ...change }] }))).toBeNull();
  expect(await verifyLoopTick(tick, c, "owner", async () => { throw Error("offline"); })).toBeNull();
  expect(await verifyLoopTick(tick, c, "owner", async () => ({ loops: [row, row] }))).toBeNull();
  c.permissions = "read-only"; expect(await verifyLoopTick(tick, c, "owner", async () => ({ loops: [row] }))).toBeNull(); c.permissions = "full-access";
  expect(await verifyLoopTick(tick, c, "owner", async () => { save([]); return { loops: [row] }; })).toBeNull();
});
test("bridge delivers fixed authorized task in the shared DM thread and deduplicates tick across restart", async () => {
  const { c, tick, row } = fixture(); const runs: { thread: string; prompt: string }[] = [], modes: string[] = [], sent: string[] = [];
  const model: Generator = { thread: async (_c, existing, _e, mode) => { modes.push(mode!); return existing ?? `thread-${modes.length}`; }, generate: async (thread, prompt) => { runs.push({ thread, prompt }); return "done"; } };
  let bridge = new Bridge(c, model, async (_ch, text) => { sent.push(text); }, () => {}, undefined, async () => "owner", async () => ({ loops: [row] }));
  try {
    expect(bridge.accept({ id: "owner1", channel_id: "dm-owner", sender_id: "owner", content: "owner message", meta: { kind: "ordinary" } })).toBe(true); await bridge.drain();
    expect(bridge.accept(tick)).toBe(true); expect(bridge.accept({ ...tick, id: "duplicate" })).toBe(false); await bridge.drain();
    expect(sent).toEqual(["done", "done"]); expect(modes).toEqual(["full-access"]);
    expect(runs[0]!.prompt).toContain("owner message"); expect(runs[0]!.prompt).toContain(join(c.stateDir, "loop-grants.json")); expect(runs[0]!.prompt).toContain("preserve other grants"); expect(runs[1]!.prompt).toContain("Review assigned work."); expect(runs[1]!.prompt).not.toContain("UNTRUSTED WIRE CONTENT"); expect(runs[0]!.thread).toBe(runs[1]!.thread);
    await bridge.stop(); bridge = new Bridge(c, model, async () => {}, () => {}, undefined, async () => "owner", async () => ({ loops: [row] }));
    expect(bridge.accept({ ...tick, id: "replay" })).toBe(false);
    expect(JSON.parse(readFileSync(join(c.stateDir, "state.json"), "utf8")).entries.map((e: any) => e.status)).toEqual(["sent", "sent"]);
  } finally { await bridge.stop(); }
});
test("bridge rechecks owner on each tick and blocks revoked work before generation", async () => {
  const { c, tick, row } = fixture(); let calls = 0, owner = "owner";
  const model: Generator = { thread: async () => "t", generate: async () => { calls++; return "done"; } };
  const bridge = new Bridge(c, model, async () => {}, () => {}, undefined, async () => owner, async () => ({ loops: [row] }));
  try {
    bridge.accept(tick); await bridge.drain(); expect(calls).toBe(1);
    owner = "replacement"; row.last_tick_at = 2800000; row.next_tick_ms = 4600000;
    bridge.accept({ ...tick, id: "tick2", meta: { ...tick.meta, next_tick_ms: 4600000 } }); await bridge.drain(); expect(calls).toBe(1);
    expect(JSON.parse(readFileSync(join(c.stateDir, "state.json"), "utf8")).entries[1].status).toBe("blocked");
  } finally { await bridge.stop(); }
});

test("group loop and group mentions resume the same conversation and reply only to that group", async () => {
  const {c,tick,row} = fixture("original-group"); const runs: string[] = [], deliveries: string[] = [];
  const model: Generator = {thread:async(_cwd,existing)=>existing??"group-thread",generate:async(thread,prompt)=>{runs.push(thread); return "group update";}};
  const bridge=new Bridge(c,model,async(channel)=>{deliveries.push(channel);},()=>{},undefined,async()=>"owner",async()=>({loops:[row]}));
  try {
    expect(bridge.accept({id:"group-request",channel_id:"original-group",sender_id:"member",content:"@bot follow this task",mentioned_ids:["bot"]})).toBe(true);
    await bridge.drain(); expect(bridge.accept(tick)).toBe(true); await bridge.drain();
    expect(runs).toEqual(["group-thread","group-thread"]);
    expect(deliveries).toEqual(["original-group","original-group"]);
    expect(addressed({...tick,id:"wrong-channel",channel_id:"dm-owner"},c)).toBe(false);
  } finally {await bridge.stop();}
});
