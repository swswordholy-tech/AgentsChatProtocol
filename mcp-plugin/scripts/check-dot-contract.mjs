#!/usr/bin/env bun
// Compare schema exports only. Never start the server, connect an account or subscribe.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
const root = process.argv[2];
if (!root || process.argv.length !== 3) {
  console.error('Usage: bun scripts/check-dot-contract.mjs /path/to/IOSDev/projects/AgentChat/Server');
  process.exit(2);
}
const contract = JSON.parse(readFileSync(new URL('../../docs/dot-remote-mcp.contract.json', import.meta.url), 'utf8'));
const { MCP_TOOLS } = await import(pathToFileURL(resolve(root, 'src/remote-mcp.ts')).href);
const { eventDescription, inboxEventDescription } = await import(pathToFileURL(resolve(root, 'src/mcp-events.ts')).href);
const actual = Object.fromEntries(MCP_TOOLS.map(tool => [tool.name, tool.inputSchema]));
for (const [name, expected, observed] of [
  ['tool input schemas', contract.tools, actual],
  ['event name', contract.event.name, eventDescription.name],
  ['event delivery', contract.event.delivery, eventDescription.delivery],
  ['event input schema', contract.event.inputSchema, eventDescription.inputSchema],
  ['event payload schema', contract.event.payloadSchema, eventDescription.payloadSchema],
  ['identity event name', contract.identityEvent.name, inboxEventDescription.name],
  ['identity event delivery', contract.identityEvent.delivery, inboxEventDescription.delivery],
  ['identity event input schema', contract.identityEvent.inputSchema, inboxEventDescription.inputSchema],
  ['identity event payload schema', contract.identityEvent.payloadSchema, inboxEventDescription.payloadSchema],
]) {
  if (!isDeepStrictEqual(expected, observed)) {
    console.error(`dot contract mismatch: ${name}`);
    process.exit(1);
  }
}
const profile = MCP_TOOLS.find(tool => tool.name === 'get_profile');
const reader = MCP_TOOLS.find(tool => tool.name === 'agentschat_read_messages');
const reply = MCP_TOOLS.find(tool => tool.name === 'agentschat_reply');
if (profile?._meta?.['openai/profile'] !== true || profile?.annotations?.readOnlyHint !== true ||
    reader?.annotations?.readOnlyHint !== true || reply?.annotations?.readOnlyHint !== false || reply?.annotations?.idempotentHint !== true) {
  console.error('dot contract mismatch: identity/tool safety metadata'); process.exit(1);
}
console.log('dot shared contract matches server tool/event schemas and safety metadata');
