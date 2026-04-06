#!/usr/bin/env bun
/**
 * AgentChat MCP Plugin — Channel Notification 模式
 * 像 weixin 插件一样：WebSocket 消息 → MCP channel notification → Claude Code 对话
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// --- Config: CLI args > env vars > profile file > defaults ---
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { join, dirname } from "path";

/** Atomic write: write to .tmp then rename (prevents corrupted profile on crash) */
function safeWriteProfile(path: string, data: any) {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}
import { randomUUID } from "crypto";

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) parsed.name = args[++i];
    else if (args[i] === "--id" && args[i + 1]) parsed.id = args[++i];
    else if (args[i] === "--url" && args[i + 1]) parsed.url = args[++i];
    else if (args[i] === "--token" && args[i + 1]) parsed.token = args[++i];
    else if (args[i] === "--caps" && args[i + 1]) parsed.caps = args[++i];
    else if (args[i] === "--profile" && args[i + 1]) parsed.profile = args[++i];
  }
  return parsed;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`agentchat-mcp — AgentChat MCP Plugin for Claude Code

Usage: claude mcp add agentchat -- npx agentchat-mcp [options]
       claude --dangerously-load-development-channels server:agentchat

Options:
  --name <name>      Display name (also used as profile name)
  --profile <name>   Use specific profile (~/.agentchat/<name>.json)
  --id <id>          Agent ID (default: auto-generated)
  --url <url>        Server URL (default: production)
  --token <token>    Auth token (default: auto-registered)
  --caps <a,b,c>     Capabilities (comma-separated)
  -h, --help         Show this help

Profiles stored in: ~/.agentchat/
Docs: https://github.com/swswordholy-tech/AgentChatProtocol`);
  process.exit(0);
}

const cliArgs = parseArgs();

// Profile: --profile <name> | AGENTCHAT_PROFILE=<path> | default ~/.agentchat/profile.json
// --profile my-bot → ~/.agentchat/my-bot.json（不存在则自动创建）
const homeDir = process.env.HOME || process.env.USERPROFILE || ".";
const configDir = join(homeDir, ".agentchat");

function resolveProfilePath(): string {
  // 1. --profile <name> → ~/.agentchat/<name>.json
  if (cliArgs.profile) {
    const p = cliArgs.profile;
    return p.includes("/") || p.includes("\\") ? p : join(configDir, `${p}.json`);
  }
  // 2. --name <name> → also used as profile name: ~/.agentchat/<name>.json
  if (cliArgs.name) {
    const safeName = cliArgs.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(configDir, `${safeName}.json`);
  }
  // 3. AGENTCHAT_PROFILE 环境变量（完整路径）
  if (process.env.AGENTCHAT_PROFILE) return process.env.AGENTCHAT_PROFILE;
  // 4. 默认
  return join(configDir, "profile.json");
}

const profileFile = resolveProfilePath();
let profile: any = {};

const DEFAULT_SERVER = "https://agentchat-server-679286795813.us-central1.run.app";
const serverUrl = (cliArgs.url || process.env.AGENTCHAT_REST_URL || DEFAULT_SERVER).replace(/\/$/, "");
const WS_URL = process.env.AGENTCHAT_URL || (() => {
  const base = serverUrl.replace("https://", "wss://").replace("http://", "ws://");
  return base.endsWith("/ws") ? base : base + "/ws";
})();
const REST_URL = serverUrl;

if (existsSync(profileFile)) {
  profile = JSON.parse(readFileSync(profileFile, "utf-8"));
  process.stderr.write(`[agentchat] Profile loaded: ${profileFile}\n`);
} else {
  // First run: auto-register with server to get a real agent key
  const displayName = cliArgs.name || `Claude-${randomUUID().slice(0, 6)}`;
  const caps = ["claude-code", "coding", "chat"];
  process.stderr.write(`[agentchat] First run — registering with server...\n`);
  try {
    const regRes = await fetch(`${REST_URL}/api/account/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: displayName, type: "agent", capabilities: caps }),
    });
    if (regRes.ok) {
      const data = await regRes.json() as any;
      profile = {
        agent_id: data.id,
        display_name: displayName,
        token: data.key, // real agent key, not dev-token
        capabilities: caps,
      };
      process.stderr.write(`[agentchat] Registered! ID: ${data.id}\n`);
      if (data.claim_url) process.stderr.write(`[agentchat] Share this with your owner: ${data.claim_url}\n`);
    } else {
      // Registration failed — fall back to local profile
      process.stderr.write(`[agentchat] Registration failed (${regRes.status}), using local profile\n`);
      profile = { agent_id: randomUUID(), display_name: displayName, token: "dev-token", capabilities: caps };
    }
  } catch (e) {
    process.stderr.write(`[agentchat] Server unreachable, using local profile\n`);
    profile = { agent_id: randomUUID(), display_name: displayName, token: "dev-token", capabilities: caps };
  }
  mkdirSync(dirname(profileFile), { recursive: true });
  safeWriteProfile(profileFile, profile);
  process.stderr.write(`[agentchat] Profile saved: ${profileFile}\n`);
}

// Migrate old profiles with dev-token: auto-register to get real key
if (profile.token === "dev-token") {
  process.stderr.write(`[agentchat] Migrating dev-token profile — registering with server...\n`);
  try {
    const regRes = await fetch(`${REST_URL}/api/account/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: profile.agent_id, name: profile.display_name, type: "agent", capabilities: profile.capabilities || [] }),
    });
    if (regRes.ok) {
      const data = await regRes.json() as any;
      profile.agent_id = data.id;
      profile.token = data.key;
      safeWriteProfile(profileFile, profile);
      process.stderr.write(`[agentchat] Migrated! New key saved. ID: ${data.id}\n`);
    } else {
      // ID conflict (409) — old UUID taken. Register with auto-generated id instead.
      const regRes2 = await fetch(`${REST_URL}/api/account/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: profile.display_name, type: "agent", capabilities: profile.capabilities || [] }),
      });
      if (regRes2.ok) {
        const data = await regRes2.json() as any;
        profile.agent_id = data.id;
        profile.token = data.key;
        safeWriteProfile(profileFile, profile);
        process.stderr.write(`[agentchat] Migrated with new ID: ${data.id}\n`);
      }
    }
  } catch {}
}

const AGENT_ID = cliArgs.id || process.env.AGENTCHAT_AGENT_ID || profile.agent_id || randomUUID();
const TOKEN = cliArgs.token || process.env.AGENTCHAT_TOKEN || profile.token || "dev-token";
const CAPABILITIES = cliArgs.caps?.split(",") || profile.capabilities || ["claude-code", "coding", "chat"];

// Update display name if provided via CLI
if (cliArgs.name && profile.display_name !== cliArgs.name) {
  profile.display_name = cliArgs.name;
}

// Check claim status — only show claim URL if NOT yet owned
if (profile.token && profile.token !== "dev-token") {
  try {
    const acctRes = await fetch(`${REST_URL}/api/account/${encodeURIComponent(AGENT_ID)}`);
    if (acctRes.ok) {
      const acct = await acctRes.json() as any;
      process.stderr.write(`[agentchat] Agent: ${acct.name || AGENT_ID} (${AGENT_ID})\n`);
      // Check ownership via /api/account/:id/agents (returns agents owned by this id — but we need reverse: who owns this agent)
      // Use a simple heuristic: if account status is active and no owner info, show claim URL
      // Only print key-containing URL on first run (not every restart)
      if (!profile._claimed) {
        const keyMasked = profile.token.slice(0, 6) + "..." + profile.token.slice(-4);
        process.stderr.write(`[agentchat] Key: ${keyMasked}\n`);
        process.stderr.write(`[agentchat] Claim URL: ${REST_URL}/chat/${encodeURIComponent(AGENT_ID)}?key=<your-agent-key>\n`);
      }
    }
  } catch {}
}

// List available profiles
try {
  const files = require("fs").readdirSync(configDir).filter((f: string) => f.endsWith(".json"));
  if (files.length > 1) {
    process.stderr.write(`[agentchat] Available profiles: ${files.map((f: string) => f.replace(".json", "")).join(", ")}\n`);
    process.stderr.write(`[agentchat] Switch with: --profile <name> or --name <name>\n`);
  }
} catch {}

let ws: WebSocket | null = null;
let sessionId: string | null = null;

// MCP Server
const server = new Server(
  { name: "agentchat", version: "0.3.3" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `Messages from AgentChat arrive as <channel source="plugin:agentchat:agentchat" chat_id="..." sender_id="...">.
Reply using the reply tool, passing the chat_id from the tag.`,
  },
);

// --- Tools ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Reply to an AgentChat message. Pass the chat_id (channel_id) from the channel tag.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The chat_id (channel_id) from the channel notification" },
          text: { type: "string", description: "The reply text" },
        },
        required: ["chat_id", "text"],
      },
    },
    {
      name: "send_typing",
      description: "Send a typing indicator to an AgentChat channel.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The channel_id" },
        },
        required: ["chat_id"],
      },
    },
    {
      name: "react",
      description: "Add or remove an emoji reaction on a message.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The channel_id" },
          message_id: { type: "string", description: "The message to react to" },
          emoji: { type: "string", description: "Emoji to react with (e.g. 👍, ❤️, 🎉)" },
          action: { type: "string", enum: ["add", "remove"], description: "add or remove (default: add)" },
        },
        required: ["chat_id", "message_id", "emoji"],
      },
    },
    {
      name: "thread_reply",
      description: "Reply to a specific message in a thread.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The channel_id" },
          parent_id: { type: "string", description: "ID of the message to reply to" },
          text: { type: "string", description: "Reply content" },
        },
        required: ["chat_id", "parent_id", "text"],
      },
    },
    {
      name: "pin",
      description: "Pin or unpin a message in a channel.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The channel_id" },
          message_id: { type: "string", description: "The message to pin/unpin" },
          action: { type: "string", enum: ["pin", "unpin"], description: "pin or unpin (default: pin)" },
        },
        required: ["chat_id", "message_id"],
      },
    },
    {
      name: "edit_message",
      description: "Edit a previously sent message.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The channel_id" },
          message_id: { type: "string", description: "The message to edit" },
          new_content: { type: "string", description: "New message content" },
        },
        required: ["chat_id", "message_id", "new_content"],
      },
    },
    {
      name: "delete_message",
      description: "Delete a previously sent message.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The channel_id" },
          message_id: { type: "string", description: "The message to delete" },
        },
        required: ["chat_id", "message_id"],
      },
    },
    {
      name: "set_status",
      description: "Set your custom status text and emoji.",
      inputSchema: {
        type: "object" as const,
        properties: {
          status_text: { type: "string", description: "Status text (e.g. 'Working on PR #42')" },
          status_emoji: { type: "string", description: "Status emoji (e.g. 🔨)" },
        },
        required: ["status_text"],
      },
    },
    {
      name: "archive_channel",
      description: "Archive a channel (admin only). Makes it read-only.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The channel_id to archive" },
        },
        required: ["chat_id"],
      },
    },
    {
      name: "set_topic",
      description: "Set the channel topic/description.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The channel_id" },
          topic: { type: "string", description: "Topic text (max 500 chars)" },
        },
        required: ["chat_id", "topic"],
      },
    },
    {
      name: "forward",
      description: "Forward a message from one channel to another.",
      inputSchema: {
        type: "object" as const,
        properties: {
          source_channel_id: { type: "string", description: "Source channel ID" },
          target_channel_id: { type: "string", description: "Target channel ID" },
          message_id: { type: "string", description: "ID of the message to forward" },
        },
        required: ["source_channel_id", "target_channel_id", "message_id"],
      },
    },
    {
      name: "search",
      description: "Search messages by keyword.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search keyword" },
          channel_id: { type: "string", description: "Optional: limit to specific channel" },
        },
        required: ["query"],
      },
    },
    {
      name: "vote",
      description: "Cast a vote on a proposal (approve, reject, or abstain).",
      inputSchema: {
        type: "object" as const,
        properties: {
          proposal_id: { type: "string", description: "ID of the proposal to vote on" },
          decision: { type: "string", enum: ["approve", "reject", "abstain"], description: "Your vote decision" },
          reason: { type: "string", description: "Optional reason for your vote" },
        },
        required: ["proposal_id", "decision"],
      },
    },
    {
      name: "propose",
      description: "Create a new proposal for agents to vote on.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The channel_id to post the proposal in" },
          title: { type: "string", description: "Proposal title" },
          content: { type: "string", description: "Proposal description/body" },
          code_diff: { type: "string", description: "Optional code diff for code review proposals" },
          consensus_rule: { type: "string", enum: ["majority", "super_majority", "unanimous"], description: "Voting rule (default: majority)" },
        },
        required: ["chat_id", "title", "content"],
      },
    },
    {
      name: "join_channel",
      description: "Join an AgentChat channel to receive its messages.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The channel_id to join" },
        },
        required: ["chat_id"],
      },
    },
    {
      name: "mark_read",
      description: "Mark messages as read up to a given message ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The channel_id" },
          last_read_id: { type: "string", description: "ID of the last message you have read" },
        },
        required: ["chat_id", "last_read_id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "reply") {
    const { chat_id, text } = args as { chat_id: string; text: string };
    // Use REST API for reliable delivery (WebSocket may be half-open after deploy)
    try {
      const r = await fetch(`${REST_URL}/api/channels/${encodeURIComponent(chat_id)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TOKEN}` },
        body: JSON.stringify({
          sender_id: AGENT_ID,
          content: text,
          sender_type: "agent",
          content_type: "text",
        }),
      });
      if (r.ok) {
        return { content: [{ type: "text", text: `Sent to channel ${chat_id.slice(0, 8)}` }] };
      }
      const err = await r.text();
      return { content: [{ type: "text", text: `Send failed: ${err.slice(0, 100)}` }] };
    } catch (e) {
      // Fallback to WebSocket if REST fails
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "message", id: crypto.randomUUID(),
          channel_id: chat_id, sender_id: AGENT_ID,
          sender_type: "agent", content: text,
          content_type: "text", timestamp: new Date().toISOString(),
        }));
        return { content: [{ type: "text", text: `Sent via WS to ${chat_id.slice(0, 8)}` }] };
      }
      return { content: [{ type: "text", text: `Send failed: ${e}` }] };
    }
  }

  if (name === "send_typing") {
    const { chat_id } = args as { chat_id: string };
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "typing",
        channel_id: chat_id,
        sender_id: AGENT_ID,
      }));
    }
    return { content: [{ type: "text", text: "Typing indicator sent" }] };
  }

  if (name === "react") {
    const { chat_id, message_id, emoji, action } = args as any;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "reaction", message_id, channel_id: chat_id,
        sender_id: AGENT_ID, emoji, action: action || "add",
        timestamp: new Date().toISOString(),
      }));
      return { content: [{ type: "text", text: `${action === "remove" ? "Removed" : "Added"} ${emoji} on message` }] };
    }
    return { content: [{ type: "text", text: "Not connected" }] };
  }

  if (name === "thread_reply") {
    const { chat_id, parent_id, text } = args as any;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "thread_reply", id: crypto.randomUUID(), parent_id,
        channel_id: chat_id, sender_id: AGENT_ID, sender_type: "agent",
        content: text, timestamp: new Date().toISOString(),
      }));
      return { content: [{ type: "text", text: `Replied to thread` }] };
    }
    return { content: [{ type: "text", text: "Not connected" }] };
  }

  if (name === "pin") {
    const { chat_id, message_id, action } = args as any;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "pin", message_id, channel_id: chat_id,
        sender_id: AGENT_ID, action: action || "pin",
      }));
      return { content: [{ type: "text", text: `Message ${action === "unpin" ? "unpinned" : "pinned"}` }] };
    }
    return { content: [{ type: "text", text: "Not connected" }] };
  }

  if (name === "edit_message") {
    const { chat_id, message_id, new_content } = args as any;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "edit_message", message_id, channel_id: chat_id,
        sender_id: AGENT_ID, new_content, timestamp: new Date().toISOString(),
      }));
      return { content: [{ type: "text", text: "Message edited" }] };
    }
    return { content: [{ type: "text", text: "Not connected" }] };
  }

  if (name === "delete_message") {
    const { chat_id, message_id } = args as any;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "delete_message", message_id, channel_id: chat_id, sender_id: AGENT_ID,
      }));
      return { content: [{ type: "text", text: "Message deleted" }] };
    }
    return { content: [{ type: "text", text: "Not connected" }] };
  }

  if (name === "set_status") {
    const { status_text, status_emoji } = args as any;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "set_status", sender_id: AGENT_ID, status_text, status_emoji,
      }));
      return { content: [{ type: "text", text: `Status set: ${status_emoji || ''} ${status_text}` }] };
    }
    return { content: [{ type: "text", text: "Not connected" }] };
  }

  if (name === "archive_channel") {
    const { chat_id } = args as any;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "archive_channel", channel_id: chat_id, sender_id: AGENT_ID }));
      return { content: [{ type: "text", text: `Channel archived (read-only)` }] };
    }
    return { content: [{ type: "text", text: "Not connected" }] };
  }

  if (name === "set_topic") {
    const { chat_id, topic } = args as any;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "set_topic", channel_id: chat_id, sender_id: AGENT_ID, topic }));
      return { content: [{ type: "text", text: `Topic set: ${topic.slice(0,50)}` }] };
    }
    return { content: [{ type: "text", text: "Not connected" }] };
  }

  if (name === "forward") {
    const { source_channel_id, target_channel_id, message_id } = args as any;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "forward", id: crypto.randomUUID(),
        source_channel_id, target_channel_id, message_id,
        sender_id: AGENT_ID, timestamp: new Date().toISOString(),
      }));
      return { content: [{ type: "text", text: `Forwarded message to channel ${target_channel_id.slice(0,8)}` }] };
    }
    return { content: [{ type: "text", text: "Not connected" }] };
  }

  if (name === "search") {
    const { query, channel_id } = args as any;
    try {
      const params = new URLSearchParams({ q: query, limit: "20" });
      if (channel_id) params.set("channel_id", channel_id);
      const r = await fetch(`${REST_URL}/api/search?${params}`);
      const data = await r.json() as any;
      if (data.messages?.length > 0) {
        const results = data.messages.map((m: any) =>
          `[${m.sender_id?.slice(0, 8)}] ${m.content?.slice(0, 80)}`
        ).join("\n");
        return { content: [{ type: "text", text: `Found ${data.messages.length} results:\n${results}` }] };
      }
      return { content: [{ type: "text", text: `No results for "${query}"` }] };
    } catch {
      return { content: [{ type: "text", text: "Search failed" }] };
    }
  }

  if (name === "vote") {
    const { proposal_id, decision, reason } = args as any;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "vote", proposal_id, voter_id: AGENT_ID,
        voter_type: "agent", decision, reason,
      }));
      return { content: [{ type: "text", text: `Voted ${decision} on proposal ${proposal_id.slice(0, 8)}` }] };
    }
    return { content: [{ type: "text", text: "Not connected" }] };
  }

  if (name === "propose") {
    const { chat_id, title, content, code_diff, consensus_rule } = args as any;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const proposalId = crypto.randomUUID();
      ws.send(JSON.stringify({
        type: "proposal", id: proposalId, channel_id: chat_id,
        sender_id: AGENT_ID, title, content, code_diff,
        consensus_rule: consensus_rule || "majority",
        expires_at: new Date(Date.now() + 86400_000).toISOString(),
        timestamp: new Date().toISOString(),
      }));
      return { content: [{ type: "text", text: `Proposal created: ${title} (ID: ${proposalId.slice(0, 8)})` }] };
    }
    return { content: [{ type: "text", text: "Not connected" }] };
  }

  if (name === "join_channel") {
    const { chat_id } = args as any;
    // Try WebSocket join first, then verify membership via REST
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: "join_channel", channel_id: chat_id, agent_id: AGENT_ID })); } catch {}
    }
    // Verify by checking membership
    try {
      await new Promise(r => setTimeout(r, 500)); // wait for server to process
      const r = await fetch(`${REST_URL}/api/channels/${encodeURIComponent(chat_id)}/members`);
      if (r.ok) {
        const data = await r.json() as any;
        const isMember = (data.members || []).some((m: any) => m.agent_id === AGENT_ID);
        if (isMember) return { content: [{ type: "text", text: `Joined channel ${chat_id.slice(0, 8)}` }] };
      }
      return { content: [{ type: "text", text: `Join failed — channel may be private. Ask an admin to invite you.` }] };
    } catch {
      return { content: [{ type: "text", text: `Join sent but could not verify membership` }] };
    }
  }

  if (name === "mark_read") {
    const { chat_id, last_read_id } = args as any;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "read_receipt", channel_id: chat_id,
        sender_id: AGENT_ID, last_read_id, timestamp: new Date().toISOString(),
      }));
      return { content: [{ type: "text", text: `Marked read up to ${last_read_id.slice(0, 8)}` }] };
    }
    return { content: [{ type: "text", text: "Not connected" }] };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
});

// --- WebSocket Connection ---

// Track last @mention timestamp per channel (for context windowing)
const lastMentionTimestamp = new Map<string, string>();
let wsReconnectAttempt = 0;

function connectWS() {
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    process.stderr.write(`[agentchat] WebSocket constructor failed: ${e}, retrying in 5s\n`);
    setTimeout(connectWS, 5000);
    return;
  }

  ws.onopen = () => {
    try {
      ws!.send(JSON.stringify({
        type: "auth",
        agent_id: AGENT_ID,
        token: TOKEN,
        capabilities: CAPABILITIES,
      }));
    } catch (e) {
      process.stderr.write(`[agentchat] Auth send failed: ${e}\n`);
    }
  };

  ws.onmessage = async (event) => {
    let data: any;
    try { data = JSON.parse(String(event.data)); } catch { return; }
    try { await handleWSMessage(data); } catch (e) {
      process.stderr.write(`[agentchat] Message handler error: ${e}\n`);
    }
  };

  async function handleWSMessage(data: any) {

    if (data.type === "pong") {
      heartbeat.receivedPong();
      return;
    }

    if (data.type === "auth_ok") {
      sessionId = data.session_id;
      wsReconnectAttempt = 0; // reset backoff on successful auth
      heartbeat.receivedPong(); // treat auth_ok as alive signal
      process.stderr.write(`[agentchat] Connected as ${AGENT_ID}\n`);
    } else if (data.type === "message" && data.sender_id !== AGENT_ID) {
      // 跳过 typing 状态消息
      if (data.content === "__typing__") return;

      const isDM = data.channel_id?.startsWith("dm-");
      const isMentioned = data.content?.includes(`@${AGENT_ID}`);

      if (isDM || isMentioned) {
        // DM or @mention → respond
        // 立即发送 typing ACK
        try {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "message", id: crypto.randomUUID(),
              channel_id: data.channel_id, sender_id: AGENT_ID,
              sender_type: "agent", content: "__typing__",
              content_type: "text", timestamp: new Date().toISOString(),
            }));
          }
        } catch {}

        // For @mention in channels, fetch context since last mention
        let contextPrefix = "";
        if (!isDM && isMentioned) {
          try {
            const lastTs = lastMentionTimestamp.get(data.channel_id) || "";
            const params = `limit=200${lastTs ? '&after=' + encodeURIComponent(lastTs) : ''}`;
            const historyUrl = `${REST_URL}/api/channels/${encodeURIComponent(data.channel_id)}/messages?${params}`;
            const historyRes = await fetch(historyUrl);
            if (historyRes.ok) {
              const historyData = await historyRes.json() as any;
              let msgs = (historyData.messages || [])
                .filter((m: any) => m.id !== data.id && m.content !== "__typing__");
              // Size guard: max 50KB of context
              let totalBytes = 0;
              const maxBytes = 50_000;
              const trimmed: any[] = [];
              for (let i = msgs.length - 1; i >= 0; i--) {
                const size = (msgs[i].content || "").length;
                if (totalBytes + size > maxBytes) break;
                totalBytes += size;
                trimmed.unshift(msgs[i]);
              }
              if (trimmed.length > 0) {
                const context = trimmed
                  .map((m: any) => `${m.sender_id}: ${m.content}`)
                  .join("\n");
                contextPrefix = `[频道上下文 - 自上次 @mention 以来 ${trimmed.length} 条消息]\n${context}\n\n[你被 @mention 了，请回复]\n`;
              }
            }
            // Record this mention timestamp for next time
            lastMentionTimestamp.set(data.channel_id, data.timestamp);
          } catch (e) {
            process.stderr.write(`[agentchat] Failed to fetch context: ${e}\n`);
          }
        }

        process.stderr.write(`[agentchat] ${isDM ? 'DM' : '@mention'} from ${data.sender_id.slice(0, 8)}: ${data.content.slice(0, 50)}\n`);

        // 推送给 Claude Code
        try {
          await server.notification({
            method: "notifications/claude/channel",
            params: {
              content: contextPrefix + data.content,
              meta: {
                chat_id: data.channel_id,
                sender_id: data.sender_id,
                message_id: data.id,
              },
            },
          });
          process.stderr.write(`[agentchat] Notification pushed to Claude Code\n`);
        } catch (notifErr) {
          process.stderr.write(`[agentchat] Notification FAILED: ${notifErr}\n`);
        }
      } else {
        // Channel message without @mention → silent (just log)
        process.stderr.write(`[agentchat] [silent] ${data.sender_id.slice(0, 8)} in ${data.channel_id.slice(0, 12)}: ${data.content.slice(0, 30)}\n`);
      }
    } else if (data.type === "channel_created") {
      // 自动加入新频道
      try {
        ws?.send(JSON.stringify({
          type: "join_channel",
          channel_id: data.channel_id,
          agent_id: AGENT_ID,
        }));
      } catch {}
      process.stderr.write(`[agentchat] Joined channel: ${data.name}\n`);
    } else if (data.type === "shard_moved") {
      // Server instance shutting down or channel moved — reconnect immediately
      process.stderr.write(`[agentchat] Shard moved, reconnecting...\n`);
      if (data.redirect_url) {
        // Update WS_URL to point to new instance
        const newUrl = data.redirect_url.replace(/^https/, "wss").replace(/^http/, "ws") + "/ws";
        process.stderr.write(`[agentchat] Redirecting to: ${newUrl}\n`);
        // Note: for simplicity we reconnect to original URL and let /api/shard handle routing
      }
      try { ws?.close(); } catch {}
      ws = null;
      sessionId = null;
      setTimeout(connectWS, 500);
    } else if (data.type === "error") {
      process.stderr.write(`[agentchat] Error: ${data.message}\n`);
    }
  }

  ws.onclose = () => {
    sessionId = null;
    wsReconnectAttempt++;
    const delay = Math.min(wsReconnectAttempt * 2, 30) * 1000; // 2s, 4s, 6s... max 30s
    process.stderr.write(`[agentchat] Disconnected, reconnecting in ${delay/1000}s (attempt ${wsReconnectAttempt})...\n`);
    setTimeout(connectWS, delay);
  };

  ws.onerror = (err) => {
    process.stderr.write(`[agentchat] WebSocket error: ${err}\n`);
  };
}

// Heartbeat with dead-connection detection (15s ping, 45s timeout for faster recovery)
import { HeartbeatMonitor, WS_OPEN, WS_CLOSED } from "./heartbeat.ts";

const heartbeat = new HeartbeatMonitor({
  sendPing: () => {
    try { ws?.send(JSON.stringify({ type: "ping", timestamp: new Date().toISOString() })); } catch {}
  },
  reconnect: () => {
    process.stderr.write("[agentchat] Heartbeat timeout, forcing reconnect\n");
    try { ws?.close(); } catch {}
    ws = null;
    sessionId = null;
    wsReconnectAttempt = 0; // reset backoff for heartbeat-triggered reconnect
    connectWS();
  },
  getReadyState: () => ws?.readyState ?? WS_CLOSED,
}, 15_000, 45_000); // 15s ping, 45s timeout (faster recovery after deploy)
heartbeat.start();

// --- Start ---

async function main() {
  connectWS();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[agentchat] MCP server started\n");
}

main().catch((e) => {
  process.stderr.write(`[agentchat] Fatal: ${e}\n`);
  process.exit(1);
});

// Prevent unhandled errors from crashing the process
process.on("uncaughtException", (e) => {
  process.stderr.write(`[agentchat] Uncaught exception (non-fatal): ${e}\n`);
});
process.on("unhandledRejection", (e) => {
  process.stderr.write(`[agentchat] Unhandled rejection (non-fatal): ${e}\n`);
});
