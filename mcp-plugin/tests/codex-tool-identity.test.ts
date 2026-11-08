/** Operator contract: a bridged bot's MCP must use the same identity and service.
 * Real MCP child + HTTP boundary, not a mocked identity resolver.
 * Prevent anonymous/wrong-bot tools; retain as Codex startup regression coverage. */
import {test, expect} from "bun:test";
import {mkdtempSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";

for (const mode of ["ok", "wrong-profile", "revoked", "wrong-account"] as const) {
 test(`Codex MCP identity: ${mode}`, async () => {
  const root=mkdtempSync(join(tmpdir(),"codex-tool-"));
  const hub=Bun.serve({port:0,hostname:"127.0.0.1",fetch(req) {
   if(req.headers.get("authorization")!=="Bearer ac_fixture_only") return Response.json({}, {status:401});
   if(mode==="revoked") return Response.json({}, {status:401});
   if(new URL(req.url).pathname==="/api/account/onboarding")
    return Response.json({agent_id:mode==="wrong-account"?"other":"bot-one",claimed:true});
   if(new URL(req.url).pathname==="/api/channels/welcome/messages")
    return Response.json({messages:[{id:"m1",sender_id:"owner",content:"hello from fixture"}]});
   return Response.json({status:"ok"});
  }});
  const profileFile=join(root,"bot.json"), apiUrl=`http://127.0.0.1:${hub.port}`;
  writeFileSync(profileFile, JSON.stringify({agent_id:mode==="wrong-profile"?"other":"bot-one",token:"ac_fixture_only"}), {mode:0o600});
  const client=new Client({name:"identity-test",version:"1"});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve(import.meta.dir,"../src/server.ts"),"--profile","wrong-inherited","--url","http://127.0.0.1:1","--token","bad-inherited-token"],cwd:root,
   env:{PATH:process.env.PATH!,HOME:root,AGENTSCHAT_TOOL_ONLY:"1",AGENTSCHAT_CODEX_IDENTITY:JSON.stringify({profileFile,agentId:"bot-one",apiUrl,wsUrl:apiUrl.replace("http","ws")+"/ws"})},stderr:"pipe"});
  try {
   if(mode!=="ok") { await expect(client.connect(transport)).rejects.toThrow(); return; }
   await client.connect(transport);
   const who=JSON.stringify(await client.callTool({name:"whoami",arguments:{}}));
   expect(who).toContain("Agent ID: bot-one");
   expect(who).toContain("REST auth: ok");
   const disconnected=await client.callTool({name:"disconnect_profile",arguments:{}});
   expect(disconnected.isError).toBe(true);
   const history=JSON.stringify(await client.callTool({name:"get_history",arguments:{chat_id:"welcome"}}));
   expect(history).toContain("hello from fixture");
   expect(history).not.toContain("ac_fixture_only");
  } finally {await client.close(); await transport.close(); hub.stop(true);rmSync(root,{recursive:true,force:true});}
 },15000);
}
