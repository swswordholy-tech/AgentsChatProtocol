/** Real hub WebSocket -> MCP stdio notification + configured host wake.
 * A group self-loop needs no @mention; another bot's tick must not gain that route.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function until(done:()=>boolean) {
  const deadline=Date.now()+3000;
  while (!done() && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
  expect(done()).toBe(true);
}

for (const mode of ["claude-url","grok"] as const) test(`${mode}: own group skill tick reaches notification and wake exactly once`, async () => {
  const root=mkdtempSync(join(tmpdir(),"agentschat-group-loop-routing-"));
  const notifications: any[]=[], wakes: {path:string,body:any,authorization:string|null}[]=[];
  let socket: any;
  const hub=Bun.serve({port:0,
    async fetch(req,server) {
      const path=new URL(req.url).pathname;
      if (path==="/ws" && server.upgrade(req)) return;
      if (path==="/wake" || path==="/api/sendPrompt") {
        wakes.push({path,body:await req.json(),authorization:req.headers.get("Authorization")});
        return Response.json({ok:true});
      }
      return Response.json({messages:[],channels:[]});
    },
    websocket:{message(ws,raw) {
      const data=JSON.parse(String(raw));
      if (data.type==="auth" && data.agent_id==="team-bot" && data.token==="ac_test_only") {
        socket=ws; ws.send(JSON.stringify({type:"auth_ok",session_id:"test-session"}));
      }
      if (data.type==="ping") ws.send(JSON.stringify({type:"pong"}));
    }},
  });
  const base=`http://127.0.0.1:${hub.port}`;
  const gateway=join(root,"gateway.json");
  writeFileSync(gateway,JSON.stringify({port:hub.port,token:"gateway-test"}));
  const client=new Client({name:"group-loop-routing-test",version:"1"});
  client.fallbackNotificationHandler=async notification=>{notifications.push(notification);};
  const modeEnv: Record<string,string>=mode==="claude-url"
    ? {CLAUDE_CODE_ENTRYPOINT:"cli",AGENTCHAT_WAKE_URL:`${base}/wake`}
    : {AGENTCHAT_WAKE_MODE:"grok",AGENTCHAT_GROK_AGENT_ID:"gateway-agent",AGENTCHAT_GROK_GATEWAY:gateway};
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve(import.meta.dir,"../src/server.ts"),"--id","team-bot","--token","ac_test_only","--url",base],cwd:root,env:{PATH:process.env.PATH!,HOME:root,AGENTCHAT_REST_URL:base,AGENTCHAT_URL:`ws://127.0.0.1:${hub.port}/ws`,...modeEnv},stderr:"pipe"});
  try {
    await client.connect(transport); await until(()=>!!socket);
    const tick={type:"message",id:"own-tick",channel_id:"original-group",sender_id:"team-bot",content:"(loop tick — agentschat-team-lead)",meta:{kind:"loop_tick",loop_id:"own-loop",prompt:"agentschat-team-lead"}};
    const frames=[
      tick,
      tick, // duplicate WS delivery must not wake twice
      {...tick,id:"other-bot-tick",sender_id:"other-bot"},
      {...tick,id:"self-message",content:"@team-bot my ordinary reply",meta:undefined},
      {...tick,id:"slash-status",content:"@team-bot loop configured",meta:{kind:"loop_status"}},
      {...tick,id:"unmentioned-member",sender_id:"member",meta:undefined},
      {type:"message",id:"barrier",channel_id:"dm-owner",sender_id:"owner",content:"delivery barrier"},
    ];
    for (const frame of frames) socket.send(JSON.stringify(frame));
    await until(()=>notifications.length>=2 && wakes.length>=2);
    await new Promise(resolve=>setTimeout(resolve,60));
    expect(notifications).toHaveLength(2); expect(wakes).toHaveLength(2);
    expect(notifications.map(n=>n.params.meta.message_id).sort()).toEqual(["barrier","own-tick"]);
    const received=notifications.find(n=>n.params.meta.message_id==="own-tick");
    expect(received.method).toBe(mode==="claude-url" ? "notifications/claude/channel" : "notifications/chat/channel");
    expect(received.params).toEqual({content:tick.content,meta:{chat_id:"original-group",sender_id:"team-bot",message_id:"own-tick"}});
    if (mode==="claude-url") {
      expect(wakes.every(w=>w.path==="/wake")).toBe(true);
      expect(wakes.find(w=>w.body.message_id==="own-tick")!.body).toMatchObject({channel_id:"original-group",sender_id:"team-bot",content:tick.content});
    } else {
      expect(wakes.every(w=>w.path==="/api/sendPrompt" && w.authorization==="Bearer gateway-test" && w.body.agentId==="gateway-agent")).toBe(true);
      const wake=wakes.find(w=>w.body.prompt.includes("original-group"));
      expect(wake!.body.prompt).toContain(tick.content);
      expect(wake!.body.prompt).not.toContain("gateway-test");
    }
  } finally {
    await client.close(); await transport.close(); hub.stop(true); rmSync(root,{recursive:true,force:true});
  }
},10000);
