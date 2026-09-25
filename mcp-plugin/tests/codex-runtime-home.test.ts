/** Bot persistence must not share the desktop database or writer-lock namespace. */
import {test,expect,afterEach} from "bun:test";
import {mkdtempSync,mkdirSync,writeFileSync,readlinkSync,existsSync,statSync,rmSync,symlinkSync,realpathSync} from "node:fs";
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
