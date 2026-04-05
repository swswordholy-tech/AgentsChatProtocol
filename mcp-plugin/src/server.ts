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
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
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

const cliArgs = parseArgs();

// Profile: --profile <name> | AGENTCHAT_PROFILE=<path> | default ~/.agentchat/profile.json
// --profile my-bot → ~/.agentchat/my-bot.json（不存在则自动创建）
const homeDir = process.env.HOME || process.env.USERPROFILE || ".";
const configDir = join(homeDir, ".agentchat");

function resolveProfilePath(): string {
  // 1. --profile <name> → ~/.agentchat/<name>.json
  if (cliArgs.profile) {
    const p = cliArgs.profile;
    // 如果是完整路径则直接用，否则当作 profile 名
    return p.includes("/") || p.includes("\\") ? p : join(configDir, `${p}.json`);
  }
  // 2. AGENTCHAT_PROFILE 环境变量（完整路径）
  if (process.env.AGENTCHAT_PROFILE) return process.env.AGENTCHAT_PROFILE;
  // 3. 默认
  return join(configDir, "profile.json");
}

const profileFile = resolveProfilePath();
let profile: any = {};

if (existsSync(profileFile)) {
  profile = JSON.parse(readFileSync(profileFile, "utf-8"));
  process.stderr.write(`[agentchat] Profile loaded: ${profileFile}\n`);
} else {
  // Auto-create profile
  profile = {
    agent_id: randomUUID(),
    display_name: cliArgs.name || `Claude-${randomUUID().slice(0, 6)}`,
    token: "dev-token",
    capabilities: ["claude-code", "coding", "chat"],
  };
  mkdirSync(dirname(profileFile), { recursive: true });
  writeFileSync(profileFile, JSON.stringify(profile, null, 2));
  process.stderr.write(`[agentchat] Created profile: ${profileFile}\n`);
  process.stderr.write(`[agentchat] Agent ID: ${profile.agent_id}\n`);
}

// CLI args override env vars override profile override defaults
const DEFAULT_SERVER = "https://agentchat-server-679286795813.us-central1.run.app";
const serverUrl = (cliArgs.url || process.env.AGENTCHAT_REST_URL || DEFAULT_SERVER).replace(/\/$/, "");
const WS_URL = process.env.AGENTCHAT_URL || serverUrl.replace("https://", "wss://").replace("http://", "ws://") + "/ws";
const REST_URL = serverUrl;
const AGENT_ID = cliArgs.id || process.env.AGENTCHAT_AGENT_ID || profile.agent_id || randomUUID();
const TOKEN = cliArgs.token || process.env.AGENTCHAT_TOKEN || profile.token || "dev-token";
const CAPABILITIES = cliArgs.caps?.split(",") || profile.capabilities || ["claude-code", "coding", "chat"];

// Update display name if provided via CLI
if (cliArgs.name && profile.display_name !== cliArgs.name) {
  profile.display_name = cliArgs.name;
}

let ws: WebSocket | null = null;
let sessionId: string | null = null;

// MCP Server
const server = new Server(
  { name: "agentchat", version: "0.2.0" },
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
        headers: { "Content-Type": "application/json" },
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
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "join_channel", channel_id: chat_id, agent_id: AGENT_ID }));
      return { content: [{ type: "text", text: `Joined channel ${chat_id.slice(0, 8)}` }] };
    }
    return { content: [{ type: "text", text: "Not connected" }] };
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
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    ws!.send(JSON.stringify({
      type: "auth",
      agent_id: AGENT_ID,
      token: TOKEN,
      capabilities: CAPABILITIES,
    }));
  };

  ws.onmessage = async (event) => {
    let data: any;
    try { data = JSON.parse(String(event.data)); } catch { return; }

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
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "message", id: crypto.randomUUID(),
            channel_id: data.channel_id, sender_id: AGENT_ID,
            sender_type: "agent", content: "__typing__",
            content_type: "text", timestamp: new Date().toISOString(),
          }));
        }

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
      ws!.send(JSON.stringify({
        type: "join_channel",
        channel_id: data.channel_id,
        agent_id: AGENT_ID,
      }));
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
  };

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
import { HeartbeatMonitor, WS_OPEN, WS_CLOSED } from "./heartbeat.js";

const heartbeat = new HeartbeatMonitor({
  sendPing: () => {
    ws?.send(JSON.stringify({ type: "ping", timestamp: new Date().toISOString() }));
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
