import { expect, test } from "bun:test";
import { AppServer } from "../codex/app-server.ts";

test("model override reaches new and resumed threads and every turn without replacing history", async () => {
 const script = `
 const emit=m=>process.stdout.write(JSON.stringify(m)+'\\n');
 require('readline').createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line),p=m.params;if(!m.id)return;
  const reply=result=>emit({id:m.id,result});
  if(m.method==='initialize')reply({});
  if(m.method==='config/read')reply({config:{}});
  if(m.method==='thread/start'||m.method==='thread/resume'){
   if(p.model!=='gpt-6.1-sol')return emit({id:m.id,error:{code:-1}});
   reply({thread:{id:p.threadId||'original-thread'}});
  }
  if(m.method==='turn/start'){
   reply({turn:{id:'t'}});
   emit({method:'turn/completed',params:{threadId:p.threadId,turn:{id:'t',status:'completed',items:[{type:'agentMessage',id:'a',text:p.model+'/'+p.effort}]}}});
  }
 });`;
 const app=new AppServer('node',['-e',script],undefined,'full-access',undefined,'medium','gpt-6.1-sol');
 try {
  await app.start();const id=await app.thread('/tmp');
  expect(await app.generate(id,'first')).toBe('gpt-6.1-sol/medium');
  expect(await app.thread('/tmp',id)).toBe('original-thread');
  expect(await app.generate(id,'next')).toBe('gpt-6.1-sol/medium');
 } finally {app.close();}
});
