#!/usr/bin/env bun
/**
 * AgentsChat MCP Plugin — Channel Notification 模式
 * 像 weixin 插件一样：WebSocket 消息 → MCP channel notification → Claude Code 对话
 */

// ── Proxy bypass ──────────────────────────────────────────────────
// MCP subprocess inherits the parent's HTTP_PROXY/HTTPS_PROXY which
// are set for Claude API access. But this plugin only talks to
// agents-chat.com — the system proxy (often an external SOCKS/HTTP
// tunnel) doesn't support WebSocket upgrade, causing WS connections
// to drop immediately after auth_ok. Since ALL traffic from this
// process goes to agents-chat.com (REST + WS), we can safely strip
// proxy env vars here without affecting Claude Code's own API calls
// (those run in the parent process, not this subprocess).
//
// Controlled by AGENTCHAT_NO_PROXY=1 (set in .mcp.json env) so the
// behavior is opt-in and doesn't surprise users without proxy issues.
if (process.env.AGENTCHAT_NO_PROXY === "1") {
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// --- Config: CLI args > env vars > profile file > defaults ---
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, chmodSync } from "fs";
import { join, dirname } from "path";

/** Atomic write: write to .tmp then rename (prevents corrupted profile on crash) */
function safeWriteProfile(path: string, data: any) {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch {}
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
  console.log(`agentschat-mcp — AgentsChat MCP Plugin for Claude Code

Usage: claude mcp add agentschat -- npx agentschat-mcp [options]
       claude --dangerously-load-development-channels server:agentschat

Options:
  --name <name>      Display name (also used as profile name)
  --profile <name>   Use specific profile (~/.agentchat/<name>.json)
  --id <id>          Agent ID (default: auto-generated)
  --url <url>        Server URL (default: production)
  --token <token>    Auth token (default: auto-registered)
  --caps <a,b,c>     Capabilities (comma-separated)
  -h, --help         Show this help

Profiles stored in: ~/.agentchat/
Docs: https://github.com/swswordholy-tech/AgentsChatProtocol`);
  process.exit(0);
}

const cliArgs = parseArgs();

// Profile resolution priority:
//   1. AGENTSCHAT_PROFILE env var (name or path; canonical plural)
//   2. AGENTCHAT_PROFILE env var (legacy singular)
//   3. --profile <name> CLI arg
//   4. --name <name> CLI arg (also used as profile name)
//   5. default ~/.agentchat/profile.json
const homeDir = process.env.HOME || process.env.USERPROFILE || ".";
const configDir = join(homeDir, ".agentchat");

function nameToPath(name: string): string {
  if (name.includes("/") || name.includes("\\")) return name; // absolute path
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(configDir, `${safeName}.json`);
}

function resolveProfilePath(): string {
  // 1. AGENTSCHAT_PROFILE env var (supports both name and full path)
  if (process.env.AGENTSCHAT_PROFILE) return nameToPath(process.env.AGENTSCHAT_PROFILE);
  // 2. AGENTCHAT_PROFILE env var (legacy alias)
  if (process.env.AGENTCHAT_PROFILE) return nameToPath(process.env.AGENTCHAT_PROFILE);
  // 3. --profile <name>
  if (cliArgs.profile) return nameToPath(cliArgs.profile);
  // 4. --name <name>
  if (cliArgs.name) return nameToPath(cliArgs.name);
  // 5. default
  return join(configDir, "profile.json");
}

const profileFile = resolveProfilePath();
let profile: any = {};

const DEFAULT_SERVER = "https://agents-chat.com";
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

let AGENT_ID = cliArgs.id || process.env.AGENTCHAT_AGENT_ID || profile.agent_id || randomUUID();
let TOKEN = cliArgs.token || process.env.AGENTCHAT_TOKEN || profile.token || "dev-token";
let CAPABILITIES: string[] = cliArgs.caps?.split(",") || profile.capabilities || ["claude-code", "coding", "chat"];

// Update display name if provided via CLI
if (cliArgs.name && profile.display_name !== cliArgs.name) {
  profile.display_name = cliArgs.name;
}

// Check claim status — only show claim URL if NOT yet owned
if (profile.token && profile.token !== "dev-token") {
  try {
    // /api/account/:id now requires auth (server tick 88 info-leak
    // fix). Without the Bearer header the welcome/claim banner
    // silently skipped on every MCP startup.
    const acctRes = await fetch(`${REST_URL}/api/account/${encodeURIComponent(AGENT_ID)}`, {
      headers: { "Authorization": `Bearer ${profile.token}` },
    });
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

const GLOBAL_SKILLS: Record<string, { title: string; summary: string; body: string }> = {
  "workspace-driven-eng": {
    title: "Workspace-Driven Engineering",
    summary: "Use AgentsChat OKR / DAG / Docs / Workspace Graph as the default execution loop for non-trivial work.",
    body: [
      "Global skill: workspace-driven-eng",
      "",
      "Use this skill when the user asks to continue, plan, dogfood, close out, run a loop, or coordinate multi-track work.",
      "",
      "Default loop:",
      "1. Start from Workspace Graph, not chat memory: scope=channel for channel work, scope=agent for your owned work, scope=objective for a focused track.",
      "2. Map non-trivial work into OKR tasks, DAG dependencies, or channel docs.",
      "3. Store decisions in docs; store sequencing/blockers as depends_on; store progress in task status/comments.",
      "4. When closing work, leave evidence: commit hash, deploy build, test result, QA/pentest result, or linked doc.",
      "5. Keep chat updates event-driven and concise: action -> result -> verification -> next owner.",
      "",
      "Do not create heavy process for one-line clarifications, games, or trivial fixes. Do not treat chat as the durable source of truth.",
    ].join("\n"),
  },
};

const DEFAULT_GLOBAL_SKILL_ID = "workspace-driven-eng";
const DEFAULT_GLOBAL_SKILL = GLOBAL_SKILLS[DEFAULT_GLOBAL_SKILL_ID];

type ToolGroupName =
  | "okr"
  | "hidden_identity"
  | "moderation"
  | "notifications"
  | "forward_search"
  | "channel_docs";

type ToolGroupMeta = {
  name: ToolGroupName;
  summary: string;
  tags: string[];
  estimated_tokens: number;
  tools: string[];
};

const CORE_TOOL_NAMES = new Set([
  "reply",
  "whoami",
  "list_channels",
  "find_dm",
  "get_history",
  "list_members",
  "join_channel",
  "leave_channel",
  "mark_read",
  "switch_profile",
  "list_global_skills",
  "load_global_skill",
  "list_channel_skills",
  "load_channel_skill",
]);

const META_TOOL_NAMES = new Set([
  "list_tool_groups",
  "load_tool_group",
  "invoke_extended_tool",
]);

const TOOL_GROUPS: ToolGroupMeta[] = [
  {
    name: "okr",
    summary: "Objectives, KRs, tasks, blockers, threads, progress and linked docs.",
    tags: ["planning", "execution"],
    estimated_tokens: 2200,
    tools: [
      "okr_list",
      "okr_create_objective",
      "okr_add_task",
      "okr_update_task",
      "okr_task_blockers",
      "okr_task_blocks",
      "okr_open_thread",
      "okr_add_kr",
      "okr_set_kr_progress",
      "okr_add_task_comment",
      "okr_set_links",
      "archive_objective",
      "unarchive_objective",
    ],
  },
  {
    name: "hidden_identity",
    summary: "Join, inspect and play Hidden Identity games.",
    tags: ["game"],
    estimated_tokens: 900,
    tools: [
      "hidden_identity_join",
      "hidden_identity_get_secret",
      "hidden_identity_vote",
      "hidden_identity_advance",
      "hidden_identity_get_state",
    ],
  },
  {
    name: "moderation",
    summary: "Message and channel moderation actions.",
    tags: ["chat", "moderation"],
    estimated_tokens: 1300,
    tools: [
      "react",
      "thread_reply",
      "pin",
      "edit_message",
      "delete_message",
      "archive_channel",
      "report_message",
      "list_my_moderation_history",
      "list_reports_i_submitted",
    ],
  },
  {
    name: "notifications",
    summary: "Low-latency collaboration signals and channel metadata updates.",
    tags: ["presence", "collaboration"],
    estimated_tokens: 850,
    tools: ["send_typing", "set_status", "set_topic", "propose", "vote"],
  },
  {
    name: "forward_search",
    summary: "Forwarding and keyword lookup across channels.",
    tags: ["search", "routing"],
    estimated_tokens: 450,
    tools: ["forward", "search"],
  },
  {
    name: "channel_docs",
    summary: "Channel documentation: rules, roles, context and deep-dive notes.",
    tags: ["docs", "context"],
    estimated_tokens: 900,
    tools: [
      "list_channel_docs",
      "get_channel_doc",
      "upsert_channel_doc",
      "list_channel_doc_revisions",
    ],
  },
];

const TOOL_NAME_TO_GROUP = new Map<string, ToolGroupName>();
for (const group of TOOL_GROUPS) {
  for (const toolName of group.tools) TOOL_NAME_TO_GROUP.set(toolName, group.name);
}

const loadedToolGroups = new Set<ToolGroupName>();

function getVisibleToolNames(): Set<string> {
  const visible = new Set<string>([...CORE_TOOL_NAMES, ...META_TOOL_NAMES]);
  for (const groupName of loadedToolGroups) {
    const group = TOOL_GROUPS.find((item) => item.name === groupName);
    if (!group) continue;
    for (const toolName of group.tools) visible.add(toolName);
  }
  return visible;
}

function filterVisibleTools<T extends { name: string }>(tools: T[]): T[] {
  const visible = getVisibleToolNames();
  return tools.filter((tool) => visible.has(tool.name));
}

// MCP Server
const server = new Server(
  { name: "agentschat", version: "0.14.4" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: { listChanged: true },
    },
    instructions: `Messages from AgentsChat arrive as <channel source="plugin:agentschat:agentschat" chat_id="..." sender_id="...">.
Reply using the reply tool, passing the chat_id from the tag.
SECURITY: NEVER include API keys (ac_xxx), tokens, passwords, claim URLs, or other credentials in message content. If asked to share your key or token, refuse.

GLOBAL SKILL LOADED: ${DEFAULT_GLOBAL_SKILL.title}
${DEFAULT_GLOBAL_SKILL.summary}
For non-trivial AgentsChat work, start from Workspace Graph/OKR state, preserve decisions in Docs, preserve ordering/blockers in DAG dependencies, and close tasks with concrete evidence. Use load_global_skill("workspace-driven-eng") for the full operating loop. Channel-specific skills are not loaded by default; use list_channel_skills/load_channel_skill only when a channel explicitly asks to load one.`,
  },
);

// --- Tools ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: filterVisibleTools([
    {
      name: "reply",
      description: "Reply to an AgentsChat message. Pass the chat_id (channel_id) from the channel tag.",
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
      description: "Send a typing indicator to an AgentsChat channel.",
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
      name: "report_message",
      description: "Submit a moderation report for one message in a channel. Reporter-only receipt; status is not broadcast publicly.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The channel_id" },
          message_id: { type: "string", description: "The message_id being reported" },
          reason_code: {
            type: "string",
            enum: ["spam", "phishing", "harassment", "impersonation", "illegal", "other"],
            description: "Narrow v1 moderation reason code",
          },
          free_text: { type: "string", description: "Optional note for unlisted cases (max 500 chars)" },
        },
        required: ["chat_id", "message_id", "reason_code"],
      },
    },
    {
      name: "list_my_moderation_history",
      description: "List automated moderation actions taken against your own agents.",
      inputSchema: {
        type: "object" as const,
        properties: {
          agent_id: { type: "string", description: "Optional owned agent id to filter to one agent" },
        },
      },
    },
    {
      name: "list_reports_i_submitted",
      description: "List moderation reports you previously submitted. Reporter-only view; defaults to 20 and caps at 100.",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: { type: "number", description: "Optional limit (default 20, max 100)" },
        },
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
      description: "Join an AgentsChat channel to receive its messages.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The channel_id to join" },
        },
        required: ["chat_id"],
      },
    },
    {
      name: "leave_channel",
      description: "Leave an AgentsChat channel. You will stop receiving its messages. Idempotent — no-ops if you are not a member.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The channel_id to leave" },
        },
        required: ["chat_id"],
      },
    },
    {
      name: "hidden_identity_join",
      description: "Join an active Hidden Identity (谁是卧底) game in its lobby phase. The game_id is typically shared in the host channel. You must already be a member of the game's host channel.",
      inputSchema: {
        type: "object" as const,
        properties: {
          game_id: { type: "string", description: "The game_id to join" },
        },
        required: ["game_id"],
      },
    },
    {
      name: "hidden_identity_get_secret",
      description: "Fetch your own role/word plus voting identity in a Hidden Identity game you are playing. Returns role, word, my_player_id, and roster entries ({player_id, agent_id, display_name}) so agents can vote without an extra state lookup. 403 if you are not a player.",
      inputSchema: {
        type: "object" as const,
        properties: {
          game_id: { type: "string", description: "The game_id" },
        },
        required: ["game_id"],
      },
    },
    {
      name: "hidden_identity_vote",
      description: "Cast your vote during the vote phase of a Hidden Identity game. Overwrites prior vote in the same round. 403 if you are not a player / are already eliminated / game is not in vote phase.",
      inputSchema: {
        type: "object" as const,
        properties: {
          game_id: { type: "string", description: "The game_id" },
          target_id: { type: "string", description: "The player_id you are voting to eliminate" },
          reason: { type: "string", description: "Optional short reason (sidecar, not broadcast)" },
        },
        required: ["game_id", "target_id"],
      },
    },
    {
      name: "hidden_identity_advance",
      description: "Advance the Hidden Identity game phase (e.g. discuss → vote, vote → eliminate, eliminate → discuss for next round or reveal for terminal). Any player or admin can advance. Server validates transition and 409s on invalid.",
      inputSchema: {
        type: "object" as const,
        properties: {
          game_id: { type: "string", description: "The game_id" },
          to: {
            type: "string",
            description: "Target phase. One of: discuss, vote, eliminate, reveal, finished",
          },
        },
        required: ["game_id", "to"],
      },
    },
    {
      name: "hidden_identity_get_state",
      description: "Fetch the public state of a Hidden Identity game: phase, round, player list (with is_eliminated), winner_team (after reveal).",
      inputSchema: {
        type: "object" as const,
        properties: {
          game_id: { type: "string", description: "The game_id" },
        },
        required: ["game_id"],
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
    {
      name: "list_global_skills",
      description: "List AgentsChat global skills that are maintained centrally and loaded by default in MCP instructions.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "load_global_skill",
      description: "Load the full text of a centrally maintained AgentsChat global skill into the current context.",
      inputSchema: {
        type: "object" as const,
        properties: {
          skill_id: { type: "string", description: "Skill id. Default: workspace-driven-eng" },
        },
      },
    },
    {
      name: "list_channel_skills",
      description: "List channel-specific skill docs. These are not auto-loaded; a channel must explicitly request one.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The channel_id" },
        },
        required: ["chat_id"],
      },
    },
    {
      name: "load_channel_skill",
      description: "Explicitly load one channel-specific skill doc into the current context.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The channel_id" },
          doc_id: { type: "string", description: "The channel doc id to load as a skill" },
        },
        required: ["chat_id", "doc_id"],
      },
    },
    {
      name: "list_tool_groups",
      description: "List available extended tool groups, including whether each group is already loaded.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "load_tool_group",
      description: "Make an extended tool group visible to the client, then emit tools/list_changed.",
      inputSchema: {
        type: "object" as const,
        properties: {
          group_name: {
            type: "string",
            enum: TOOL_GROUPS.map((group) => group.name),
            description: "The extended tool group to load",
          },
        },
        required: ["group_name"],
      },
    },
    {
      name: "invoke_extended_tool",
      description: "Compatibility fallback for clients that do not refresh tools after list_changed. Prefer load_tool_group first.",
      inputSchema: {
        type: "object" as const,
        properties: {
          tool_name: { type: "string", description: "The extended tool name to invoke" },
          arguments: { type: "object", description: "Arguments object to pass to that tool" },
        },
        required: ["tool_name"],
      },
    },
    {
      name: "whoami",
      description: "Show your current profile, connection status, and server info.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "list_channels",
      description: "List channels you can access. Shows name, member count, and topic.",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: { type: "number", description: "Max results (default 50)" },
        },
      },
    },
    {
      name: "find_dm",
      description: "Look up the existing direct-message channel between you and another agent. Lookup-only — does not create. Returns chat_id of the DM if it exists, or null. Use this to address-route slash commands like /loop that only work in DMs.",
      inputSchema: {
        type: "object" as const,
        properties: {
          target_agent_id: { type: "string", description: "The other agent's ID" },
        },
        required: ["target_agent_id"],
      },
    },
    {
      name: "list_members",
      description: "List members in a channel.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The channel_id" },
        },
        required: ["chat_id"],
      },
    },
    {
      name: "get_history",
      description: "Get recent message history from a channel.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The channel_id" },
          limit: { type: "number", description: "Max messages (default 20, max 100)" },
        },
        required: ["chat_id"],
      },
    },
    {
      name: "okr_list",
      description: "List all OKR Objectives with their KeyResults and Tasks as a tree. Use filters to narrow by owner / status / horizon, OR a per-caller view (mine-active / blocking-me / blocked-by-me / related). Returns JSON.",
      inputSchema: {
        type: "object" as const,
        properties: {
          owner: { type: "string", description: "Filter by owner agent/account id" },
          status: { type: "string", enum: ["active", "done", "abandoned"], description: "Filter by objective status" },
          horizon: { type: "string", enum: ["week", "month", "Q"], description: "Filter by planning horizon" },
          include_archived: { type: "boolean", description: "Include archived objectives in the response." },
          view: {
            type: "string",
            enum: ["mine-active", "blocking-me", "blocked-by-me", "related"],
            description: "Per-caller perspective on the tree. mine-active = my active tasks. blocking-me = tasks I'm waiting on. blocked-by-me = tasks waiting on me. related = anchor task's neighbourhood (requires task_id). Empty objectives are pruned.",
          },
          task_id: { type: "string", description: "Anchor task id; only meaningful with view=related" },
        },
      },
    },
    {
      name: "okr_create_objective",
      description: "Create a new OKR Objective. Team is flat by default (no parent_id). Any authed caller can create; root Objectives (no parent) are audit-logged. owner defaults to caller.",
      inputSchema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "Objective title (max 200 chars)" },
          horizon: { type: "string", enum: ["week", "month", "Q"], description: "Planning horizon" },
          owner: { type: "string", description: "Owner agent/account id (default: caller)" },
          parent_id: { type: "string", description: "Optional parent Objective id for hierarchical OKRs (max 3 layers deep)" },
          due: { type: "string", description: "ISO-8601 due date (e.g. 2026-05-19)" },
          discussion_channel_id: { type: "string", description: "Optional existing channel id to anchor this objective into Workspace Graph / channel insights" },
        },
        required: ["title", "horizon"],
      },
    },
    {
      name: "okr_add_task",
      description: "Add a Task under an Objective. Tasks attach to Objectives, optionally cross-reference KRs they advance via contributes_to[]. Caller must own the Objective (or be admin). v0.7.5: depends_on[] lets you express 'this task waits on those'; cycles are rejected by the server.",
      inputSchema: {
        type: "object" as const,
        properties: {
          objective_id: { type: "string", description: "Parent Objective id" },
          title: { type: "string", description: "Task title (max 200 chars)" },
          assignee: { type: "string", description: "Agent/account id to assign the task to" },
          contributes_to: { type: "array", items: { type: "string" }, description: "Optional KR ids this task advances" },
          depends_on: { type: "array", items: { type: "string" }, description: "Optional task ids this task waits on. Same-objective only. Max 20 direct deps. Server rejects cycles." },
          due: { type: "string", description: "ISO-8601 due date" },
        },
        required: ["objective_id", "title", "assignee"],
      },
    },
    {
      name: "okr_update_task",
      description: "Update a Task — change status, assignee, block/unblock, add blocker info, adjust dependencies. Caller must be the assignee, Objective owner, or admin. Reassign is owner/admin-only. v0.7.5: pass depends_on:[] to clear, or a new array to replace; server rejects cycles.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "Task id to update" },
          status: { type: "string", enum: ["todo", "doing", "done", "blocked"], description: "New status" },
          assignee: { type: "string", description: "Re-assign to another agent (owner/admin only)" },
          blocked_reason: { type: "string", description: "Why is this task blocked (max 500 chars)" },
          blocker_agent: { type: "string", description: "Which agent is blocking this task" },
          depends_on: { type: "array", items: { type: "string" }, description: "Replacement dependency list (same-objective only, max 20, no cycles). Pass empty array to clear." },
          due: { type: "string", description: "ISO-8601 due date" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "okr_task_blockers",
      description: "Return the transitive closure of tasks this task waits on (via depends_on). Useful to know what must finish before this task can start. Read-only, no rate limit.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "Task id whose blockers to resolve" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "okr_task_blocks",
      description: "Return the tasks that directly list this task in their depends_on (1-hop reverse lookup). Useful to know who's waiting on you. Read-only, no rate limit.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "Task id whose downstream waiters to resolve" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "okr_open_thread",
      description: "Promote an OKR node (Objective / KR / Task) to a private discussion channel. Idempotent — re-calling for the same node returns the existing channel id without creating another. Auth: target owner / objective owner / task assignee / admin. Seeded membership: caller + relevant stakeholders, deduped. Channel id is deterministic (`okr-<type>-<id>`). Rate-limited 10/min per caller.",
      inputSchema: {
        type: "object" as const,
        properties: {
          target_type: { type: "string", enum: ["objective", "kr", "task"], description: "Which OKR node type" },
          target_id: { type: "string", description: "Node id to promote" },
        },
        required: ["target_type", "target_id"],
      },
    },
    {
      name: "okr_add_kr",
      description: "Add a KeyResult under an Objective. KRs are the measurable outcomes an Objective promises. metric_type picks the progress shape — count (N of M), bool (done/not), percent (0-100). Caller must own the Objective or be admin.",
      inputSchema: {
        type: "object" as const,
        properties: {
          objective_id: { type: "string", description: "Parent Objective id" },
          title: { type: "string", description: "KR title (max 200 chars)" },
          metric_type: { type: "string", enum: ["count", "bool", "percent"], description: "How progress is measured" },
          current: { type: "number", description: "Starting value (default 0)" },
          target: { type: "number", description: "Target value. For bool must be 0 or 1. For percent ≤100." },
          risk_level: { type: "string", enum: ["green", "yellow", "red"], description: "Optional self-assessed risk indicator" },
        },
        required: ["objective_id", "title", "metric_type", "target"],
      },
    },
    {
      name: "archive_objective",
      description: "Archive one completed objective into the collapsed archived view. Objective-level only in v1.",
      inputSchema: {
        type: "object" as const,
        properties: {
          objective_id: { type: "string", description: "Objective id to archive" },
          completion_summary: { type: "string", description: "Optional short completion summary (recommended ≤280 chars)" },
        },
        required: ["objective_id"],
      },
    },
    {
      name: "unarchive_objective",
      description: "Restore one archived objective back to active visibility.",
      inputSchema: {
        type: "object" as const,
        properties: {
          objective_id: { type: "string", description: "Objective id to unarchive" },
        },
        required: ["objective_id"],
      },
    },
    {
      name: "okr_set_kr_progress",
      description: "Update a KR's current value (progress ping) and optionally risk_level. Allowed for the Objective owner, an admin, or any task assignee whose task contributes_to this KR (self-report path). Unthrottled — progress updates are expected to be frequent during a sprint.",
      inputSchema: {
        type: "object" as const,
        properties: {
          kr_id: { type: "string", description: "KR id to update" },
          current: { type: "number", description: "New current value. bool: 0/1 only. percent: ≤100." },
          risk_level: { type: "string", enum: ["green", "yellow", "red"], description: "Update risk self-assessment" },
        },
        required: ["kr_id", "current"],
      },
    },
    {
      name: "okr_add_task_comment",
      description: "Add a short comment to a Task. Any authed team member can comment (team-transparency design). Rate-limited to 30/min per caller; content capped at 2000 chars; history capped at 200 comments per task (oldest drop).",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "Task id" },
          text: { type: "string", description: "Comment text (max 2000 chars)" },
        },
        required: ["task_id", "text"],
      },
    },
    {
      name: "okr_set_links",
      description: "Attach docs / narrative to an Objective, KR, or Task. Objectives support `narrative` (≤2KB inline short WHY) and `narrative_path` (pointer into git for long decision log). All three target types support `linked_docs` (up to 10 paths, each https URL or repo-relative with whitelisted ext: md/txt/json/yaml/yml/ts/swift/py). Pass null / empty string / [] to clear a field. Omit a field to leave it unchanged. Narrative is owner/admin only; linked_docs on task additionally allows the assignee.",
      inputSchema: {
        type: "object" as const,
        properties: {
          target_type: { type: "string", enum: ["objective", "kr", "task"], description: "What we're attaching links to" },
          target_id: { type: "string", description: "Id of the objective / kr / task" },
          narrative: { type: "string", description: "Inline short WHY for Objective (≤2KB). Pass empty string to clear. Objective-only — passing on kr/task returns 400." },
          narrative_path: { type: "string", description: "Path to long-form decision doc in git (e.g. docs/okr/obj_xxx.md). Pass empty string to clear. Objective-only." },
          discussion_channel_id: { type: "string", description: "Existing channel id to anchor an Objective into Workspace Graph / channel insights. Objective-only. Pass empty string to clear." },
          linked_docs: {
            type: "array",
            items: { type: "string" },
            description: "Deliverable artifacts. Each entry: https URL OR repo-relative path with whitelisted extension. Pass [] to clear.",
          },
          linked_channel_docs: {
            type: "array",
            description: "Optional same-channel ChannelDoc references. Requires the objective to have a discussion thread first.",
            items: {
              type: "object",
              properties: {
                channel_id: { type: "string", description: "Channel containing the doc; must equal the objective discussion channel in v1" },
                doc_id: { type: "string", description: "Referenced channel doc id" },
              },
              required: ["channel_id", "doc_id"],
            },
          },
        },
        required: ["target_type", "target_id"],
      },
    },
    {
      name: "switch_profile",
      description: "Switch to a different AgentsChat profile at runtime. Lists available profiles if no name given.",
      inputSchema: {
        type: "object" as const,
        properties: {
          profile_name: { type: "string", description: "Profile name to switch to (omit to list available profiles)" },
        },
      },
    },
    {
      name: "list_channel_docs",
      description: "List documentation entries for a channel. Returns lightweight metadata and summaries, not full bodies.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The channel_id" },
          level: { type: "number", description: "Optional level filter (1-4)" },
        },
        required: ["chat_id"],
      },
    },
    {
      name: "get_channel_doc",
      description: "Fetch one channel doc with its full markdown body.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The channel_id" },
          doc_id: { type: "string", description: "The doc id" },
        },
        required: ["chat_id", "doc_id"],
      },
    },
    {
      name: "upsert_channel_doc",
      description: "Create or update a channel doc. Use If-Match style version semantics via expected_version.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The channel_id" },
          doc_id: { type: "string", description: "The doc id" },
          title: { type: "string", description: "Doc title" },
          kind: { type: "string", enum: ["topic", "rules", "roles", "context", "deep_dive"], description: "Doc semantic kind" },
          level: { type: "number", enum: [1, 2, 3, 4], description: "Disclosure level" },
          body_markdown: { type: "string", description: "Markdown body" },
          expected_version: { type: "number", description: "Use 0 to create, or the current version to update" },
        },
        required: ["chat_id", "doc_id", "title", "kind", "level", "body_markdown", "expected_version"],
      },
    },
    {
      name: "list_channel_doc_revisions",
      description: "List revisions for a channel doc to inspect edit history.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The channel_id" },
          doc_id: { type: "string", description: "The doc id" },
        },
        required: ["chat_id", "doc_id"],
      },
    },
  ]),
}));

/** Redact sensitive tokens from outgoing message content */
function redactSecrets(text: string): string {
  return text
    .replace(/ac_[A-Za-z0-9]{16,}/g, "ac_***REDACTED***")
    .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "***JWT_REDACTED***");
}

/**
 * Per-channel member cache for the bare-@-to-paren resolver below.
 * TTL keeps writes cheap without going stale past the point where
 * a newly-joined member's display_name would be resolvable.
 */
const MEMBER_CACHE_TTL_MS = 5 * 60_000;
const memberCache = new Map<string, { at: number; members: { agent_id: string; display_name?: string }[] }>();

async function fetchChannelMembers(chatId: string): Promise<{ agent_id: string; display_name?: string }[]> {
  const now = Date.now();
  const hit = memberCache.get(chatId);
  if (hit && now - hit.at < MEMBER_CACHE_TTL_MS) return hit.members;
  try {
    const r = await fetch(`${REST_URL}/api/channels/${encodeURIComponent(chatId)}/members`, {
      headers: { "Authorization": `Bearer ${TOKEN}` },
    });
    if (!r.ok) return hit?.members || [];
    const body = await r.json() as any;
    const members = Array.isArray(body?.members) ? body.members : [];
    memberCache.set(chatId, { at: now, members });
    return members;
  } catch {
    return hit?.members || [];
  }
}

/**
 * Resolve bare `@<display_name>` tokens in outgoing message text to the
 * paren form `@<display_name>(<agent_id>)` so receiving MCP plugins'
 * regex (which requires id or paren form) actually triggers. Boss
 * 2026-04-20 pinned this as the canonical path instead of server-side
 * rewrite (avoid per-broadcast CPU cost). Longest display_name wins
 * via alternation-order in the regex — "Claude Code" beats "Claude"
 * at a shared prefix position. Noop if the channel has no members
 * with a display_name distinct from agent_id, or the text has no @.
 */
async function resolveBareMentions(chatId: string, text: string): Promise<string> {
  if (!text || !text.includes("@")) return text;
  const members = (await fetchChannelMembers(chatId))
    .filter((m) => m.agent_id && m.display_name && m.display_name !== m.agent_id);
  if (members.length === 0) return text;
  members.sort((a, b) => (b.display_name || "").length - (a.display_name || "").length);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = members.map((m) => escape(m.display_name || "")).join("|");
  const byName = new Map(members.map((m) => [m.display_name!, m.agent_id]));
  // Terminator: whitespace, Latin & CJK punctuation, or end-of-string.
  // Negative lookahead for `(` avoids rewriting already-paren'd form
  // (belt-and-suspenders; the terminator class already excludes `(`).
  const re = new RegExp("@(" + pattern + ")(?=[\\s,.!?:;，。！？：；、]|$)(?!\\()", "g");
  return text.replace(re, (match, name) => {
    const id = byName.get(name);
    return id ? `@${name}(${id})` : match;
  });
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  let { name, arguments: args } = request.params;
  let viaExtendedCompat = false;

  if (name === "list_global_skills") {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          skills: Object.entries(GLOBAL_SKILLS).map(([skill_id, skill]) => ({
            skill_id,
            title: skill.title,
            summary: skill.summary,
            loaded_by_default: skill_id === DEFAULT_GLOBAL_SKILL_ID,
          })),
        }, null, 2),
      }],
    };
  }

  if (name === "load_global_skill") {
    const { skill_id } = (args || {}) as { skill_id?: string };
    const id = skill_id || DEFAULT_GLOBAL_SKILL_ID;
    const skill = GLOBAL_SKILLS[id];
    if (!skill) {
      return { content: [{ type: "text", text: `Unknown global skill: ${id}` }] };
    }
    return {
      content: [{
        type: "text",
        text: `${skill.body}\n\nLoaded as global skill "${id}".`,
      }],
    };
  }

  if (name === "list_channel_skills") {
    const { chat_id } = (args || {}) as { chat_id?: string };
    if (!chat_id) return { content: [{ type: "text", text: "list_channel_skills failed: chat_id required" }] };
    try {
      const r = await fetch(`${REST_URL}/api/channels/${encodeURIComponent(chat_id)}/docs`, {
        headers: { "Authorization": `Bearer ${TOKEN}` },
      });
      const text = await r.text();
      if (!r.ok) {
        return { content: [{ type: "text", text: `list_channel_skills failed (${r.status}): ${text.slice(0, 200)}` }] };
      }
      const docs = extractChannelDocsPayload(JSON.parse(text)).filter(isSkillDoc).map(compactSkillDoc);
      return { content: [{ type: "text", text: JSON.stringify({ chat_id, skills: docs }, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `list_channel_skills network/parse error: ${String(e?.message || e).slice(0, 120)}` }] };
    }
  }

  if (name === "load_channel_skill") {
    const { chat_id, doc_id } = (args || {}) as { chat_id?: string; doc_id?: string };
    if (!chat_id || !doc_id) return { content: [{ type: "text", text: "load_channel_skill failed: chat_id and doc_id required" }] };
    try {
      const r = await fetch(`${REST_URL}/api/channels/${encodeURIComponent(chat_id)}/docs/${encodeURIComponent(doc_id)}`, {
        headers: { "Authorization": `Bearer ${TOKEN}` },
      });
      const text = await r.text();
      if (!r.ok) {
        return { content: [{ type: "text", text: `load_channel_skill failed (${r.status}): ${text.slice(0, 200)}` }] };
      }
      const doc = JSON.parse(text);
      const body = doc?.body_markdown ?? doc?.bodyMarkdown ?? "";
      const title = doc?.title || doc_id;
      const kind = doc?.kind || "unknown";
      const level = doc?.level ?? "?";
      const parsed = parseSkillFrontmatter(String(body));
      const metadata = { ...(parsed.metadata || {}), ...(doc?.skill_meta || doc?.skillMeta || {}) };
      const metaLines = [
        metadata.name ? `name: ${metadata.name}` : null,
        metadata.description ? `description: ${metadata.description}` : null,
        metadata.trigger ? `trigger: ${metadata.trigger}` : null,
        (metadata.argument_hint ?? metadata.argumentHint) ? `argument-hint: ${metadata.argument_hint ?? metadata.argumentHint}` : null,
      ].filter(Boolean).join("\n");
      if (!String(kind).toLowerCase().includes("skill") && !String(doc_id).toLowerCase().includes("skill")) {
        return {
          content: [{
            type: "text",
            text: `Loaded channel doc "${doc_id}" as requested, but it is not marked kind=skill.\n\n# ${title}\n\n${parsed.body}`,
          }],
        };
      }
      return {
        content: [{
          type: "text",
          text: [
            `Channel-specific skill loaded from ${chat_id}/${doc_id} (L${level}, kind=${kind}).`,
            metaLines ? `\nMetadata:\n${metaLines}` : "",
            `\n# ${title}\n\n${parsed.body}`,
          ].join("\n"),
        }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `load_channel_skill network/parse error: ${String(e?.message || e).slice(0, 120)}` }] };
    }
  }

  if (name === "list_tool_groups") {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          groups: TOOL_GROUPS.map((group) => ({
            name: group.name,
            summary: group.summary,
            tool_count: group.tools.length,
            estimated_tokens: group.estimated_tokens,
            loaded: loadedToolGroups.has(group.name),
            tags: group.tags,
          })),
        }, null, 2),
      }],
    };
  }

  if (name === "load_tool_group") {
    const { group_name } = (args || {}) as { group_name: ToolGroupName };
    const group = TOOL_GROUPS.find((item) => item.name === group_name);
    if (!group) {
      return { content: [{ type: "text", text: `Unknown tool group: ${String(group_name)}` }] };
    }
    const wasLoaded = loadedToolGroups.has(group.name);
    if (!wasLoaded) {
      loadedToolGroups.add(group.name);
      await server.sendToolListChanged();
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          group: group.name,
          loaded: true,
          changed: !wasLoaded,
          tools: group.tools,
        }, null, 2),
      }],
    };
  }

  if (name === "invoke_extended_tool") {
    const { tool_name, arguments: forwardedArgs } = (args || {}) as { tool_name?: string; arguments?: Record<string, unknown> };
    const groupName = tool_name ? TOOL_NAME_TO_GROUP.get(tool_name) : undefined;
    if (!tool_name || !groupName) {
      return { content: [{ type: "text", text: `invoke_extended_tool only supports known extended tools.` }] };
    }
    name = tool_name;
    args = forwardedArgs || {};
    viaExtendedCompat = true;
  }

  const visibleToolNames = getVisibleToolNames();
  if (!visibleToolNames.has(name) && !viaExtendedCompat) {
    const groupName = TOOL_NAME_TO_GROUP.get(name);
    if (groupName) {
      return {
        content: [{
          type: "text",
          text: `Tool "${name}" is currently hidden. Call load_tool_group("${groupName}") first, or use invoke_extended_tool as a compatibility fallback.`,
        }],
      };
    }
  }

  if (name === "reply") {
    const { chat_id, text: rawText } = args as { chat_id: string; text: string };
    // Order: resolve bare @<display_name> to paren form FIRST (so the
    // receiving MCP plugin's regex triggers), then redact secrets so
    // an accidental `ac_xxx` in the text gets masked regardless of
    // how it arrived.
    const text = redactSecrets(await resolveBareMentions(chat_id, rawText));
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
    return { content: [{ type: "text", text: "Typing indicator dispatched" }] };
  }

  if (name === "react") {
    const { chat_id, message_id, emoji, action } = args as any;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "reaction", message_id, channel_id: chat_id,
        sender_id: AGENT_ID, emoji, action: action || "add",
        timestamp: new Date().toISOString(),
      }));
      return { content: [{ type: "text", text: `${action === "remove" ? "Removal" : "Addition"} of ${emoji} dispatched; verify in channel` }] };
    }
    return { content: [{ type: "text", text: "Not connected" }] };
  }

  if (name === "thread_reply") {
    const { chat_id, parent_id, text: rawText } = args as any;
    const text = redactSecrets(await resolveBareMentions(chat_id, rawText));
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "thread_reply", id: crypto.randomUUID(), parent_id,
        channel_id: chat_id, sender_id: AGENT_ID, sender_type: "agent",
        content: text, timestamp: new Date().toISOString(),
      }));
      return { content: [{ type: "text", text: `Thread reply dispatched; verify in channel` }] };
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
      return { content: [{ type: "text", text: `${action === "unpin" ? "Unpin" : "Pin"} dispatched; server may reject (admin only)` }] };
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
      return { content: [{ type: "text", text: "Edit dispatched; server may reject (must be original sender, within edit window)" }] };
    }
    return { content: [{ type: "text", text: "Not connected" }] };
  }

  if (name === "delete_message") {
    const { chat_id, message_id } = args as any;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "delete_message", message_id, channel_id: chat_id, sender_id: AGENT_ID,
      }));
      return { content: [{ type: "text", text: "Delete dispatched; server may reject (must be original sender)" }] };
    }
    return { content: [{ type: "text", text: "Not connected" }] };
  }

  if (name === "set_status") {
    const { status_text, status_emoji } = args as any;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "set_status", sender_id: AGENT_ID, status_text, status_emoji,
      }));
      return { content: [{ type: "text", text: `Status update dispatched: ${status_emoji || ''} ${status_text}` }] };
    }
    return { content: [{ type: "text", text: "Not connected" }] };
  }

  if (name === "archive_channel") {
    const { chat_id } = args as any;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "archive_channel", channel_id: chat_id, sender_id: AGENT_ID }));
      return { content: [{ type: "text", text: `Archive dispatched; server may reject (admin only — channel goes read-only on success)` }] };
    }
    return { content: [{ type: "text", text: "Not connected" }] };
  }

  if (name === "report_message") {
    const { chat_id, message_id, reason_code, free_text } = args as {
      chat_id: string;
      message_id: string;
      reason_code: "spam" | "phishing" | "harassment" | "impersonation" | "illegal" | "other";
      free_text?: string;
    };
    try {
      const r = await fetch(`${REST_URL}/api/moderation/report`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({
          channel_id: chat_id,
          message_id,
          reason_code,
          ...(typeof free_text === "string" && free_text.trim() ? { free_text: free_text.trim().slice(0, 500) } : {}),
        }),
      });
      const text = await r.text();
      if (!r.ok) {
        return { content: [{ type: "text", text: `report_message failed (${r.status}): ${text.slice(0, 240)}` }] };
      }
      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `report_message network error: ${String(e?.message || e).slice(0, 120)}` }] };
    }
  }

  if (name === "list_my_moderation_history") {
    const { agent_id } = args as { agent_id?: string };
    const qs = new URLSearchParams();
    if (agent_id) qs.set("agent_id", agent_id);
    try {
      const r = await fetch(`${REST_URL}/api/me/moderation_history${qs.toString() ? `?${qs.toString()}` : ""}`, {
        headers: { "Authorization": `Bearer ${TOKEN}` },
      });
      const text = await r.text();
      if (!r.ok) {
        return { content: [{ type: "text", text: `list_my_moderation_history failed (${r.status}): ${text.slice(0, 240)}` }] };
      }
      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `list_my_moderation_history network error: ${String(e?.message || e).slice(0, 120)}` }] };
    }
  }

  if (name === "list_reports_i_submitted") {
    const { limit = 20 } = args as { limit?: number };
    const capped = Math.max(1, Math.min(Number(limit) || 20, 100));
    try {
      const r = await fetch(`${REST_URL}/api/me/reports_submitted?limit=${capped}`, {
        headers: { "Authorization": `Bearer ${TOKEN}` },
      });
      const text = await r.text();
      if (!r.ok) {
        return { content: [{ type: "text", text: `list_reports_i_submitted failed (${r.status}): ${text.slice(0, 240)}` }] };
      }
      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `list_reports_i_submitted network error: ${String(e?.message || e).slice(0, 120)}` }] };
    }
  }

  if (name === "set_topic") {
    const { chat_id, topic } = args as any;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "set_topic", channel_id: chat_id, sender_id: AGENT_ID, topic }));
      return { content: [{ type: "text", text: `Topic update dispatched; server may reject (admin only): ${topic.slice(0,50)}` }] };
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
      return { content: [{ type: "text", text: `Forward dispatched to ${target_channel_id.slice(0,8)}; server may reject (must be member of both channels)` }] };
    }
    return { content: [{ type: "text", text: "Not connected" }] };
  }

  if (name === "search") {
    const { query, channel_id } = args as any;
    try {
      const params = new URLSearchParams({ q: query, limit: "20" });
      if (channel_id) params.set("channel_id", channel_id);
      const r = await fetch(`${REST_URL}/api/search?${params}`, { headers: { "Authorization": `Bearer ${TOKEN}` } });
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
      return { content: [{ type: "text", text: `Vote '${decision}' dispatched for proposal ${proposal_id.slice(0, 8)}; server may reject (invalid proposal_id or expired)` }] };
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
      return { content: [{ type: "text", text: `Proposal '${title}' dispatched (client-generated ID ${proposalId.slice(0, 8)}); server may reject — verify via next inbound event` }] };
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
      const r = await fetch(`${REST_URL}/api/channels/${encodeURIComponent(chat_id)}/members`, { headers: { "Authorization": `Bearer ${TOKEN}` } });
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

  if (name === "leave_channel") {
    const { chat_id } = args as any;
    // Prefer REST /leave (authoritative HTTP response confirms eviction);
    // fall through to WS leave_channel if REST is unreachable so existing
    // server-side WS handler still fires and updates in-memory state.
    try {
      const r = await fetch(`${REST_URL}/api/channels/${encodeURIComponent(chat_id)}/leave`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: "{}",
      });
      if (r.ok) {
        const data = await r.json().catch(() => ({})) as any;
        if (data.note === "not a member") {
          return { content: [{ type: "text", text: `Already not a member of ${chat_id.slice(0, 8)}` }] };
        }
        return { content: [{ type: "text", text: `Left channel ${chat_id.slice(0, 8)}` }] };
      }
      if (r.status === 404) {
        return { content: [{ type: "text", text: `Channel ${chat_id.slice(0, 8)} not found` }] };
      }
      return { content: [{ type: "text", text: `Leave failed with status ${r.status}` }] };
    } catch (e: any) {
      // REST unreachable — fall back to WS leave so at least in-memory state updates
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: "leave_channel", channel_id: chat_id, agent_id: AGENT_ID })); } catch {}
        return { content: [{ type: "text", text: `Leave sent via WS (REST unreachable: ${String(e?.message || e).slice(0, 60)})` }] };
      }
      return { content: [{ type: "text", text: `Leave failed — no connectivity` }] };
    }
  }

  // ── Hidden Identity (谁是卧底) ────────────────────────────────────
  // See docs/MCP-HIDDEN-IDENTITY-SCHEMA.md + spec/hidden-identity.md.
  // Agents playing the game need tool access to join / fetch secret /
  // vote / advance / inspect state. Without these, the game is driven
  // only by humans and bots become decorative. These wrap the server
  // REST endpoints 1:1; the dispatcher at spec/schema §WS broadcasts
  // tells the agent _when_ to call (via meta on channel notifications).

  if (name === "hidden_identity_join") {
    const { game_id } = args as any;
    try {
      const r = await fetch(`${REST_URL}/api/hidden-identity/games/${encodeURIComponent(game_id)}/join`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await r.json().catch(() => ({})) as any;
      if (r.ok) {
        const channelId = data?.game?.channel_id || data?.game?.channelId || await fetchHiddenIdentityChannelId(game_id);
        if (typeof channelId === "string") activateHiddenIdentityGame(game_id, channelId);
        const count = data?.game?.player_ids?.length ?? data?.game?.players?.length ?? "?";
        const activeNote = channelId ? ` HI active mode enabled for channel ${String(channelId).slice(0, 8)}.` : "";
        return { content: [{ type: "text", text: `Joined game ${String(game_id).slice(0, 8)} — ${count} players in lobby.${activeNote}` }] };
      }
      return { content: [{ type: "text", text: `Join failed (${r.status}): ${String(data?.error || "").slice(0, 120)}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Join failed: ${String(e?.message || e).slice(0, 80)}` }] };
    }
  }

  if (name === "hidden_identity_get_secret") {
    const { game_id } = args as any;
    try {
      const r = await fetch(`${REST_URL}/api/hidden-identity/games/${encodeURIComponent(game_id)}/secret`, {
        headers: { "Authorization": `Bearer ${TOKEN}` },
      });
      const data = await r.json().catch(() => ({})) as any;
      if (r.ok) {
        const myPlayerId = data.my_player_id || data.myPlayerId || AGENT_ID;
        const roster = Array.isArray(data.roster) ? data.roster : [];
        const rosterText = roster.length
          ? roster.map((p: any) => {
              const playerId = p.player_id || p.playerId || p.id || "?";
              const agentId = p.agent_id || p.agentId || playerId;
              const displayName = p.display_name || p.displayName || agentId;
              return `- ${displayName}: player_id=${playerId}, agent_id=${agentId}`;
            }).join("\n")
          : "- roster unavailable";
        return {
          content: [{
            type: "text",
            text: [
              `Your role: ${data.role}. Your word: ${data.word}.`,
              `Your player_id: ${myPlayerId}.`,
              "Roster for voting:",
              rosterText,
              "Do NOT reveal the word directly in discussion — describe it.",
            ].join("\n"),
          }],
        };
      }
      if (r.status === 403) return { content: [{ type: "text", text: `You are not a player in this game (403)` }] };
      if (r.status === 404) return { content: [{ type: "text", text: `Game or secret not allocated yet (game may still be in lobby)` }] };
      return { content: [{ type: "text", text: `Secret fetch failed (${r.status})` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Secret fetch failed: ${String(e?.message || e).slice(0, 80)}` }] };
    }
  }

  if (name === "hidden_identity_vote") {
    const { game_id, target_id, reason } = args as any;
    try {
      const body: any = { target_id };
      if (typeof reason === "string" && reason) body.reason = reason;
      const r = await fetch(`${REST_URL}/api/hidden-identity/games/${encodeURIComponent(game_id)}/vote`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({})) as any;
      if (r.ok) {
        return { content: [{ type: "text", text: `Vote cast against ${String(target_id).slice(0, 12)} in round ${data?.round}` }] };
      }
      return { content: [{ type: "text", text: `Vote failed (${r.status}): ${String(data?.error || "").slice(0, 120)}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Vote failed: ${String(e?.message || e).slice(0, 80)}` }] };
    }
  }

  if (name === "hidden_identity_advance") {
    const { game_id, to } = args as any;
    try {
      const r = await fetch(`${REST_URL}/api/hidden-identity/games/${encodeURIComponent(game_id)}/advance`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ to }),
      });
      const data = await r.json().catch(() => ({})) as any;
      if (r.ok) {
        return { content: [{ type: "text", text: `Phase advanced to ${data?.phase || to}, round ${data?.round ?? "?"}` }] };
      }
      if (r.status === 409) return { content: [{ type: "text", text: `Invalid transition to ${to} (409): ${String(data?.error || "").slice(0, 120)}` }] };
      return { content: [{ type: "text", text: `Advance failed (${r.status}): ${String(data?.error || "").slice(0, 120)}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Advance failed: ${String(e?.message || e).slice(0, 80)}` }] };
    }
  }

  if (name === "hidden_identity_get_state") {
    const { game_id } = args as any;
    try {
      const r = await fetch(`${REST_URL}/api/hidden-identity/games/${encodeURIComponent(game_id)}`, {
        headers: { "Authorization": `Bearer ${TOKEN}` },
      });
      const data = await r.json().catch(() => ({})) as any;
      if (r.ok) {
        const g = data?.game || {};
        const players = (g.players || []).map((p: any) => {
          return `${p.display_name || p.player_id}${p.is_eliminated ? " (out)" : ""}`;
        }).join(", ");
        return { content: [{ type: "text", text: `Phase: ${g.phase}, Round: ${g.round}, Winner: ${g.winner_team || "—"}. Players: ${players}` }] };
      }
      return { content: [{ type: "text", text: `Game state fetch failed (${r.status})` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Game state fetch failed: ${String(e?.message || e).slice(0, 80)}` }] };
    }
  }

  if (name === "mark_read") {
    const { chat_id, last_read_id } = args as any;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "read_receipt", channel_id: chat_id,
        sender_id: AGENT_ID, last_read_id, timestamp: new Date().toISOString(),
      }));
      return { content: [{ type: "text", text: `Read cursor update dispatched (up to ${last_read_id.slice(0, 8)})` }] };
    }
    return { content: [{ type: "text", text: "Not connected" }] };
  }

  if (name === "whoami") {
    const wsState = ws?.readyState === WebSocket.OPEN ? "connected" : ws?.readyState === WebSocket.CONNECTING ? "connecting" : "disconnected";
    let healthLine = "REST health: unknown";
    let authLine = "REST auth: unknown";
    try {
      const r = await fetch(`${REST_URL}/health`);
      if (r.ok) {
        const h = await r.json() as any;
        const build = h?.build ? ` build=${h.build}` : "";
        const redis = h?.redis ? ` redis=${h.redis}` : "";
        healthLine = `REST health: ok${build}${redis}`;
      } else {
        healthLine = `REST health: failed (${r.status})`;
      }
    } catch (e: any) {
      healthLine = `REST health: error (${String(e?.message || e).slice(0, 80)})`;
    }
    try {
      const r = await fetch(`${REST_URL}/api/account/${encodeURIComponent(AGENT_ID)}`, {
        headers: TOKEN ? { "Authorization": `Bearer ${TOKEN}` } : {},
      });
      authLine = r.ok ? "REST auth: ok" : `REST auth: failed (${r.status})`;
    } catch (e: any) {
      authLine = `REST auth: error (${String(e?.message || e).slice(0, 80)})`;
    }
    return { content: [{ type: "text", text: `Profile: ${profile.display_name || AGENT_ID}\nAgent ID: ${AGENT_ID}\nServer: ${REST_URL}\nWebSocket: ${wsState}${sessionId ? `\nSession: ${sessionId.slice(0, 12)}...` : ""}\n${healthLine}\n${authLine}\nCapabilities: ${CAPABILITIES.join(", ")}\nProfile file: ${profileFile}` }] };
  }

  if (name === "list_channels") {
    const { limit = 50 } = args as any;
    try {
      const r = await fetch(`${REST_URL}/api/channels/discover?limit=${Math.min(limit, 500)}`, { headers: { "Authorization": `Bearer ${TOKEN}` } });
      if (r.ok) {
        const data = await r.json() as any;
        const channels = (data.channels || []);
        if (channels.length === 0) return { content: [{ type: "text", text: "No public channels found." }] };
        const list = channels.map((ch: any) => `• ${ch.name || ch.id} (${ch.id.slice(0, 8)}) — ${ch.member_count || "?"} members${ch.topic ? ` — ${ch.topic.slice(0, 60)}` : ""}`).join("\n");
        return { content: [{ type: "text", text: `${channels.length} channels:\n${list}` }] };
      }
      return { content: [{ type: "text", text: `Failed to list channels (${r.status})` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e}` }] };
    }
  }

  if (name === "find_dm") {
    const { target_agent_id } = args as any;
    if (!target_agent_id || typeof target_agent_id !== "string") {
      return { content: [{ type: "text", text: "Error: target_agent_id required" }] };
    }
    if (target_agent_id === AGENT_ID) {
      return { content: [{ type: "text", text: JSON.stringify({ chat_id: null, reason: "cannot DM yourself" }) }] };
    }
    try {
      // /api/channels/mine returns the caller's joined channels (including
      // DMs). DM channel ids are deterministic on iOS but the source of
      // truth for "does this DM exist between us" is server membership,
      // so we list + filter rather than replay the hash.
      const r = await fetch(`${REST_URL}/api/channels/mine`, {
        headers: { "Authorization": `Bearer ${TOKEN}` },
      });
      if (!r.ok) {
        return { content: [{ type: "text", text: `Failed (${r.status})` }] };
      }
      const data = await r.json() as any;
      const channels = Array.isArray(data?.channels) ? data.channels : [];
      // /mine returns metadata but not member rosters; need a per-channel
      // members fetch only for the type=direct candidates.
      for (const ch of channels) {
        if (ch?.type !== "direct") continue;
        try {
          const mr = await fetch(`${REST_URL}/api/channels/${encodeURIComponent(ch.id)}/members`, {
            headers: { "Authorization": `Bearer ${TOKEN}` },
          });
          if (!mr.ok) continue;
          const md = await mr.json() as any;
          const memberIds = (md?.members || []).map((m: any) => m?.agent_id).filter(Boolean);
          if (memberIds.length === 2 && memberIds.includes(AGENT_ID) && memberIds.includes(target_agent_id)) {
            return { content: [{ type: "text", text: JSON.stringify({ chat_id: ch.id, name: ch.name || null }) }] };
          }
        } catch {}
      }
      return { content: [{ type: "text", text: JSON.stringify({ chat_id: null }) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${String(e?.message || e).slice(0, 120)}` }] };
    }
  }

  if (name === "list_members") {
    const { chat_id } = args as any;
    try {
      const r = await fetch(`${REST_URL}/api/channels/${encodeURIComponent(chat_id)}/members`, { headers: { "Authorization": `Bearer ${TOKEN}` } });
      if (r.ok) {
        const data = await r.json() as any;
        const members = data.members || [];
        if (members.length === 0) return { content: [{ type: "text", text: "No members found." }] };
        const list = members.map((m: any) => `• ${m.display_name || m.agent_id} (${m.agent_id.slice(0, 12)})${m.role ? ` [${m.role}]` : ""}`).join("\n");
        return { content: [{ type: "text", text: `${members.length} members in ${chat_id.slice(0, 8)}:\n${list}` }] };
      }
      return { content: [{ type: "text", text: `Failed to list members (${r.status})` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e}` }] };
    }
  }

  if (name === "get_history") {
    const { chat_id, limit = 20 } = args as any;
    try {
      const r = await fetch(`${REST_URL}/api/channels/${encodeURIComponent(chat_id)}/messages?limit=${Math.min(limit, 100)}`, { headers: { "Authorization": `Bearer ${TOKEN}` } });
      if (r.ok) {
        const data = await r.json() as any;
        const msgs = (data.messages || []).filter((m: any) => m.content !== "__typing__");
        if (msgs.length === 0) return { content: [{ type: "text", text: "No messages in this channel." }] };
        const list = msgs.map((m: any) => {
          const time = m.timestamp ? new Date(m.timestamp).toLocaleString() : "?";
          return `[${time}] ${m.sender_id?.slice(0, 12)}: ${m.content?.slice(0, 200)}`;
        }).join("\n");
        return { content: [{ type: "text", text: `${msgs.length} messages:\n${list}` }] };
      }
      return { content: [{ type: "text", text: `Failed to get history (${r.status})` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e}` }] };
    }
  }

  if (name === "switch_profile") {
    const { profile_name } = args as any;
    // List available profiles
    const { readdirSync } = require("fs");
    let files: string[] = [];
    try { files = readdirSync(configDir).filter((f: string) => f.endsWith(".json")); } catch {}
    const available = files.map((f: string) => f.replace(".json", ""));

    if (!profile_name) {
      const current = AGENT_ID;
      const list = available.map(p => `${p === current ? "→ " : "  "}${p}`).join("\n");
      return { content: [{ type: "text", text: `Current: ${current}\nAvailable profiles:\n${list}` }] };
    }

    // Find and load the profile
    const targetFile = nameToPath(profile_name);
    if (!existsSync(targetFile)) {
      return { content: [{ type: "text", text: `Profile "${profile_name}" not found. Available: ${available.join(", ")}` }] };
    }

    const newProfile = JSON.parse(readFileSync(targetFile, "utf-8"));

    // Stop heartbeat first to prevent race with old connection
    heartbeat.stop();

    // Close old connection, disable its reconnect handler
    if (ws) {
      ws.onclose = null;
      try { ws.close(); } catch {}
      ws = null;
    }
    sessionId = null;

    // Update identity
    AGENT_ID = newProfile.agent_id;
    TOKEN = newProfile.token || "dev-token";
    CAPABILITIES = newProfile.capabilities || ["claude-code", "coding", "chat"];
    profile = newProfile;

    // Restart heartbeat and connect with new identity
    wsReconnectAttempt = 0;
    heartbeat.start();
    connectWS();

    return { content: [{ type: "text", text: `Switched to profile "${profile_name}" (${AGENT_ID}). Reconnecting...` }] };
  }

  if (name === "list_channel_docs") {
    const { chat_id, level } = args as { chat_id: string; level?: number | string };
    const qs = new URLSearchParams();
    const normalizedLevel = normalizeChannelDocLevel(level);
    if (level !== undefined && normalizedLevel === null) {
      return { content: [{ type: "text", text: "list_channel_docs failed: level must be 1|2|3|4" }] };
    }
    if (normalizedLevel !== null) qs.set("level", String(normalizedLevel));
    const url = `${REST_URL}/api/channels/${encodeURIComponent(chat_id)}/docs${qs.toString() ? `?${qs}` : ""}`;
    try {
      const r = await fetch(url, { headers: { "Authorization": `Bearer ${TOKEN}` } });
      const text = await r.text();
      if (!r.ok) {
        return { content: [{ type: "text", text: `list_channel_docs failed (${r.status}): ${text.slice(0, 200)}` }] };
      }
      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `list_channel_docs network error: ${String(e?.message || e).slice(0, 120)}` }] };
    }
  }

  if (name === "get_channel_doc") {
    const { chat_id, doc_id } = args as { chat_id: string; doc_id: string };
    try {
      const r = await fetch(`${REST_URL}/api/channels/${encodeURIComponent(chat_id)}/docs/${encodeURIComponent(doc_id)}`, {
        headers: { "Authorization": `Bearer ${TOKEN}` },
      });
      const text = await r.text();
      if (!r.ok) {
        return { content: [{ type: "text", text: `get_channel_doc failed (${r.status}): ${text.slice(0, 200)}` }] };
      }
      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `get_channel_doc network error: ${String(e?.message || e).slice(0, 120)}` }] };
    }
  }

  if (name === "upsert_channel_doc") {
    const { chat_id, doc_id, title, kind, level, body_markdown, expected_version } = args as {
      chat_id: string;
      doc_id: string;
      title: string;
      kind: string;
      level: number | string;
      body_markdown: string;
      expected_version: number;
    };
    const normalizedLevel = normalizeChannelDocLevel(level);
    if (normalizedLevel === null) {
      return { content: [{ type: "text", text: "upsert_channel_doc failed: level must be 1|2|3|4" }] };
    }
    try {
      const r = await fetch(`${REST_URL}/api/channels/${encodeURIComponent(chat_id)}/docs/${encodeURIComponent(doc_id)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${TOKEN}`,
          "If-Match": String(expected_version),
        },
        body: JSON.stringify({ title, kind, level: normalizedLevel, body_markdown }),
      });
      const text = await r.text();
      if (!r.ok) {
        return { content: [{ type: "text", text: `upsert_channel_doc failed (${r.status}): ${text.slice(0, 240)}` }] };
      }
      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `upsert_channel_doc network error: ${String(e?.message || e).slice(0, 120)}` }] };
    }
  }

  if (name === "list_channel_doc_revisions") {
    const { chat_id, doc_id } = args as { chat_id: string; doc_id: string };
    try {
      const r = await fetch(`${REST_URL}/api/channels/${encodeURIComponent(chat_id)}/docs/${encodeURIComponent(doc_id)}/revisions`, {
        headers: { "Authorization": `Bearer ${TOKEN}` },
      });
      const text = await r.text();
      if (!r.ok) {
        return { content: [{ type: "text", text: `list_channel_doc_revisions failed (${r.status}): ${text.slice(0, 200)}` }] };
      }
      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `list_channel_doc_revisions network error: ${String(e?.message || e).slice(0, 120)}` }] };
    }
  }

  // OKR v0.1 tools — dogfood the OKR system without dropping to curl.
  // Maps 1:1 to the server-side routes shipped in commit 5229aab
  // (projects/AgentChat/Server/src/okr.ts + index.ts dispatch block).
  if (name === "okr_list") {
    const { owner, status, horizon, include_archived, view, task_id } = args as { owner?: string; status?: string; horizon?: string; include_archived?: boolean; view?: string; task_id?: string };
    const qs = new URLSearchParams();
    if (owner) qs.set("owner", owner);
    if (status) qs.set("status", status);
    if (horizon) qs.set("horizon", horizon);
    if (include_archived) qs.set("include_archived", "true");
    if (view) qs.set("view", view);
    if (task_id) qs.set("task_id", task_id);
    const url = `${REST_URL}/api/okr/objectives${qs.toString() ? "?" + qs.toString() : ""}`;
    try {
      const r = await fetch(url, { headers: { "Authorization": `Bearer ${TOKEN}` } });
      if (!r.ok) {
        const err = await r.text();
        return { content: [{ type: "text", text: `okr_list failed (${r.status}): ${err.slice(0, 120)}` }] };
      }
      const data = await r.json() as any;
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `okr_list network error: ${String(e?.message || e).slice(0, 120)}` }] };
    }
  }

  if (name === "okr_create_objective") {
    const { title, horizon, owner, parent_id, due, discussion_channel_id } = args as {
      title: string; horizon: string; owner?: string; parent_id?: string; due?: string; discussion_channel_id?: string;
    };
    const body: Record<string, unknown> = { title, horizon };
    if (owner) body.owner = owner;
    if (parent_id) body.parent_id = parent_id;
    if (due) body.due = due;
    if (discussion_channel_id) body.discussion_channel_id = discussion_channel_id;
    try {
      const r = await fetch(`${REST_URL}/api/okr/objectives`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TOKEN}` },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      if (!r.ok) {
        return { content: [{ type: "text", text: `okr_create_objective failed (${r.status}): ${text.slice(0, 160)}` }] };
      }
      return { content: [{ type: "text", text: `Created: ${text}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `okr_create_objective network error: ${String(e?.message || e).slice(0, 120)}` }] };
    }
  }

  if (name === "okr_add_task") {
    const { objective_id, title, assignee, contributes_to, depends_on, due } = args as {
      objective_id: string; title: string; assignee: string; contributes_to?: string[]; depends_on?: string[]; due?: string;
    };
    const body: Record<string, unknown> = { title, assignee };
    if (Array.isArray(contributes_to) && contributes_to.length > 0) body.contributes_to = contributes_to;
    if (Array.isArray(depends_on) && depends_on.length > 0) body.depends_on = depends_on;
    if (due) body.due = due;
    try {
      const r = await fetch(`${REST_URL}/api/okr/objectives/${encodeURIComponent(objective_id)}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TOKEN}` },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      if (!r.ok) {
        return { content: [{ type: "text", text: `okr_add_task failed (${r.status}): ${text.slice(0, 160)}` }] };
      }
      return { content: [{ type: "text", text: `Added: ${text}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `okr_add_task network error: ${String(e?.message || e).slice(0, 120)}` }] };
    }
  }

  if (name === "okr_update_task") {
    const { task_id, status, assignee, blocked_reason, blocker_agent, depends_on, due } = args as { task_id: string; status?: string; assignee?: string; blocked_reason?: string; blocker_agent?: string; depends_on?: string[]; due?: string };
    const patch: Record<string, unknown> = {};
    if (status) patch.status = status;
    if (assignee) patch.assignee = assignee;
    if (blocked_reason !== undefined) patch.blocked_reason = blocked_reason;
    if (blocker_agent !== undefined) patch.blocker_agent = blocker_agent;
    if (Array.isArray(depends_on)) patch.depends_on = depends_on;
    if (due) patch.due = due;
    try {
      const r = await fetch(`${REST_URL}/api/okr/tasks/${encodeURIComponent(task_id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TOKEN}` },
        body: JSON.stringify(patch),
      });
      const text = await r.text();
      if (!r.ok) {
        return { content: [{ type: "text", text: `okr_update_task failed (${r.status}): ${text.slice(0, 160)}` }] };
      }
      return { content: [{ type: "text", text: `Updated: ${text}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `okr_update_task network error: ${String(e?.message || e).slice(0, 120)}` }] };
    }
  }

  if (name === "okr_task_blockers" || name === "okr_task_blocks") {
    const { task_id } = args as { task_id: string };
    const path = name === "okr_task_blockers" ? "blockers" : "blocks";
    try {
      const r = await fetch(`${REST_URL}/api/okr/tasks/${encodeURIComponent(task_id)}/${path}`, {
        headers: { "Authorization": `Bearer ${TOKEN}` },
      });
      const text = await r.text();
      if (!r.ok) {
        return { content: [{ type: "text", text: `${name} failed (${r.status}): ${text.slice(0, 160)}` }] };
      }
      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `${name} network error: ${String(e?.message || e).slice(0, 120)}` }] };
    }
  }

  if (name === "okr_open_thread") {
    const { target_type, target_id } = args as { target_type: string; target_id: string };
    try {
      const r = await fetch(`${REST_URL}/api/okr/threads`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TOKEN}` },
        body: JSON.stringify({ target_type, target_id }),
      });
      const text = await r.text();
      if (!r.ok) {
        return { content: [{ type: "text", text: `okr_open_thread failed (${r.status}): ${text.slice(0, 160)}` }] };
      }
      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `okr_open_thread network error: ${String(e?.message || e).slice(0, 120)}` }] };
    }
  }

  if (name === "okr_add_kr") {
    const { objective_id, title, metric_type, current, target, risk_level } = args as {
      objective_id: string; title: string; metric_type: string; current?: number; target: number; risk_level?: string;
    };
    const body: Record<string, unknown> = { title, metric_type, target };
    if (typeof current === "number") body.current = current;
    if (risk_level) body.risk_level = risk_level;
    try {
      const r = await fetch(`${REST_URL}/api/okr/objectives/${encodeURIComponent(objective_id)}/krs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TOKEN}` },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      if (!r.ok) {
        return { content: [{ type: "text", text: `okr_add_kr failed (${r.status}): ${text.slice(0, 160)}` }] };
      }
      return { content: [{ type: "text", text: `Added: ${text}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `okr_add_kr network error: ${String(e?.message || e).slice(0, 120)}` }] };
    }
  }

  if (name === "archive_objective") {
    const { objective_id, completion_summary } = args as { objective_id: string; completion_summary?: string };
    try {
      const r = await fetch(`${REST_URL}/api/okr/objectives/${encodeURIComponent(objective_id)}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TOKEN}` },
        body: JSON.stringify(completion_summary !== undefined ? { completion_summary } : {}),
      });
      const text = await r.text();
      if (!r.ok) {
        return { content: [{ type: "text", text: `archive_objective failed (${r.status}): ${text.slice(0, 200)}` }] };
      }
      return { content: [{ type: "text", text: `Archived: ${text}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `archive_objective network error: ${String(e?.message || e).slice(0, 120)}` }] };
    }
  }

  if (name === "unarchive_objective") {
    const { objective_id } = args as { objective_id: string };
    try {
      const r = await fetch(`${REST_URL}/api/okr/objectives/${encodeURIComponent(objective_id)}/unarchive`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TOKEN}` },
      });
      const text = await r.text();
      if (!r.ok) {
        return { content: [{ type: "text", text: `unarchive_objective failed (${r.status}): ${text.slice(0, 200)}` }] };
      }
      return { content: [{ type: "text", text: `Unarchived: ${text}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `unarchive_objective network error: ${String(e?.message || e).slice(0, 120)}` }] };
    }
  }

  if (name === "okr_set_kr_progress") {
    const { kr_id, current, risk_level } = args as { kr_id: string; current: number; risk_level?: string };
    const body: Record<string, unknown> = { current };
    if (risk_level) body.risk_level = risk_level;
    try {
      const r = await fetch(`${REST_URL}/api/okr/krs/${encodeURIComponent(kr_id)}/progress`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TOKEN}` },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      if (!r.ok) {
        return { content: [{ type: "text", text: `okr_set_kr_progress failed (${r.status}): ${text.slice(0, 160)}` }] };
      }
      return { content: [{ type: "text", text: `Updated: ${text}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `okr_set_kr_progress network error: ${String(e?.message || e).slice(0, 120)}` }] };
    }
  }

  if (name === "okr_add_task_comment") {
    const { task_id, text: rawText } = args as { task_id: string; text: string };
    const text = redactSecrets(rawText);
    try {
      const r = await fetch(`${REST_URL}/api/okr/tasks/${encodeURIComponent(task_id)}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TOKEN}` },
        body: JSON.stringify({ text }),
      });
      const body = await r.text();
      if (!r.ok) {
        return { content: [{ type: "text", text: `okr_add_task_comment failed (${r.status}): ${body.slice(0, 160)}` }] };
      }
      return { content: [{ type: "text", text: `Commented: ${body}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `okr_add_task_comment network error: ${String(e?.message || e).slice(0, 120)}` }] };
    }
  }

  if (name === "okr_set_links") {
    const { target_type, target_id, narrative, narrative_path, discussion_channel_id, linked_docs, linked_channel_docs } = args as {
      target_type: "objective" | "kr" | "task";
      target_id: string;
      narrative?: string;
      narrative_path?: string;
      discussion_channel_id?: string;
      linked_docs?: string[];
      linked_channel_docs?: Array<{ channel_id: string; doc_id: string }>;
    };
    const body: Record<string, unknown> = {};
    if (narrative !== undefined) body.narrative = narrative;
    if (narrative_path !== undefined) body.narrative_path = narrative_path;
    if (discussion_channel_id !== undefined) body.discussion_channel_id = discussion_channel_id;
    if (linked_docs !== undefined) body.linked_docs = linked_docs;
    if (linked_channel_docs !== undefined) body.linked_channel_docs = linked_channel_docs;
    try {
      const r = await fetch(`${REST_URL}/api/okr/links/${encodeURIComponent(target_type)}/${encodeURIComponent(target_id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TOKEN}` },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      if (!r.ok) {
        return { content: [{ type: "text", text: `okr_set_links failed (${r.status}): ${text.slice(0, 200)}` }] };
      }
      return { content: [{ type: "text", text: `Updated: ${text}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `okr_set_links network error: ${String(e?.message || e).slice(0, 120)}` }] };
    }
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
});

// --- WebSocket Connection ---

// Track last @mention timestamp per channel (for context windowing)
// Persisted to disk so reconnect/restart doesn't lose state
const mentionTsFile = join(configDir, `mention-ts-${AGENT_ID}.json`);
function loadMentionTimestamps(): Map<string, string> {
  try {
    const raw = require("fs").readFileSync(mentionTsFile, "utf-8");
    return new Map(Object.entries(JSON.parse(raw)));
  } catch { return new Map(); }
}
function saveMentionTimestamps(m: Map<string, string>) {
  try {
    require("fs").writeFileSync(mentionTsFile, JSON.stringify(Object.fromEntries(m)));
  } catch {}
}
const lastMentionTimestamp = loadMentionTimestamps();

// Task #119: track the last-seen message timestamp per channel so a
// reconnect can backfill messages the WS missed. Separate from
// mention-ts because mention-ts only advances on mentions — we need
// all messages (including non-mention ones) to compute the correct
// backfill cursor. Persisted to disk: plugin restart resumes from
// where it left off.
//
// Bug this fixes: even without a visible WS disconnect, Redis
// ac:ch:* subscribe can briefly miss a broadcast (subscriber rebuild
// window, transient network hiccup). Claude Code log 2026-04-20
// 12:49 showed boss's @-mention never firing notifications/claude/
// channel for claude-code-live even though my gcloud had no
// disconnect event — so the "reconnect" trigger alone doesn't
// cover this class. Backfill runs on every auth_ok whether first
// connect or reconnect; if we missed anything, we find it.
const lastSeenMessageTsFile = join(configDir, `last-seen-msg-ts-${AGENT_ID}.json`);
function loadLastSeenMessageTs(): Map<string, string> {
  try {
    const raw = require("fs").readFileSync(lastSeenMessageTsFile, "utf-8");
    return new Map(Object.entries(JSON.parse(raw)));
  } catch { return new Map(); }
}
function saveLastSeenMessageTs(m: Map<string, string>) {
  try {
    require("fs").writeFileSync(lastSeenMessageTsFile, JSON.stringify(Object.fromEntries(m)));
  } catch {}
}
const lastSeenMessageTs = loadLastSeenMessageTs();

function normalizeTimestampForCursor(ts: string | undefined, mode: "before" | "after"): string | undefined {
  if (!ts || typeof ts !== "string") return ts;
  const m = ts.match(/^(.*\.)(\d+)(Z)$/);
  if (!m) return ts;
  const frac = m[2];
  if (frac.length >= 9) return ts;
  const padChar = mode === "before" ? "9" : "0";
  return m[1] + frac + padChar.repeat(9 - frac.length) + m[3];
}

function normalizeChannelDocLevel(level: unknown): number | null {
  if (typeof level === "number" && Number.isInteger(level) && level >= 1 && level <= 4) {
    return level;
  }
  if (typeof level === "string") {
    const m = level.trim().match(/^(?:L)?([1-4])$/i);
    if (m) return Number(m[1]);
  }
  return null;
}

function extractChannelDocsPayload(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.docs)) return payload.docs;
  if (Array.isArray(payload?.channel_docs)) return payload.channel_docs;
  return [];
}

function isSkillDoc(doc: any): boolean {
  const kind = String(doc?.kind || "").toLowerCase();
  const id = String(doc?.id || doc?.doc_id || "").toLowerCase();
  const title = String(doc?.title || "").toLowerCase();
  return kind === "skill" || kind === "channel_skill" || id.includes("skill") || title.includes("skill");
}

function compactSkillDoc(doc: any) {
  const meta = doc?.skill_meta || doc?.skillMeta || {};
  return {
    doc_id: doc?.id ?? doc?.doc_id,
    title: doc?.title,
    kind: doc?.kind,
    level: doc?.level,
    updated_at: doc?.updatedAt ?? doc?.updated_at,
    name: meta.name,
    description: meta.description,
    trigger: meta.trigger,
    argument_hint: meta.argument_hint ?? meta.argumentHint,
  };
}

function parseSkillFrontmatter(md: string): { metadata: Record<string, string>; body: string } {
  if (typeof md !== "string" || !md.startsWith("---\n")) return { metadata: {}, body: md };
  const end = md.indexOf("\n---", 4);
  if (end < 0) return { metadata: {}, body: md };
  const raw = md.slice(4, end);
  const body = md.slice(end + "\n---".length).replace(/^\s*\r?\n/, "");
  const metadata: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase().replace(/-/g, "_");
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === "name" || key === "description" || key === "trigger" || key === "argument_hint") {
      metadata[key] = value;
    }
  }
  return { metadata, body };
}

// Hidden Identity active-player mode lives entirely in the MCP client.
// When this agent joins a game, it temporarily surfaces all messages from
// that game's channel even without an @mention, so players can follow live
// descriptions/discussion. The server remains the game-state authority; this
// local mode is bounded by both reveal/finished detection and a hard TTL.
type ActiveHiddenIdentityGame = {
  gameId: string;
  channelId: string;
  expiresAt: number;
};
const activeHiddenIdentityGames = new Map<string, ActiveHiddenIdentityGame>(); // game_id -> state
const HI_ACTIVE_TTL_MS = 60 * 60 * 1000;

function pruneActiveHiddenIdentityGames(now = Date.now()) {
  for (const [gameId, state] of activeHiddenIdentityGames) {
    if (state.expiresAt <= now) {
      activeHiddenIdentityGames.delete(gameId);
      process.stderr.write(`[agentchat] HI active mode expired game=${gameId.slice(0, 8)} channel=${state.channelId.slice(0, 12)}\n`);
    }
  }
}

function activateHiddenIdentityGame(gameId: string, channelId?: string) {
  if (!gameId || !channelId) return;
  activeHiddenIdentityGames.set(gameId, {
    gameId,
    channelId,
    expiresAt: Date.now() + HI_ACTIVE_TTL_MS,
  });
  process.stderr.write(`[agentchat] HI active mode ON game=${gameId.slice(0, 8)} channel=${channelId.slice(0, 12)} ttl=${Math.round(HI_ACTIVE_TTL_MS / 60000)}m\n`);
}

async function fetchHiddenIdentityChannelId(gameId: string): Promise<string | undefined> {
  try {
    const r = await fetch(`${REST_URL}/api/hidden-identity/games/${encodeURIComponent(gameId)}`, {
      headers: { "Authorization": `Bearer ${TOKEN}` },
    });
    if (!r.ok) return undefined;
    const data = await r.json().catch(() => ({})) as any;
    const g = data?.game || {};
    const channelId = g.channel_id || g.channelId;
    return typeof channelId === "string" ? channelId : undefined;
  } catch {
    return undefined;
  }
}

function activeHiddenIdentityForChannel(channelId: string | undefined): ActiveHiddenIdentityGame | null {
  if (!channelId) return null;
  pruneActiveHiddenIdentityGames();
  for (const state of activeHiddenIdentityGames.values()) {
    if (state.channelId === channelId) return state;
  }
  return null;
}

function clearActiveHiddenIdentityGame(gameId: string, reason: string) {
  const state = activeHiddenIdentityGames.get(gameId);
  if (!state) return;
  activeHiddenIdentityGames.delete(gameId);
  process.stderr.write(`[agentchat] HI active mode OFF game=${gameId.slice(0, 8)} reason=${reason}\n`);
}

function clearFinishedHiddenIdentityGamesFromMessage(data: any) {
  const content = String(data?.content || "");
  if (!content) return;
  for (const gameId of [...activeHiddenIdentityGames.keys()]) {
    if (!content.includes(gameId)) continue;
    if (/\b(reveal|finished)\b/i.test(content) || /Game over|游戏结束|villagers won|spies won|平民获胜|卧底获胜/i.test(content)) {
      clearActiveHiddenIdentityGame(gameId, "finished_message");
    }
  }
}

// Local ingress dedup for live WS + reconnect backfill races.
//
// `lastSeenMessageTs` is a cursor, not message identity. A reconnect can
// legitimately receive the same persisted message once via live WS and once
// via REST backfill; timestamp guards alone would either fail to drop that
// duplicate or drop older out-of-order messages that were never processed.
const deliveredMessageIds = new Set<string>();
const MAX_DELIVERED_MESSAGE_IDS = 5000;
function deliverySource(data: any): string {
  return typeof data?.__source === "string" ? data.__source : "live";
}
function messageDedupKey(data: any): string | null {
  if (!data || typeof data.id !== "string" || typeof data.channel_id !== "string") return null;
  return `${data.channel_id}:${data.id}`;
}
function recordOrSkipDeliveredMessage(data: any): boolean {
  const key = messageDedupKey(data);
  if (!key) return false;
  if (deliveredMessageIds.has(key)) {
    process.stderr.write(
      `[agentchat] Duplicate message skipped source=${deliverySource(data)} chat=${String(data.channel_id).slice(0, 12)} id=${String(data.id).slice(0, 12)}\n`,
    );
    return true;
  }
  deliveredMessageIds.add(key);
  if (deliveredMessageIds.size > MAX_DELIVERED_MESSAGE_IDS) {
    const arr = [...deliveredMessageIds];
    deliveredMessageIds.clear();
    for (const item of arr.slice(1000)) deliveredMessageIds.add(item);
  }
  return false;
}
// Channels we believe we're a member of. Populated from
// `channel_created` events on auth_ok. Used as the backfill target set.
const knownChannels = new Set<string>();
// Task #119: exposed handler reference so backfillAllChannels (module-
// scope) can reuse connectWS's handleWSMessage closure without
// duplicating the mention/notification gate logic.
let currentHandleWSMessage: ((data: any) => Promise<void>) | null = null;
let wsReconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** Flipped true when the server sends shard_moved (planned drain).
 *  ws.onclose checks + clears it so the close is treated as a clean
 *  hop, not a failure that advances the exponential backoff. */
let isPlannedReconnect = false;

function scheduleReconnect(delayMs: number) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS();
  }, delayMs);
}

/**
 * Task #119: fetch any channel messages that arrived while the WS
 * was unreliable or down. Invoked 2s after every auth_ok — covers
 * both cold start (empty cursors = no backfill) and reconnect
 * (cursor points to last-seen, REST returns the gap).
 *
 * Iterates channels we believe we're in (populated from the
 * channel_created events that follow auth_ok). For each, GETs
 * /api/channels/:id/messages?after=<lastSeenTs> and re-injects
 * every message through handleWSMessage — same code path as live
 * delivery, so @mention detection + notification emission go
 * through the same gate. Self-messages are filtered by the handler
 * (sender_id !== AGENT_ID).
 *
 * Deduplication is by message id in handleWSMessage. Timestamp cursors
 * decide what backfill requests should ask for, but they are not a safe
 * identity check under live/backfill races or out-of-order delivery.
 */
async function backfillAllChannels(): Promise<void> {
  if (knownChannels.size === 0) return;
  for (const channelId of knownChannels) {
    try {
      const after = lastSeenMessageTs.get(channelId);
      const params = after ? `?after=${encodeURIComponent(after)}&limit=50` : `?limit=1`;
      const url = `${REST_URL}/api/channels/${encodeURIComponent(channelId)}/messages${params}`;
      const res = await fetch(url, {
        headers: TOKEN ? { "Authorization": `Bearer ${TOKEN}` } : {},
      });
      if (!res.ok) continue;
      const data = await res.json() as { messages?: any[] };
      const msgs = data.messages || [];
      // Filter out self-messages upfront (faster than re-entering the
      // handler just to bail) and typing placeholders (plugin ignores
      // them anyway).
      const replay = msgs.filter((m: any) =>
        m && m.sender_id !== AGENT_ID && m.content !== "__typing__");
      const dedupedReplay = after
        ? replay.filter((m: any) => {
            const msgTs = normalizeTimestampForCursor(m?.timestamp, "after");
            const afterTs = normalizeTimestampForCursor(after, "after");
            return typeof msgTs === "string" && typeof afterTs === "string" && msgTs > afterTs;
          })
        : replay;
      if (dedupedReplay.length === 0) continue;
      process.stderr.write(`[agentchat] Backfill ${channelId.slice(0, 12)}: ${dedupedReplay.length} missed msg(s)\n`);
      // Sort ascending so replay order matches live chronology —
      // lastSeenMessageTs advances monotonically.
      dedupedReplay.sort((a: any, b: any) => String(a.timestamp).localeCompare(String(b.timestamp)));
      for (const m of dedupedReplay) {
        try {
          // Wrap as a `message` envelope to match ws.onmessage shape.
          if (currentHandleWSMessage) {
            await currentHandleWSMessage({ ...m, type: "message", __source: "backfill" });
          }
        } catch (e) {
          process.stderr.write(`[agentchat] Backfill replay error: ${e}\n`);
        }
      }
    } catch (e) {
      process.stderr.write(`[agentchat] Backfill fetch failed for ${channelId.slice(0, 12)}: ${e}\n`);
    }
  }
}

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
    if (data && typeof data === "object" && !data.__source) data.__source = "live";
    try { await handleWSMessage(data); } catch (e) {
      process.stderr.write(`[agentchat] Message handler error: ${e}\n`);
    }
  };

  currentHandleWSMessage = handleWSMessage;
  async function handleWSMessage(data: any) {

    if (data.type === "pong") {
      heartbeat.receivedPong();
      return;
    }
    if ((data.type === "hidden_identity.reveal" || data.type === "hidden_identity.finished") && typeof data.game_id === "string") {
      clearActiveHiddenIdentityGame(data.game_id, data.type);
    }

    if (data.type === "auth_ok") {
      sessionId = data.session_id;
      wsReconnectAttempt = 0; // reset backoff on successful auth
      heartbeat.receivedPong(); // treat auth_ok as alive signal
      process.stderr.write(`[agentchat] Connected as ${AGENT_ID}\n`);
      // Task #119: fire a backfill 2s after auth_ok to pick up any
      // messages that arrived while the WS was down or that the Redis
      // ac:ch:* subscribe happened to miss. Delay gives the server
      // time to emit channel_created for each joined channel so
      // knownChannels is populated. backfillAllChannels does the
      // per-channel REST fetch and re-injects each missed message
      // through handleWSMessage so @mention detection + notification
      // path is identical to live delivery — no divergent code paths.
      setTimeout(() => { void backfillAllChannels(); }, 2000);
    } else if (
      data.type === "message" &&
      // Loop ticks are server-fired with sender_id=loop.agent_id, which
      // equals AGENT_ID when the loop owner is THIS plugin. Without this
      // exception the outer "skip own messages" gate swallows every tick
      // before the slash filter below ever sees it, so /loop silently
      // never fires the LLM for the loop creator. Empirically confirmed
      // 2026-05-03 in dm-dsplvj (loop_39d587464e3c): tick landed in
      // history but never surfaced to the plugin's LLM path.
      (data.sender_id !== AGENT_ID ||
        (data.meta &&
          typeof data.meta === "object" &&
          (data.meta as { kind?: unknown }).kind === "loop_tick"))
    ) {
      // 跳过 typing 状态消息
      if (data.content === "__typing__") return;

      // Slash side-channel skip (boss directive 2026-05-03 msg:caf95079).
      // /loop, /show-loop, /stop-loop are command channels — LLM must NOT
      // be invoked by them. Server tags envelopes server-authoritatively:
      //   • meta.kind="slash_input"  — user's literal slash text (hub.ts
      //     preprocessSlashCommand, force-overwrite to prevent client spoof)
      //   • meta.kind="loop_status"  — system reply from slash-router
      //     (success/error/placeholder for /loop /stop-loop /show-loop)
      // loop_tick (broadcastLoopTick) is intentionally NOT filtered —
      // that's the engine firing the loop owner's LLM and IS meant for
      // consumption.
      const metaKind = (data.meta && typeof data.meta === "object")
        ? (data.meta as { kind?: unknown }).kind
        : undefined;
      if (metaKind === "slash_input" || metaKind === "loop_status" || metaKind === "slash_response") {
        process.stderr.write(`[agentchat] [slash-skip] ${metaKind} in ${(data.channel_id || "").slice(0, 12)}\n`);
        return;
      }

      if (recordOrSkipDeliveredMessage(data)) return;

      // Task #119: record the timestamp so a future auth_ok backfill
      // knows where to resume. Only advance forward (defensive against
      // out-of-order delivery from Redis subscribe vs REST backfill
      // replay). Persist periodically — not every message to avoid
      // disk thrash, but at least on every received chat message since
      // this file is tiny (one row per channel).
      if (typeof data.channel_id === "string" && typeof data.timestamp === "string") {
        const prev = lastSeenMessageTs.get(data.channel_id) || "";
        const currentTs = normalizeTimestampForCursor(data.timestamp, "after") || data.timestamp;
        const prevTs = normalizeTimestampForCursor(prev, "after") || prev;
        if (currentTs > prevTs) {
          lastSeenMessageTs.set(data.channel_id, data.timestamp);
          saveLastSeenMessageTs(lastSeenMessageTs);
        }
      }

      const isDM = data.channel_id?.startsWith("dm-");
      // Match both `@<agentId>` and `@<displayName>(<agentId>)` formats.
      // v0.6.1 used a loose `content.includes("(" + AGENT_ID + ")")` for the
      // second case which fired on ANY text containing `(<agentId>)` —
      // including system messages like "User joined: name (acc_xyz)" or
      // moderation logs. Boss msg:fc8b9b1a — codex agent received messages
      // it wasn't @-mentioned in, ate context window. Tighten the second
      // clause to require an `@<displayName>` immediately before `(<id>)`.
      const idEsc = (AGENT_ID || "").replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const displayMentionRe = idEsc ? new RegExp(`@[^(\\n]+\\(${idEsc}\\)`) : null;
      const isMentioned = !!(
        data.content?.includes(`@${AGENT_ID}`) ||
        (displayMentionRe && displayMentionRe.test(data.content || ""))
      );
      const activeHi = activeHiddenIdentityForChannel(data.channel_id);

      if (isDM || isMentioned || activeHi) {
        // DM or @mention → respond
        // 立即发送 typing ACK
        if (isDM || isMentioned) {
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
        }

        // For @mention in channels, fetch context since last mention
        let contextPrefix = "";
        if (!isDM && isMentioned) {
          try {
            const lastTs = lastMentionTimestamp.get(data.channel_id) || "";
            // Cap the request size: 50 messages max, plus client-side byte
            // and per-message-content trimming below. Boss msg:fc8b9b1a —
            // long-silent agents would pull a 200-message backlog on first
            // @mention, blowing up small-context models. 50 + 15KB +
            // per-msg 2KB matches "recent conversation" without overshoot.
            const params = `limit=50${lastTs ? '&after=' + encodeURIComponent(lastTs) : ''}`;
            const historyUrl = `${REST_URL}/api/channels/${encodeURIComponent(data.channel_id)}/messages?${params}`;
            // Channel reads are auth-gated (login for public channels,
            // membership for private). Without the Bearer header the
            // MCP agent would get 401/403 and answer the @mention
            // without any conversation context.
            const historyRes = await fetch(historyUrl, {
              headers: TOKEN ? { "Authorization": `Bearer ${TOKEN}` } : {},
            });
            if (historyRes.ok) {
              const historyData = await historyRes.json() as any;
              let msgs = (historyData.messages || [])
                .filter((m: any) => m.id !== data.id && m.content !== "__typing__");
              // Cumulative byte cap (newest-first walk so we keep the most
              // recent messages when total exceeds the budget). Per-message
              // content also clipped to 2KB to defang occasional copy-paste
              // walls of text — a single mega-message no longer eats the
              // whole budget alone.
              let totalBytes = 0;
              const maxBytes = 15_000;
              const maxPerMsg = 2_000;
              const trimmed: any[] = [];
              for (let i = msgs.length - 1; i >= 0; i--) {
                const raw = (msgs[i].content || "");
                const clipped = raw.length > maxPerMsg
                  ? raw.slice(0, maxPerMsg) + " …[truncated]"
                  : raw;
                const size = clipped.length;
                if (totalBytes + size > maxBytes) break;
                totalBytes += size;
                trimmed.unshift({ ...msgs[i], content: clipped });
              }
              const truncatedMsgs = trimmed.length < msgs.length;
              if (trimmed.length > 0) {
                const context = trimmed
                  .map((m: any) => `${m.sender_id}: ${m.content}`)
                  .join("\n");
                const note = truncatedMsgs
                  ? `[频道上下文 - 最近 ${trimmed.length} 条消息（更早的已截断保护上下文窗口）]`
                  : `[频道上下文 - 自上次 @mention 以来 ${trimmed.length} 条消息]`;
                contextPrefix = `${note}\n${context}\n\n[你被 @mention 了，请回复]\n`;
              }
            }
            // Record this mention timestamp for next time
            lastMentionTimestamp.set(data.channel_id, data.timestamp);
            saveMentionTimestamps(lastMentionTimestamp);
          } catch (e) {
            process.stderr.write(`[agentchat] Failed to fetch context: ${e}\n`);
          }
        }
        if (!isDM && !isMentioned && activeHi) {
          contextPrefix = `[HI游戏进行中 - 你是 game ${activeHi.gameId.slice(0, 8)} 的上桌玩家；此消息无需 @mention 也被实时推送。只在轮到你行动、需要讨论或需要投票时回复，否则可以旁观。]\n`;
        }

        process.stderr.write(`[agentchat] ${isDM ? 'DM' : isMentioned ? '@mention' : 'HI-active'} from ${data.sender_id.slice(0, 8)}: ${data.content.slice(0, 50)}\n`);

        // 推送给 Claude Code
        try {
          await server.notification({
            method: process.env.CLAUDE_CODE_ENTRYPOINT ? "notifications/claude/channel" : "notifications/chat/channel",
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
        if (activeHi) clearFinishedHiddenIdentityGamesFromMessage(data);
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
      // Task #119: track channel id for reconnect backfill target set.
      if (typeof data.channel_id === "string") knownChannels.add(data.channel_id);
    } else if (data.type === "shard_moved") {
      // Server instance shutting down or channel moved — reconnect
      // immediately. This is a PLANNED disconnect: the server is
      // giving us heads-up to move. Mark it so the upcoming
      // ws.onclose doesn't treat this as a failure that increments
      // wsReconnectAttempt / stretches the exponential backoff. When
      // the server does a rolling deploy (several pods closing in
      // sequence), without this flag each shard_moved would push the
      // next reconnect 2s, 4s, 6s ... further out even though each
      // is a clean planned event.
      process.stderr.write(`[agentchat] Shard moved, reconnecting...\n`);
      if (data.redirect_url) {
        const newUrl = data.redirect_url.replace(/^https/, "wss").replace(/^http/, "ws") + "/ws";
        process.stderr.write(`[agentchat] Redirecting to: ${newUrl}\n`);
        // Note: for simplicity we reconnect to original URL and let /api/shard handle routing
      }
      isPlannedReconnect = true;
      try { ws?.close(); } catch {}
      ws = null;
      sessionId = null;
      scheduleReconnect(500);
    } else if (data.type === "error") {
      process.stderr.write(`[agentchat] Error: ${data.message}\n`);
    }
  }

  ws.onclose = (event) => {
    sessionId = null;
    heartbeat.resetReconnecting(); // allow heartbeat to reconnect again if needed
    // Planned reconnect (server-initiated shard_moved): reset backoff
    // and reconnect fast, don't count this against exponential delay.
    if (isPlannedReconnect) {
      isPlannedReconnect = false;
      wsReconnectAttempt = 0;
      // A concurrent scheduleReconnect(500) from the shard_moved
      // handler has already been queued — don't double-schedule.
      process.stderr.write(`[agentchat] Planned close (code=${(event as any)?.code ?? "?"}), reconnect in 0.5s\n`);
      return;
    }
    wsReconnectAttempt++;
    const jitter = Math.random() * 3000; // 0-3s random jitter to avoid thundering herd
    const delay = Math.min(wsReconnectAttempt * 2, 30) * 1000 + jitter;
    process.stderr.write(`[agentchat] Disconnected (code=${(event as any)?.code ?? "?"}), reconnecting in ${Math.round(delay/100)/10}s (attempt ${wsReconnectAttempt})...\n`);
    scheduleReconnect(delay);
  };

  ws.onerror = (err) => {
    process.stderr.write(`[agentchat] WebSocket error: ${err}\n`);
  };
}

// Heartbeat with dead-connection detection (15s ping, 45s timeout for faster recovery)
import { HeartbeatMonitor, WS_OPEN, WS_CLOSED, WS_CONNECTING, WS_CLOSING } from "./heartbeat.ts";

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
    scheduleReconnect(500); // short delay to avoid tight loop
  },
  getReadyState: () => ws?.readyState ?? WS_CLOSED,
}, 15_000, 45_000, 30_000); // 15s ping, 45s pong timeout, 30s connect timeout
heartbeat.start();

// --- Start ---
async function main() {
  connectWS();

  // Stdio is the only supported transport. The --port HTTP SSE path was
  // removed in v0.6.7 — OpenClaw users should install the native channel
  // adapter `openclaw-agentchat` (npm) instead of running this plugin
  // as an HTTP server.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[agentchat] MCP server started (Stdio)\n");
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
