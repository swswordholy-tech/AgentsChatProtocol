import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuiChannel } from "../codex/gui-channel.ts";

test("GUI delivery requires exact user message in selected thread, not enqueue or tool ACK", async () => {
 const dir=mkdtempSync(join(tmpdir(),"gui-channel-"));
 try {
  const q=new GuiChannel(dir,["target"]); let sends=0;
  expect(()=>q.enqueue("other","hi")).toThrow("not allowed");
  const e=q.enqueue("target","hello"); expect(e.status).toBe("pending");
  const history=(type:string,text:string,thread="target")=>({thread:{id:thread},turns:[{id:"turn",items:[{type,content:[{type:"text",text}]}]}]});
  const call=async(name:string)=>name==="send_message_to_thread" ? (++sends,{ok:true}) : history("agentMessage",e.prompt);
  expect((await q.dispatch(e.id,call)).status).toBe("submitted");
  expect((await q.dispatch(e.id,async()=>history("userMessage",e.prompt,"wrong"))).status).toBe("submitted");
  expect((await q.dispatch(e.id,async()=>history("userMessage",e.prompt+"suffix"))).status).toBe("submitted");
  expect((await q.dispatch(e.id,async()=>history("userMessage",e.prompt))).status).toBe("delivered");
  expect(sends).toBe(1);
  expect((await q.dispatch(e.id,async()=>{throw Error("should not call");})).turnId).toBe("turn");
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test("ambiguous GUI send survives restart without duplicate; allowlist rechecked", async()=>{
 const dir=mkdtempSync(join(tmpdir(),"gui-channel-"));
 try {
  const q=new GuiChannel(dir,["target"]), e=q.enqueue("target","test");let sends=0;
  const call=async(name:string)=>{if(name==="send_message_to_thread"){sends++;throw Error("timeout");}return {thread:{id:"target"},turns:[]};};
  expect((await q.dispatch(e.id,call)).status).toBe("uncertain");
  expect((await new GuiChannel(dir,["target"]).dispatch(e.id,call)).status).toBe("uncertain");
  expect(sends).toBe(1);
  await expect(new GuiChannel(dir,[]).dispatch(e.id,call)).rejects.toThrow("no longer allowed");
 } finally {rmSync(dir,{recursive:true,force:true});}
});
