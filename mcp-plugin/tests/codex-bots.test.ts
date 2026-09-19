// Perspective: local bot operator managing several Codex-backed identities.
// Invariant: central identities ignore project settings; one bot survives bad registry edits.
// Goal: detect duplicate accounts and prevent orphan workers or app-server processes.
// Migration: legacy single-bot profiles remain supported; registry mode is explicit.
import { test, expect } from "bun:test";
import { realpathSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadBots } from "../codex/bots-config.ts";
import { parseProcesses, externalCodexPresent } from "../codex/processes.ts";
test("watcher excludes descendants and keeps multiple independent sessions active", () => {
 const own = parseProcesses("10 1 /opt/node\n11 10 /opt/node\n12 11 /app/codex");
 expect(externalCodexPresent(own,10)).toBe(false);
 expect(externalCodexPresent([...own,{pid:20,ppid:1,command:"/app/codex"}],10)).toBe(true);
 expect(externalCodexPresent(parseProcesses("20 1 /app/codex\n21 1 /app/codex"),10)).toBe(true);
});
test("central registry ignores project identity; workdir defaults and duplicate accounts validated", () => {
 const home=mkdtempSync(join(tmpdir(),"bots-"));
 try {
  const profiles=join(home,".agentschat/profiles"), cwd=join(home,"project");
  mkdirSync(profiles,{recursive:true}); mkdirSync(join(cwd,".agentschat"),{recursive:true});
  writeFileSync(join(cwd,".agentschat/config.json"),'{"profile":"missing"}');
  writeFileSync(join(profiles,"one.json"),JSON.stringify({agent_id:"test-bot",token:"ac_test_bot_token"}),{mode:0o600});
  const file=join(home,"bots.json");
  const write=(bots:any[],extra:any={})=>writeFileSync(file,JSON.stringify({version:1,default_workdir:cwd,bots,...extra}));
  write([{name:"one",profile:"one"},{name:"disabled",enabled:false}]);
  expect(loadBots(file,home).map(c=>[c.agentId,c.cwd])).toEqual([["test-bot",realpathSync(cwd)]]);
  write([{name:"one",profile:"one"},{name:"two",profile:"one",workdir:home}]);
  expect(()=>loadBots(file,home)).toThrow("Duplicate");
  write([{name:"one",profile:"../one"}]); expect(()=>loadBots(file,home)).toThrow("central profile");
  write([{name:"one",profile:"one"}],{default_workdir:undefined});
  expect(loadBots(file,home)[0]!.cwd).toBe(realpathSync(join(home,".agentschat/workspace")));
  write([{name:"one",profile:"one",enabled:"false"}]); expect(()=>loadBots(file,home)).toThrow("enabled");
 } finally {rmSync(home,{recursive:true,force:true});}
});

test("manager snapshot survives broken registry; parent death cleans workers", async () => {
 const { spawn } = await import("node:child_process");
 const { WebSocketServer } = await import("ws");
 const home=realpathSync(mkdtempSync(join(tmpdir(),"bots-lifecycle-")));
 const profiles=join(home,".agentschat/profiles"); mkdirSync(profiles,{recursive:true});
 const hub = Bun.serve({port:0,fetch:()=>Response.json({channels:[]})});
 const ws = new WebSocketServer({port:0}); await new Promise<void>(r=>ws.once("listening",r));
 ws.on("connection",socket=>socket.on("message",raw=>{if(JSON.parse(String(raw)).type==="auth")socket.send(JSON.stringify({type:"auth_ok"}));}));
 const fake=join(home,"fake-codex");
 writeFileSync(fake,`#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(join(home,'app.pid'))},String(process.pid));require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id)console.log(JSON.stringify({id:m.id,result:{}}));});`,{mode:0o700});
 writeFileSync(join(profiles,"one.json"),JSON.stringify({agent_id:"test-bot",token:"ac_test_bot_token"}),{mode:0o600});
 const file=join(home,"bots.json");
 writeFileSync(file,JSON.stringify({version:1,codex_bin:fake,bots:[{name:"one",profile:"one",api_url:`http://127.0.0.1:${hub.port}`,ws_url:`ws://127.0.0.1:${(ws.address() as any).port}`}]}));
 const manager=spawn("node",[resolve("src/cli.mjs"),"--codex-bots","--config",file],{env:{...process.env,HOME:home},stdio:"ignore"});
 let worker=0;
 const wait=async(fn:()=>boolean)=>{const end=Date.now()+15000;while(Date.now()<end){if(fn())return;await Bun.sleep(100);}throw Error("lifecycle timeout");};
 const status=()=>{try{return JSON.parse(readFileSync(join(home,".agentschat/codex-bots/status.json"),"utf8")).bots[0];}catch{return {};}};
 const dead=(pid:number)=>{try{process.kill(pid,0);return false;}catch{return true;}};
 try {
  await wait(()=>status().status==="connected"); worker=status().pid; expect(worker).toBeGreaterThan(0);
  const firstApp=Number(readFileSync(join(home,"app.pid"),"utf8"));
  writeFileSync(file,"{"); process.kill(worker,"SIGKILL");
  await wait(()=>status().status==="connected"&&status().pid!==worker); worker=status().pid;
  await wait(()=>dead(firstApp)); expect(dead(firstApp)).toBe(true);
  const secondApp=Number(readFileSync(join(home,"app.pid"),"utf8"));
  expect(status().status).toBe("connected"); manager.kill("SIGKILL");
  await wait(()=>dead(worker)); expect(dead(worker)).toBe(true); await wait(()=>dead(secondApp)); expect(dead(secondApp)).toBe(true);
 } finally {manager.kill("SIGKILL");if(worker&&!dead(worker))process.kill(worker,"SIGKILL"); for(const c of ws.clients)c.terminate();ws.close();hub.stop(true);rmSync(home,{recursive:true,force:true});}
},40000);
