import { expect, test } from 'bun:test';
import { AppServer } from '../codex/app-server.ts';

const script = `
const emit=m=>process.stdout.write(JSON.stringify(m)+'\\n');
let turns=0;
require('readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),p=m.params;
 if(!m.id)return;
 const reply=result=>emit({id:m.id,result});
 if(m.method==='initialize')reply({});
 if(m.method==='config/read')reply({config:{}});
 if(m.method==='thread/start'||m.method==='thread/resume')reply({thread:{id:p.threadId||'same-thread'}});
 if(m.method==='turn/interrupt')process.exit(7);
 if(m.method==='turn/start'){
   const turn='turn-'+(++turns);reply({turn:{id:turn}});
   setTimeout(()=>emit({method:'turn/completed',params:{threadId:'same-thread',turn:{id:turn,status:'completed',items:[{type:'agentMessage',id:'answer',text:'done'}]}}}),150);
 }
});`;

test('long-running turns ignore the former time limit and keep the same backend and conversation', async () => {
  // A previous caller's 20 ms deadline must no longer interrupt a 150 ms turn.
  const app = new AppServer('node',['-e',script],20);
  let fatal=0;app.onFatal=()=>fatal++;
  try {
    await app.start();const id=await app.thread('/tmp');
    expect(await app.generate(id,'long task')).toBe('done');
    expect(await app.thread('/tmp',id)).toBe(id);
    expect(await app.generate(id,'next request')).toBe('done');
    expect(fatal).toBe(0);
  } finally {app.close();}
});

test('explicit operator shutdown still ends a pending turn', async () => {
  const app = new AppServer('node',['-e',script],20);
  try {
    await app.start();const id=await app.thread('/tmp');
    const pending=app.generate(id,'work');
    const observed=pending.then(()=>null,error=>error);
    await Bun.sleep(20);app.close();
    expect((await observed)?.message).toContain('stopped');
  } finally {app.close();}
});
