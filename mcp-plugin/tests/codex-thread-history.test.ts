/** Migration must retain original evidence, chronological chat and private file permissions. */
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preserveChannelHistory, priorChannelThreads } from "../codex/thread-history.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive:true,force:true}); });
function directory() { const root=mkdtempSync(join(tmpdir(),"channel-history-")); roots.push(root); return root; }
const user = (id: string, content: string, channel="group") => ({type:"userMessage",content:[{type:"text",text:"AgentsChat message:\n"+JSON.stringify({id,channel_id:channel,sender_id:"member",content})}]});
const assistant = (text: string) => ({type:"agentMessage",phase:"final_answer",text});

test("legacy lookup selects every lane for the exact channel, once", () => {
  expect(priorChannelThreads({group:"first", '["group","read-only","chat"]':"second", '["group",null,"owner"]':"first", '["other","full-access","owner"]':"private"}, "group")).toEqual(["first","second"]);
});
test("merge orders interleaved turns, deduplicates messages and retains full private tool evidence", () => {
  const root=directory();
  const prompt=preserveChannelHistory(root,"group",[
    {id:"owner-lane",turns:[{id:"003",items:[user("m3","third"),assistant("third answer")]}]},
    {id:"chat-lane",turns:[{id:"001",items:[user("m1","first"),{type:"commandExecution",output:"secret-tool-evidence"},assistant("first answer")]},{id:"002",items:[user("m2","second"),assistant("second answer")]},{id:"004",items:[user("m1","first"),user("other","private-chat","dm-other")]}]},
  ], s=>s.replaceAll("secret", "[REDACTED]"));
  expect(prompt.indexOf('"content":"first"')).toBeLessThan(prompt.indexOf('"content":"second"'));
  expect(prompt.indexOf('"content":"second"')).toBeLessThan(prompt.indexOf('"content":"third"'));
  expect(prompt.split('"id":"m1"').length).toBe(2);
  expect(prompt).not.toContain("private-chat");
  const archive=join(root,"history",readdirSync(join(root,"history"))[0]!);
  const saved=JSON.parse(readFileSync(archive,"utf8"));
  expect(saved.threads[1].turns[0].items[1].output).toBe("[REDACTED]-tool-evidence");
  expect(saved.threads.map((t: any)=>t.id)).toEqual(["owner-lane","chat-lane"]);
  expect(statSync(archive).mode & 0o777).toBe(0o600);
  expect(statSync(join(root,"history")).mode & 0o777).toBe(0o700);
});
test("long history has a bounded recent preview and a complete recoverable export", () => {
  const root=directory();
  const turns=Array.from({length:100},(_,i)=>({id:String(i).padStart(3,"0"),items:[user("m"+i,"x".repeat(1000))]}));
  const prompt=preserveChannelHistory(root,"group",[{id:"old",turns}],s=>s);
  expect(prompt.length).toBeLessThan(61000);
  expect(prompt).toContain('"id":"m99"');
  expect(prompt).not.toContain('"id":"m0"');
  expect(prompt).toContain("Earlier context remains in that file");
  const file=join(root,"history",readdirSync(join(root,"history"))[0]!);
  expect(JSON.parse(readFileSync(file,"utf8")).threads[0].turns).toHaveLength(100);
});

test("older plain-text envelopes and scheduled prompts remain in the imported context", () => {
  const prompt=preserveChannelHistory(directory(),"group",[{id:"legacy",turns:[{id:"001",items:[{type:"userMessage",content:[{type:"text",text:"Older bridge request: continue the agreed work"}]}]},{id:"002",items:[{type:"userMessage",content:[{type:"text",text:"Authorized task: report project progress"}]}]}]}],s=>s);
  expect(prompt).toContain("continue the agreed work");
  expect(prompt).toContain("report project progress");
});
