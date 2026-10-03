import {test,expect} from "bun:test";
import {readFileSync,existsSync} from "node:fs";
import {join} from "node:path";
const root=join(import.meta.dir,"../..");
const read=(path:string)=>readFileSync(join(root,path),"utf8");
const json=(path:string)=>JSON.parse(read(path));
const plugin="plugins/agentschat-dot";
const contract=json("docs/dot-remote-mcp.contract.json");

test("dot package has a portable remote transport without credentials or fabricated app IDs",()=>{
 const manifest=json(`${plugin}/plugin.json`),mcp=json(`${plugin}/mcp.json`);
 expect(manifest.name).toBe("agentschat-dot");
 expect(manifest.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
 expect(mcp.mcpServers.agentschat).toEqual({type:"streamable-http",url:contract.endpoint});
 expect(contract.endpoint).toBe("https://agents-chat.com/mcp");
 expect(manifest.extensions["com.openai"].apps).toBeUndefined();
 expect(existsSync(join(root,plugin,".app.json"))).toBe(false);
 expect(JSON.stringify(mcp)).not.toMatch(/Bearer|ac_[A-Za-z0-9]|authorization|command|env/);
 const entries=json(".agents/plugins/marketplace.json").plugins;
 expect(entries.find((p:any)=>p.name==="agentschat-dot").source.path).toBe(`./${plugin}`);
 expect(entries.some((p:any)=>p.name==="agentschat-codex")).toBe(true);
});

test("remote contract pins identity-bound tools and metadata-only event inputs",()=>{
 expect(Object.keys(contract.tools)).toEqual(["get_profile","agentschat_read_messages","agentschat_reply"]);
 expect(contract.tools.agentschat_read_messages.properties.message_id.maxLength).toBe(128);
 expect(contract.tools.agentschat_read_messages.properties.channel_id.pattern).toBe("^[\\w.-]+$");
 expect(contract.tools.agentschat_read_messages.properties.before.maxLength).toBe(64);
 expect(contract.tools.agentschat_reply.properties.content.maxLength).toBe(10000);
 expect(contract.tools.agentschat_reply.required).toEqual(["channel_id","in_reply_to","content","request_id"]);
 expect(contract.tools.agentschat_reply.properties.request_id.format).toBe("uuid");
 for(const tool of Object.values(contract.tools) as any[]){expect(tool.additionalProperties).toBe(false);expect(tool.properties.sender_id).toBeUndefined();}
 expect(contract.event.name).toBe("message.created");
 expect(Object.keys(contract.event.payloadSchema.properties)).toEqual(["channel_id","message_id","sender_id"]);
 expect(contract.event.inputSchema.properties.mentions_only.default).toBe(true);
 expect(contract.event.cursor).toBeNull();expect(contract.event.historyReplay).toBe(false);
 expect(contract.scopes).toEqual(["agentschat:read","agentschat:reply","agentschat:events"]);
});

test("dot workflow preserves identity choice, host boundaries and authorization",()=>{
 const skill=read(`${plugin}/skills/agentschat-dot/SKILL.md`),doc=read("docs/dot-remote-mcp.md");
 expect(skill).toContain("ask whether to reuse");
 expect(skill).toContain("explicit prior request to reuse");
 expect(skill).toContain("Monitoring alone does not authorize replies");
 expect(skill).toContain("Installing this plugin does not subscribe");
 expect(skill).toContain("does not hot-load");
 expect(doc).toContain("not proof that dot");
 expect(doc).toContain("Do not advertise\nlocal Codex CLI event wakeups");
 expect(doc).toContain("no historical replay");
 expect(doc).toContain("source/fixture validation");
 expect(doc).toContain("deployed endpoint verification");
});
