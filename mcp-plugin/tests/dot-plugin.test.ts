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
 expect(Object.keys(contract.tools)).toEqual(["agentschat_check_event_permission","get_profile","agentschat_read_messages","agentschat_reply","agentschat_set_typing"]);
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


test("identity inbox requires no prior channel knowledge and preserves narrow subscriptions",()=>{
 expect(contract.contractVersion).toBe(4);
 expect(contract.identityEvent.name).toBe("message.received");
 expect(contract.identityEvent.inputSchema).toEqual({type:"object",properties:{},additionalProperties:false});
 expect(contract.identityEvent.payloadSchema.properties.channel_type.enum).toEqual(["direct","group","project"]);
 expect([...contract.identityEvent.payloadSchema.required].sort()).toEqual(["channel_id","channel_type","message_id","sender_id"]);
 expect(contract.identityEvent.payloadSchema.additionalProperties).toBe(false);
 expect(contract.identityEvent.cursor).toBeNull();
 expect(contract.identityEvent.historyReplay).toBe(false);
 expect(contract.event.inputSchema.required).toEqual(["channel_id"]);
 expect(contract.event.payloadSchema.properties.channel_type).toBeUndefined();
 const skill=read(`${plugin}/skills/agentschat-dot/SKILL.md`);
 expect(skill).toContain("arguments: {}");
 expect(skill).toContain("No channel");
 expect(skill).toContain("do not silently replace them");
 expect(skill).toContain("authorize automatic replies in every group");
});


test("events permission check advertises explicit OAuth access without subscribing",()=>{
 expect(contract.tools.agentschat_check_event_permission).toEqual({type:"object",properties:{},additionalProperties:false});
 const meta=contract.toolMetadata.agentschat_check_event_permission;
 expect(meta.securitySchemes).toEqual([{type:"oauth2",scopes:["agentschat:events"]}]);
 expect(meta.annotations).toEqual({readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});
 expect(meta.outputSchema).toEqual({type:"object",properties:{authorized:{type:"boolean",const:true}},required:["authorized"],additionalProperties:false});
 expect(contract.toolMetadata.get_profile.securitySchemes).toEqual([{type:"oauth2",scopes:["agentschat:read"]}]);
 expect(contract.toolMetadata.agentschat_reply.securitySchemes).toEqual([{type:"oauth2",scopes:["agentschat:reply"]}]);
 const skill=read(`${plugin}/skills/agentschat-dot/SKILL.md`),doc=read("docs/dot-remote-mcp.md");
 expect(skill).toContain('mcp/www_authenticate');
 expect(skill).toContain('The user must explicitly approve');
 expect(skill).toContain('rescan');
 expect(skill).toContain('Do not assume events authorization preserves read/reply scopes');
 expect(doc).toContain('Declining');
 expect(doc).toContain('subscription remains forbidden');
});


test("new-user workflow keeps identity creation separate from OAuth approval",()=>{
 const skill=read(`${plugin}/skills/agentschat-dot/SKILL.md`),doc=read("docs/dot-remote-mcp.md");
 expect(skill).toContain("login/signup");
 expect(skill).toContain("Terms");
 expect(skill).toContain("separately approves Allow");
 expect(skill).toContain("expires after ten minutes");
 expect(skill).toContain("reuse that owned identity");
 expect(doc).toContain("does not return an agent key");
 expect(doc).toContain("Creating an identity does not grant OAuth permission");
 expect(doc).toContain("cookie and CSRF");
});


test("explicit typing contract binds reply permissions, short leases and UUID identifiers",()=>{
 const tool=contract.tools.agentschat_set_typing,meta=contract.toolMetadata.agentschat_set_typing;
 expect(tool.required).toEqual(["channel_id","in_reply_to","active"]);
 expect(tool.additionalProperties).toBe(false);
 expect(tool.properties.sender_id).toBeUndefined();
 expect(tool.properties.agent_id).toBeUndefined();
 expect(tool.properties.active.type).toBe("boolean");
 expect(tool.properties.ttl_seconds).toMatchObject({type:"integer",minimum:1,maximum:30,default:15});
 expect(meta.securitySchemes).toEqual([{type:"oauth2",scopes:["agentschat:reply"]}]);
 expect(meta.annotations).toEqual({readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true});
 for(const field of [contract.tools.agentschat_reply.properties.request_id,tool.properties.lease_id]){
  expect(field.format).toBe("uuid");
  expect(field.minLength).toBe(36);expect(field.maxLength).toBe(36);
  const valid="7a558cb6-e283-4b45-a1f7-e1568d697f83",pattern=new RegExp(field.pattern);
  const conforms=(value:string)=>value.length>=field.minLength&&value.length<=field.maxLength&&pattern.test(value);
  expect(conforms(valid)).toBe(true);expect(conforms(valid.toUpperCase())).toBe(true);
  for(const invalid of ["reply-"+valid,"incoming-1","descriptive-label",valid+"\n"]){expect(conforms(invalid)).toBe(false);}
  expect(field.examples).toContain(valid);
 }
 const output=meta.outputSchema;
 expect(output.additionalProperties).toBe(false);
 expect(output.properties.type.const).toBe("typing");
 for(const field of ["channel_id","sender_id","in_reply_to","lease_id","active","expires_at","revision"]){expect(output.required).toContain(field);}
 expect(output.properties.expires_at.format).toBe("date-time");
 expect(output.properties.revision.type).toBe("integer");
 for(const path of ["docs/dot-remote-mcp.md",`${plugin}/skills/agentschat-dot/SKILL.md`]){
  const text=read(path).replace(/\s+/g," ");
  expect(text).toContain("agentschat_set_typing");
  expect(text).toMatch(/advertis/);
  expect(text).toMatch(/authorized reply/);
  expect(text).toMatch(/no[\s\S]{0,20}inference lifecycle hook/i);
  expect(text).toMatch(/(?:long reasoning|long inference)/);
  expect(text).toMatch(/(?:expiry|expiration)[\s\S]{0,50}crash|crash[\s\S]{0,50}(?:expiry|expiration)/);
  expect(text).toContain("unprefixed UUID");
 }
});
