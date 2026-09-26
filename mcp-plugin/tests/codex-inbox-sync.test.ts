import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InboxSync } from '../codex/inbox-sync.ts';

const dirs:string[]=[];
afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'codex-inbox-sync-'));dirs.push(dir);
  const file=join(dir,'inbound-cursors.json');
  const seed='2026-09-27T00:00:00.000000000Z';
  writeFileSync(file,JSON.stringify({version:1,channels:{group:seed}}),{mode:0o600});
  const row=(id:string,n:number)=>({id,channel_id:'group',sender_id:'owner',content:'@bot task',timestamp:`2026-09-27T00:00:00.${String(n).padStart(9,'0')}Z`});
  return {dir,file,seed,row,state:()=>JSON.parse(readFileSync(file,'utf8'))};
}

test('durable REST cursor catches gaps before a later live arrival without duplicates', async () => {
  const f=fixture(), ledger=new Set(['live-later']), executed:string[]=[], paths:string[]=[];
  const rows=[f.row('missed',1),f.row('live-later',2)];
  const api=async(path:string)=>{paths.push(path);const after=new URL(path,'http://localhost').searchParams.get('after')!;return {messages:rows.filter(m=>m.timestamp>after)};};
  const receive=(m:any)=>{if(!ledger.has(m.id)){ledger.add(m.id);executed.push(m.id);}return true;};
  let sync=new InboxSync(f.dir,api,receive,()=>true);sync.watch('group');await sync.sync();
  expect(executed).toEqual(['missed']);
  sync=new InboxSync(f.dir,api,receive,()=>true);sync.watch('group');await sync.sync();
  expect(executed).toEqual(['missed']);
  expect(decodeURIComponent(paths[1]!)).toContain('after='+rows[1]!.timestamp);
  expect(f.state().last_success_at).toBeString();
});

test('cold installation starts now without replaying historical instructions', async () => {
  const f=fixture();rmSync(f.file);let after='';let deliveries=0;
  const start=Date.now();
  const sync=new InboxSync(f.dir,async path=>{after=new URL(path,'http://localhost').searchParams.get('after')!;return {messages:[]};},()=>{deliveries++;return true;},()=>true);
  sync.watch('group');await sync.sync();
  expect(Date.parse(after)).toBeGreaterThanOrEqual(start);expect(deliveries).toBe(0);
});

test('full inbox retains page checkpoint, including an unaccepted equal-time sibling', async () => {
  const f=fixture(), seen=new Set<string>();let full=true;
  const rows=[f.row('one',1),f.row('two',1)];
  const sync=new InboxSync(f.dir,async()=>({messages:rows}),(m:any)=>{
    if(m.id==='two'&&full)return false;seen.add(m.id);return true;
  },()=>true);
  sync.watch('group');await sync.sync();expect(f.state().channels.group).toBe(f.seed);
  full=false;await sync.sync();expect([...seen]).toEqual(['one','two']);expect(f.state().channels.group).toBe(rows[1]!.timestamp);
});

test('failed or stopped fetch cannot advance cursor or deliver after shutdown', async () => {
  const f=fixture();let active=true, calls=0, delivered=0;
  let release!:(value:any)=>void;
  const sync=new InboxSync(f.dir,async()=>{
    if(++calls===1)throw Error('unavailable');return await new Promise(r=>{release=r;});
  },()=>{delivered++;return true;},()=>active,()=>{});
  sync.watch('group');await sync.sync();expect(f.state().channels.group).toBe(f.seed);expect(f.state().last_error).toBeString();
  const pending=sync.sync();expect(sync.sync()).toBe(pending);
  active=false;release({messages:[f.row('late',1)]});await pending;
  expect(delivered).toBe(0);expect(f.state().channels.group).toBe(f.seed);
});

test('history pagination is bounded and resumes from completed page', async () => {
  const f=fixture(), all=Array.from({length:75},(_,i)=>f.row(String(i),i+1)), seen:string[]=[];
  const sync=new InboxSync(f.dir,async path=>{
    const q=new URL(path,'http://localhost').searchParams;expect(q.get('limit')).toBe('50');
    return {messages:all.filter(m=>m.timestamp>q.get('after')!).slice(0,50)};
  },(m:any)=>{seen.push(m.id);return true;},()=>true);
  sync.watch('group');await sync.sync();expect(seen).toHaveLength(50);
  await sync.sync();expect(seen).toHaveLength(75);expect(new Set(seen).size).toBe(75);
});
