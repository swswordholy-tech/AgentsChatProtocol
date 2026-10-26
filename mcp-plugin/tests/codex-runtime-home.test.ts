/** Bot persistence must not share the desktop database or writer-lock namespace. */
import {test,expect,afterEach} from "bun:test";
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,readlinkSync,existsSync,statSync,rmSync,symlinkSync,realpathSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {prepareRuntimeHome} from "../codex/runtime-home.ts";
import {AppServer} from "../codex/app-server.ts";
const roots:string[]=[];
afterEach(()=>{for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),"bot-home-"));roots.push(root);const source=join(root,"desktop");mkdirSync(source);return {root,source};}
test("reuse login/config but never desktop session storage, repeatably",()=>{
 const {root,source}=fixture();for(const name of ["auth.json","config.toml","state_5.sqlite"])writeFileSync(join(source,name),"test");
 for(const name of ["sessions","thread-writer-locks","plugins"])mkdirSync(join(source,name));
 const runtime=prepareRuntimeHome(join(root,"bot"),source);
 expect(readlinkSync(join(runtime.home,"auth.json"))).toBe(join(realpathSync(source),"auth.json"));
 expect(readlinkSync(join(runtime.home,"plugins"))).toBe(join(realpathSync(source),"plugins"));
 for(const name of ["state_5.sqlite","sessions","thread-writer-locks"])expect(existsSync(join(runtime.home,name))).toBe(false);
 expect(statSync(runtime.home).mode&0o777).toBe(0o700);
 expect(prepareRuntimeHome(join(root,"bot"),source)).toEqual(runtime);
 expect(prepareRuntimeHome(join(root,"second"),source).home).not.toBe(runtime.home);
});
test("refuse unexpected configuration or desktop home reuse",()=>{
 const {root,source}=fixture();writeFileSync(join(source,"auth.json"),"test");const state=join(root,"bot");mkdirSync(state);
 symlinkSync(source,join(state,"codex-home"));expect(()=>prepareRuntimeHome(state,source)).toThrow("must differ");
 rmSync(join(state,"codex-home"));mkdirSync(join(state,"codex-home"));writeFileSync(join(state,"codex-home/auth.json"),"different");
 expect(()=>prepareRuntimeHome(state,source)).toThrow("Unexpected");
});
test("child receives independent home and database overrides",async()=>{
 const {root,source}=fixture();const runtime=prepareRuntimeHome(join(root,"bot"),source);
 const app=new AppServer("node",["-e",`require('readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id)console.log(JSON.stringify({id:m.id,result:{home:process.env.CODEX_HOME,sqlite:process.env.CODEX_SQLITE_HOME}}));})`],2000,"full-access",runtime);
 try{await app.start();expect(await app.request("test/env",{})).toEqual({home:runtime.home,sqlite:runtime.home});}finally{app.close();}
});

test("isolated mode never inspects source and never links login/configuration",()=>{
 const {root}=fixture();const runtime=prepareRuntimeHome(join(root,"bot"),join(root,"absent-source"),"isolated");
 expect(runtime).toEqual({home:realpathSync(join(root,"bot/codex-home-isolated"))});
 for(const name of ["auth.json","config.toml","plugins","sessions"])expect(existsSync(join(runtime.home,name))).toBe(false);
 symlinkSync(join(root,"absent-source"),join(runtime.home,"auth.json"));
 expect(()=>prepareRuntimeHome(join(root,"bot"),join(root,"absent-source"),"isolated")).toThrow("must not link");
});
test("explicit auth-only mode links only synthetic login and rejects inherited extras",()=>{
 const {root,source}=fixture();writeFileSync(join(source,"auth.json"),"synthetic-test-login");
 writeFileSync(join(source,"config.toml"),"must-not-import");mkdirSync(join(source,"plugins"));
 const state=join(root,"bot"), runtime=prepareRuntimeHome(state,source,"auth-only");
 expect(readlinkSync(join(runtime.home,"auth.json"))).toBe(join(realpathSync(source),"auth.json"));
 expect("legacyHome" in runtime).toBe(false);
 expect(existsSync(join(runtime.home,"config.toml"))).toBe(false);
 expect(existsSync(join(runtime.home,"plugins"))).toBe(false);
 expect(prepareRuntimeHome(state,source,"auth-only")).toEqual(runtime);
 mkdirSync(join(runtime.home,"plugins"));
 expect(()=>prepareRuntimeHome(state,source,"auth-only")).toThrow("unexpected configuration");
});
test("read-only startup errors are actionable without leaking raw stderr",async()=>{
 const app=new AppServer("node",["-e",`console.error('private-key-do-not-print Read-only file system (os error 30)');process.exit(1)`]);
 try { await expect(app.start()).rejects.toThrow("CODEX_HOME must be writable"); }
 finally { app.close(); }
});
test("authentication status distinguishes initialization from account readiness",async()=>{
 for (const [result,expected] of [[{account:null,requiresOpenaiAuth:true},"required"],[{account:{email:"private-test@example.test"}},"authenticated"],[{requiresOpenaiAuth:false},"not-required"],[{},"unknown"]] as const) {
  const app=new AppServer("node",["-e",`require('readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id)console.log(JSON.stringify({id:m.id,result:m.method==='account/read'?${JSON.stringify(result)}:{}}));})`]);
  try { await app.start();expect(await app.authenticationStatus()).toBe(expected); } finally { app.close(); }
 }
});


test("independent modes reject mutable-state symlinks including nested paths",()=>{
 for(const mode of ["isolated","auth-only"] as const) for(const name of ["sessions","installation_id","state_5.sqlite","thread-writer-locks","nested/escape"]) {
  const {root,source}=fixture();writeFileSync(join(source,"auth.json"),"{}");
  const state=join(root,"bot"),runtime=prepareRuntimeHome(state,source,mode);
  if(name.includes("/"))mkdirSync(join(runtime.home,"nested"));
  symlinkSync(join(source,"never-read"),join(runtime.home,name));
  expect(()=>prepareRuntimeHome(state,source,mode)).toThrow("must not link");
 }
});


test("isolated CLI check reports missing login without generating or exposing account data",()=>{
 const {root}=fixture();const profile=join(root,"profile.json"),fake=join(root,"fake-codex");
 writeFileSync(profile,JSON.stringify({agent_id:"synthetic-bot",token:"ac_test_only"}),{mode:0o600});
 writeFileSync(fake,`#!/usr/bin/env node\nrequire('readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id)console.log(JSON.stringify({id:m.id,result:m.method==='account/read'?{account:null,requiresOpenaiAuth:true}:{}}));});\n`);chmodSync(fake,0o700);
 const result=spawnSync(process.execPath,[join(import.meta.dir,"../codex/run.ts"),"--codex-bridge","--cwd",root,"--profile",profile,"--codex-bin",fake,"--state-root",join(root,"state"),"--codex-home-mode","isolated","--check"],{encoding:"utf8",env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:join(root,"nonexistent-source")},timeout:10000});
 expect(result.status).toBe(0);
 expect(result.stdout).toContain('"authentication":"required"');
 expect(result.stdout).toContain('"generation_verified":false');
 expect(result.stdout).not.toContain("ac_test_only");
 expect(existsSync(join(root,"nonexistent-source"))).toBe(false);
});

test("auth-only permits Codex-generated system skills, not custom skills",()=>{
 const {root,source}=fixture();writeFileSync(join(source,"auth.json"),"{}");const state=join(root,"bot");
 const runtime=prepareRuntimeHome(state,source,"auth-only");mkdirSync(join(runtime.home,"skills/.system"),{recursive:true});
 expect(prepareRuntimeHome(state,source,"auth-only")).toEqual(runtime);
 mkdirSync(join(runtime.home,"skills/custom"));expect(()=>prepareRuntimeHome(state,source,"auth-only")).toThrow("custom skills");
});
test("interrupted Codex aliases require the exact selected executable and path shape",()=>{
 for(const mode of ["isolated","auth-only"] as const) {
  const {root,source}=fixture();writeFileSync(join(source,"auth.json"),"{}");const state=join(root,"bot"),binary=join(root,"codex");
  writeFileSync(binary,"synthetic executable",{mode:0o700});
  const runtime=prepareRuntimeHome(state,source,mode,binary),aliases=join(runtime.home,"tmp/arg0/codex-arg0TEST");mkdirSync(aliases,{recursive:true});
  for(const name of ["apply_patch","applypatch","codex-execve-wrapper","codex-linux-sandbox"])symlinkSync(binary,join(aliases,name));
  expect(prepareRuntimeHome(state,source,mode,binary)).toEqual(runtime);
  symlinkSync(binary,join(aliases,"unexpected"));expect(()=>prepareRuntimeHome(state,source,mode,binary)).toThrow("must not link");rmSync(join(aliases,"unexpected"));
  const other=join(root,"other");writeFileSync(other,"other",{mode:0o700});
  expect(()=>prepareRuntimeHome(state,source,mode,other)).toThrow("must not link");
 }
});


test("sandbox startup rejection exposes only safe actionable diagnostics",async()=>{
 const detail="private-source-value fs sandbox helper failed: app-server socket directory must be a user-owned directory with mode 0700";
 const app=new AppServer("node",["-e",`require('readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id)console.log(JSON.stringify(m.method==='test/reject'?{id:m.id,error:{code:-32000,message:${JSON.stringify(detail)}}}:{id:m.id,result:{}}));})`]);
 try {
  await app.start();
  let message="";try { await app.request("test/reject",{}); } catch(e) { message=(e as Error).message; }
  expect(message).toContain("Host sandbox rejected");expect(message).toContain("Model execution is not verified");expect(message).not.toContain("private-source-value");
 } finally {app.close();}
});
