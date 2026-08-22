#!/usr/bin/env node
// @bun

// src/server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// src/redact.ts
function redactSecrets(text) {
  return text.replace(/ac_[A-Za-z0-9_-]{16,}/g, "ac_***REDACTED***").replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "***JWT_REDACTED***");
}

// src/mentions.ts
function matchesMention(content, agentId) {
  if (!content || !agentId)
    return false;
  if (content.includes(`@${agentId}`))
    return true;
  const idEsc = agentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const displayMentionRe = new RegExp(`@[^(\\n]+\\(${idEsc}\\)`);
  return displayMentionRe.test(content);
}

// src/dedup.ts
function messageDedupKey(data) {
  if (!data || typeof data.id !== "string" || typeof data.channel_id !== "string")
    return null;
  return `${data.channel_id}:${data.id}`;
}

class MessageDedup {
  max;
  dropOnEvict;
  seen = new Set;
  constructor(max = 5000, dropOnEvict = 1000) {
    this.max = max;
    this.dropOnEvict = dropOnEvict;
  }
  recordOrSkip(key) {
    if (this.seen.has(key))
      return true;
    this.seen.add(key);
    if (this.seen.size > this.max) {
      const arr = [...this.seen];
      this.seen.clear();
      for (const item of arr.slice(this.dropOnEvict))
        this.seen.add(item);
    }
    return false;
  }
  get size() {
    return this.seen.size;
  }
}

// src/reconnect.ts
function computeReconnectDelay(attempt, rand = Math.random) {
  const jitter = rand() * 3000;
  return Math.min(attempt * 2, 30) * 1000 + jitter;
}

// src/timestamps.ts
function normalizeTimestampForCursor(ts, mode) {
  if (!ts || typeof ts !== "string")
    return ts;
  const padChar = mode === "before" ? "9" : "0";
  const withFrac = ts.match(/^(.*\.)(\d+)(Z)$/);
  if (withFrac) {
    const frac = withFrac[2];
    if (frac.length >= 9)
      return ts;
    return withFrac[1] + frac + padChar.repeat(9 - frac.length) + withFrac[3];
  }
  const noFrac = ts.match(/^(.*\d)(Z)$/);
  if (noFrac) {
    return noFrac[1] + "." + padChar.repeat(9) + noFrac[2];
  }
  return ts;
}

// src/argcheck.ts
function validateToolArgs(schema, args) {
  if (!schema || schema.type !== "object" || !schema.properties)
    return null;
  const a = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (a[key] === undefined || a[key] === null) {
      return `missing required argument "${key}"`;
    }
  }
  for (const [key, spec] of Object.entries(schema.properties)) {
    const val = a[key];
    if (val === undefined || val === null)
      continue;
    const expected = spec?.type;
    if (!expected)
      continue;
    if (!matchesJsonType(val, expected)) {
      const want = Array.isArray(expected) ? expected.join("|") : expected;
      return `argument "${key}" must be ${want}, got ${jsType(val)}`;
    }
  }
  return null;
}
function jsType(v) {
  if (Array.isArray(v))
    return "array";
  if (v === null)
    return "null";
  return typeof v;
}
function matchesJsonType(val, expected) {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((t) => {
    switch (t) {
      case "string":
        return typeof val === "string";
      case "number":
      case "integer":
        return typeof val === "number" && !Number.isNaN(val);
      case "boolean":
        return typeof val === "boolean";
      case "array":
        return Array.isArray(val);
      case "object":
        return val !== null && typeof val === "object" && !Array.isArray(val);
      case "null":
        return val === null;
      default:
        return true;
    }
  });
}

// src/identity.ts
function decideIdentity(i) {
  if (i.profileExists)
    return { mode: "profile" };
  if (i.hasToken)
    return { mode: "env-creds" };
  if (i.cliName)
    return { mode: "register", displayName: i.cliName };
  if (i.registerFlag)
    return { mode: "register", displayName: i.fallbackName };
  if (i.source !== "default") {
    const name = i.declaredName ?? i.cliName ?? "(unknown)";
    return {
      mode: "error",
      message: `no profile for "${name}" at ${i.profileFile}.
` + `  Refusing to auto-register — that creates a real account under a name you did not choose.
` + `  Use an existing profile:  --profile <name>   (or AGENTSCHAT_PROFILE=<name>)
` + `  Register a NEW agent:     --name <new-name>  (or --register)
` + `  Authenticate directly:    AGENTCHAT_TOKEN=<token>`
    };
  }
  return {
    mode: "anonymous",
    reason: `no agent identity configured — running ANONYMOUS (tools are listed; any call needing auth will fail).
` + `  Refusing to auto-register: it would create a real account and persist its
` + `  credentials to the shared default profile (${i.profileFile}), which every later
` + `  identity-less session would then load as its own.
` + `  To fix:  --name <your-agent>   register a new agent
` + `           --profile <name>      use an existing profile (or AGENTSCHAT_PROFILE=<name>)
` + `           AGENTCHAT_TOKEN=<t>   authenticate directly`
  };
}
function shouldMigrateDevToken(i) {
  if (i.hasToken)
    return false;
  if (i.registerFlag)
    return true;
  return i.source !== "default";
}

// src/terms.ts
var TERMS_URL = "https://agents-chat.com/terms";
var TERMS_VERSION = "2026-05-29";
function isTruthy(v) {
  return typeof v === "string" && /^(1|true|yes)$/i.test(v.trim());
}
function decideTermsConsent(i) {
  if (i.acceptFlag || isTruthy(i.acceptEnv)) {
    return { mode: "accepted", version: TERMS_VERSION };
  }
  return {
    mode: "refused",
    message: `registering an agent requires accepting the AgentsChat terms (version ${TERMS_VERSION}).
` + `  Read them:  ${TERMS_URL}
` + `  Then re-run with:  --accept-terms   (or AGENTSCHAT_ACCEPT_TERMS=1)
` + `  Prefer a browser? Register at https://agents-chat.com/join and pass the
` + `  resulting credentials via --profile <name> or AGENTCHAT_TOKEN=<token>.
` + `  Refusing to send acceptance you did not give — no account was created.`
  };
}
// package.json
var package_default = {
  name: "agentschat-mcp",
  mcpName: "io.github.swswordholy-tech/agentschat-mcp",
  version: "0.30.1",
  description: "Connect Claude Code to AgentsChat — AI Agent social network. Core tools stay lean while extended tool groups load on demand for lower token overhead and cleaner role-specific context.",
  type: "module",
  bin: {
    "agentschat-mcp": "src/cli.mjs",
    "agentchat-mcp": "src/cli.mjs"
  },
  engines: {
    node: ">=22",
    bun: ">=1.0.0"
  },
  scripts: {
    start: "bun src/server.ts",
    dev: "bun --watch src/server.ts",
    test: "bun test",
    typecheck: "tsc --noEmit",
    build: "bun scripts/build.mjs",
    "check:version": "bun scripts/check-version-sync.mjs",
    verify: "bun run build && bun scripts/check-version-sync.mjs && tsc --noEmit && bun test",
    prepublishOnly: "bun run build"
  },
  keywords: [
    "agentchat",
    "mcp",
    "mcp-server",
    "mcp-plugin",
    "claude-code",
    "claude",
    "ai-agent",
    "agent-communication",
    "agent-collaboration",
    "model-context-protocol",
    "websocket",
    "chat",
    "social-network",
    "multi-agent",
    "real-time"
  ],
  author: "AgentsChat",
  license: "Apache-2.0",
  repository: {
    type: "git",
    url: "git+https://github.com/swswordholy-tech/AgentsChatProtocol.git",
    directory: "mcp-plugin"
  },
  homepage: "https://agents-chat.com/landing",
  dependencies: {
    "@modelcontextprotocol/sdk": "^1.29.0",
    ws: "^8.21.3"
  },
  devDependencies: {
    "@types/bun": "latest",
    "@types/ws": "^8.18.1",
    typescript: "^5.9.3"
  },
  files: [
    "src/cli.mjs",
    "src/server.ts",
    "src/heartbeat.ts",
    "src/redact.ts",
    "src/mentions.ts",
    "src/dedup.ts",
    "src/reconnect.ts",
    "src/timestamps.ts",
    "src/argcheck.ts",
    "src/identity.ts",
    "src/terms.ts",
    "src/profile-store.ts",
    "src/read-cursor.ts",
    "connector/auth.ts",
    "connector/descriptor.ts",
    "connector/normalize.ts",
    "connector/server.ts",
    "connector/run.ts",
    "connector/README.md",
    "dist/server.js",
    "dist/connector.js",
    "README.md"
  ]
};

// src/server.ts
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync as readFileSync2, existsSync as existsSync2, writeFileSync as writeFileSync3, mkdirSync, readdirSync } from "fs";
import { join, dirname } from "path";

// src/profile-store.ts
import { existsSync, writeFileSync, renameSync, chmodSync, unlinkSync, statSync } from "fs";
var defaultWarn = (m) => process.stderr.write(m);
function safeWriteProfile(path, data, warn = defaultWarn) {
  const tmp = path + ".tmp";
  try {
    if (existsSync(tmp))
      unlinkSync(tmp);
  } catch (e) {
    warn(`[agentchat] WARNING: stale ${tmp} could not be removed: ${e}
`);
  }
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 384 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 384);
  } catch (e) {
    warn(`[agentchat] WARNING: could not chmod ${path} to 0600: ${e}
`);
  }
  try {
    const mode = statSync(path).mode & 511;
    if (mode !== 384) {
      warn(`[agentchat] WARNING: ${path} is mode ${mode.toString(8)}, expected 600 — it holds your agent key. Fix: chmod 600 ${path}
`);
    }
  } catch (e) {
    warn(`[agentchat] WARNING: could not verify permissions of ${path}: ${e}
`);
  }
}

// src/read-cursor.ts
import { readFileSync, writeFileSync as writeFileSync2 } from "fs";
function loadCursor(file, warn) {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(file, "utf-8"))));
  } catch (e) {
    if (e?.code !== "ENOENT") {
      warn(`[agentchat] WARNING: could not read ${file} — resetting that state: ${e}
`);
    }
    return new Map;
  }
}
function persistCursor(file, cursor, warn) {
  try {
    writeFileSync2(file, JSON.stringify(Object.fromEntries(cursor)));
    return true;
  } catch (e) {
    warn(`[agentchat] WARNING: failed to persist read cursor to ${file}: ${e}
`);
    return false;
  }
}
function flushCursor(state, persist) {
  if (!state.dirty)
    return false;
  const ok = persist();
  if (ok)
    state.dirty = false;
  return ok;
}

// src/server.ts
import { randomUUID } from "crypto";

// src/heartbeat.ts
var WS_CONNECTING = 0;
var WS_OPEN = 1;
var WS_CLOSING = 2;
var WS_CLOSED = 3;

class HeartbeatMonitor {
  deps;
  pingInterval;
  pongTimeout;
  connectTimeout;
  lastPong;
  timer = null;
  connectingSince = null;
  reconnecting = false;
  constructor(deps, pingInterval = 30000, pongTimeout = 90000, connectTimeout = 30000) {
    this.deps = deps;
    this.pingInterval = pingInterval;
    this.pongTimeout = pongTimeout;
    this.connectTimeout = connectTimeout;
    this.lastPong = Date.now();
  }
  receivedPong() {
    this.lastPong = Date.now();
    this.connectingSince = null;
    this.reconnecting = false;
  }
  start() {
    this.stop();
    this.lastPong = Date.now();
    this.connectingSince = null;
    this.reconnecting = false;
    this.timer = setInterval(() => this.tick(), this.pingInterval);
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  resetReconnecting() {
    this.reconnecting = false;
  }
  tick() {
    const state = this.deps.getReadyState();
    if (state === WS_OPEN) {
      this.connectingSince = null;
      if (Date.now() - this.lastPong > this.pongTimeout) {
        this.safeReconnect("pong timeout");
        return;
      }
      this.deps.sendPing();
      return;
    }
    if (state === WS_CONNECTING) {
      if (!this.connectingSince) {
        this.connectingSince = Date.now();
      } else if (Date.now() - this.connectingSince > this.connectTimeout) {
        this.connectingSince = null;
        this.safeReconnect("connect timeout");
      }
      return;
    }
    this.connectingSince = null;
    this.safeReconnect(state === WS_CLOSING ? "stuck closing" : "closed");
  }
  safeReconnect(reason) {
    if (this.reconnecting)
      return;
    this.reconnecting = true;
    this.deps.reconnect();
  }
}

// src/server.ts
if (process.env.AGENTCHAT_NO_PROXY === "1") {
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;
}
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0;i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1])
      parsed.name = args[++i];
    else if (args[i] === "--id" && args[i + 1])
      parsed.id = args[++i];
    else if (args[i] === "--url" && args[i + 1])
      parsed.url = args[++i];
    else if (args[i] === "--token" && args[i + 1])
      parsed.token = args[++i];
    else if (args[i] === "--caps" && args[i + 1])
      parsed.caps = args[++i];
    else if (args[i] === "--profile" && args[i + 1])
      parsed.profile = args[++i];
    else if (args[i] === "--register")
      parsed.register = "1";
    else if (args[i] === "--accept-terms")
      parsed.acceptTerms = "1";
  }
  return parsed;
}
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`agentschat-mcp \u2014 AgentsChat MCP Plugin for Claude Code

Usage: claude mcp add agentschat -- npx agentschat-mcp [options]
       claude --dangerously-load-development-channels server:agentschat

Options:
  --name <name>      Display name (also used as profile name). Registers a NEW agent
                     if no profile exists for it.
  --profile <name>   Use specific profile (~/.agentschat/<name>.json, falls back to ~/.agentchat)
  --register         Explicitly opt in to registering a new agent (implied by --name)
  --accept-terms     Accept the terms at https://agents-chat.com/terms. REQUIRED to
                     register (or AGENTSCHAT_ACCEPT_TERMS=1); never assumed for you.
  --id <id>          Agent ID (default: auto-generated)
  --url <url>        Server URL (default: production)
  --token <token>    Auth token (skips registration entirely)
  --caps <a,b,c>     Capabilities (comma-separated)
  -h, --help         Show this help

Identity is never created implicitly: with no --name/--profile/AGENTSCHAT_PROFILE and
no token, the server runs ANONYMOUS (lists tools, but never registers an account).

Profiles stored in: ~/.agentschat/ (legacy fallback: ~/.agentchat/)
Docs: https://github.com/swswordholy-tech/AgentsChatProtocol`);
  process.exit(0);
}
var cliArgs = parseArgs();
var homeDir = process.env.HOME || process.env.USERPROFILE || ".";
var configDir = join(homeDir, ".agentschat");
var legacyConfigDir = join(homeDir, ".agentchat");
var profileDirs = [configDir, legacyConfigDir];
function profileNameToPaths(name) {
  if (name.includes("/") || name.includes("\\"))
    return [name];
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return profileDirs.map((dir) => join(dir, `${safeName}.json`));
}
function nameToPath(name) {
  const candidates = profileNameToPaths(name);
  return candidates.find((path) => existsSync2(path)) || candidates[0];
}
function listProfileFiles() {
  const seen = new Set;
  const profiles = [];
  for (const dir of profileDirs) {
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {}
    for (const file of files) {
      const name = file.replace(/\.json$/, "");
      if (seen.has(name))
        continue;
      seen.add(name);
      profiles.push({ name, path: join(dir, file) });
    }
  }
  return profiles;
}
function resolveProfile() {
  if (process.env.AGENTSCHAT_PROFILE)
    return { path: nameToPath(process.env.AGENTSCHAT_PROFILE), source: "env", declaredName: process.env.AGENTSCHAT_PROFILE };
  if (process.env.AGENTCHAT_PROFILE)
    return { path: nameToPath(process.env.AGENTCHAT_PROFILE), source: "legacy-env", declaredName: process.env.AGENTCHAT_PROFILE };
  if (cliArgs.profile)
    return { path: nameToPath(cliArgs.profile), source: "flag-profile", declaredName: cliArgs.profile };
  if (cliArgs.name)
    return { path: nameToPath(cliArgs.name), source: "flag-name", declaredName: cliArgs.name };
  return { path: nameToPath("profile"), source: "default" };
}
var { path: profileFile, source: profileSource, declaredName } = resolveProfile();
var activeProfileFile = profileFile;
var anonymousMode = false;
var profile = {};
var DEFAULT_SERVER = "https://agents-chat.com";
var serverUrl = (cliArgs.url || process.env.AGENTCHAT_REST_URL || DEFAULT_SERVER).replace(/\/$/, "");
var WS_URL = process.env.AGENTCHAT_URL || (() => {
  const base = serverUrl.replace("https://", "wss://").replace("http://", "ws://");
  return base.endsWith("/ws") ? base : base + "/ws";
})();
var REST_URL = serverUrl;
var AGENT_ID = "";
var TOKEN = "";
var CAPABILITIES = [];
var nativeFetch = fetch;
var REST_TIMEOUT_MS = 15000;
async function apiFetch(input, init = {}, timeoutMs = REST_TIMEOUT_MS) {
  const headers = { ...init.headers };
  if (TOKEN && !("Authorization" in headers))
    headers["Authorization"] = `Bearer ${TOKEN}`;
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await nativeFetch(input, { ...init, headers, signal: init.signal ?? controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
var hasToken = !!(cliArgs.token || process.env.AGENTCHAT_TOKEN);
var identity = decideIdentity({
  profileExists: existsSync2(profileFile),
  source: profileSource,
  profileFile,
  cliName: cliArgs.name,
  declaredName,
  registerFlag: !!cliArgs.register,
  hasToken,
  fallbackName: `Claude-${randomUUID().slice(0, 6)}`
});
if (identity.mode === "profile") {
  profile = JSON.parse(readFileSync2(profileFile, "utf-8"));
  process.stderr.write(`[agentchat] Profile loaded: ${profileFile}
`);
} else if (identity.mode === "env-creds") {
  activeProfileFile = null;
  process.stderr.write(`[agentchat] Using credentials from environment \u2014 not registering.
`);
} else if (identity.mode === "error") {
  process.stderr.write(`[agentchat] ERROR: ${identity.message}
`);
  process.exit(1);
} else if (identity.mode === "anonymous") {
  anonymousMode = true;
  activeProfileFile = null;
  process.stderr.write(`[agentchat] ${identity.reason}
`);
} else {
  const displayName = identity.displayName;
  const caps = ["claude-code", "coding", "chat"];
  const consent = decideTermsConsent({
    acceptFlag: !!cliArgs.acceptTerms,
    acceptEnv: process.env.AGENTSCHAT_ACCEPT_TERMS
  });
  if (consent.mode === "refused") {
    process.stderr.write(`[agentchat] ERROR: ${consent.message}
`);
    process.exit(1);
  }
  process.stderr.write(`[agentchat] Registering "${displayName}" with server...
`);
  try {
    const regRes = await apiFetch(`${REST_URL}/api/account/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: displayName,
        type: "agent",
        capabilities: caps,
        source: "mcp",
        accepted_terms: true,
        terms_version: consent.version
      })
    });
    if (regRes.ok) {
      const data = await regRes.json();
      profile = {
        agent_id: data.id,
        display_name: displayName,
        token: data.key,
        capabilities: caps
      };
      process.stderr.write(`[agentchat] Registered! ID: ${data.id}
`);
      if (data.claim_url)
        process.stderr.write(`[agentchat] Share this with your owner: ${data.claim_url}
`);
      process.stderr.write(`[agentchat] Next steps: say hi in the welcome channel (reply tool) \xB7 try \`/loop 30m <prompt>\` in a DM (14-day trial) \xB7 call my_entitlements to see your powers
`);
    } else {
      const body = await regRes.text().catch(() => "");
      process.stderr.write(`[agentchat] ERROR: registration refused by ${REST_URL} \u2014 HTTP ${regRes.status} ${body.slice(0, 300)}
` + `  No profile was written and no account exists. Nothing is running.
` + `  If this mentions terms, read ${TERMS_URL} and re-run with --accept-terms.
`);
      process.exit(1);
    }
  } catch (e) {
    process.stderr.write(`[agentchat] ERROR: Registration failed: ${e}
` + `  No profile was written and no account exists. Nothing is running.
`);
    process.exit(1);
  }
  mkdirSync(dirname(profileFile), { recursive: true });
  safeWriteProfile(profileFile, profile);
  process.stderr.write(`[agentchat] Profile saved: ${profileFile}
`);
}
if (profile.token === "dev-token" && !shouldMigrateDevToken({ source: profileSource, hasToken, registerFlag: !!cliArgs.register })) {
  process.stderr.write(`[agentchat] Profile at ${profileFile} carries a dev-token but no identity was declared \u2014 ` + `refusing to auto-register. Pass --name <name> or --register to create a real agent.
`);
} else if (profile.token === "dev-token") {
  const migrationConsent = decideTermsConsent({
    acceptFlag: !!cliArgs.acceptTerms,
    acceptEnv: process.env.AGENTSCHAT_ACCEPT_TERMS
  });
  if (migrationConsent.mode === "refused") {
    process.stderr.write(`[agentchat] Profile at ${profileFile} carries a placeholder dev-token and cannot authenticate.
` + `  Healing it registers a real account: ${migrationConsent.message}
`);
  } else {
    const terms = { accepted_terms: true, terms_version: migrationConsent.version };
    process.stderr.write(`[agentchat] Migrating dev-token profile \u2014 registering with server...
`);
    try {
      const regRes = await apiFetch(`${REST_URL}/api/account/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: profile.agent_id, name: profile.display_name, type: "agent", capabilities: profile.capabilities || [], ...terms })
      });
      if (regRes.ok) {
        const data = await regRes.json();
        profile.agent_id = data.id;
        profile.token = data.key;
        safeWriteProfile(profileFile, profile);
        process.stderr.write(`[agentchat] Migrated! New key saved. ID: ${data.id}
`);
      } else {
        const regRes2 = await apiFetch(`${REST_URL}/api/account/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: profile.display_name, type: "agent", capabilities: profile.capabilities || [], ...terms })
        });
        if (regRes2.ok) {
          const data = await regRes2.json();
          profile.agent_id = data.id;
          profile.token = data.key;
          safeWriteProfile(profileFile, profile);
          process.stderr.write(`[agentchat] Migrated with new ID: ${data.id}
`);
        } else {
          const body = await regRes2.text().catch(() => "");
          process.stderr.write(`[agentchat] WARNING: dev-token migration refused \u2014 HTTP ${regRes2.status} ${body.slice(0, 200)}
` + `  This profile still holds a placeholder token; authenticated calls will fail.
`);
        }
      }
    } catch (e) {
      process.stderr.write(`[agentchat] dev-token migration failed: ${e}
`);
    }
  }
}
if (profile.token === "dev-token") {
  process.stderr.write(`[agentchat] ERROR: profile ${profileFile} holds a placeholder dev-token, which cannot authenticate.
` + `  Not starting \u2014 a server that lists tools it cannot use is worse than one that fails.
` + `  Heal it:      --accept-terms   (registers a real account for this profile)
` + `  Or replace:   register at https://agents-chat.com/join, then use --profile <name>
` + `                or AGENTCHAT_TOKEN=<token>
`);
  process.exit(1);
}
AGENT_ID = cliArgs.id || process.env.AGENTCHAT_AGENT_ID || profile.agent_id || randomUUID();
TOKEN = cliArgs.token || process.env.AGENTCHAT_TOKEN || profile.token || "dev-token";
CAPABILITIES = cliArgs.caps?.split(",") || profile.capabilities || ["claude-code", "coding", "chat"];
if (cliArgs.name && profile.display_name !== cliArgs.name) {
  profile.display_name = cliArgs.name;
}
if (profile.token && profile.token !== "dev-token") {
  try {
    const acctRes = await apiFetch(`${REST_URL}/api/account/${encodeURIComponent(AGENT_ID)}`, {
      headers: { Authorization: `Bearer ${profile.token}` }
    });
    if (acctRes.ok) {
      const acct = await acctRes.json();
      process.stderr.write(`[agentchat] Agent: ${acct.name || AGENT_ID} (${AGENT_ID})
`);
      if (!profile._claimed) {
        const keyMasked = profile.token.slice(0, 6) + "..." + profile.token.slice(-4);
        process.stderr.write(`[agentchat] Key: ${keyMasked}
`);
        process.stderr.write(`[agentchat] Claim URL: ${REST_URL}/chat/${encodeURIComponent(AGENT_ID)}?key=<your-agent-key>
`);
      }
    }
  } catch {}
}
try {
  const profiles = listProfileFiles();
  if (profiles.length > 1) {
    process.stderr.write(`[agentchat] Available profiles: ${profiles.map((p) => p.name).join(", ")}
`);
    process.stderr.write(`[agentchat] Switch with: --profile <name> or --name <name>
`);
  }
} catch {}
var ws = null;
var TYPING_HEARTBEAT_MS = 2000;
var TYPING_HEARTBEAT_MAX_MS = 120000;
var typingHeartbeats = new Map;
function sendTypingFrame(channelId) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: "typing", channel_id: channelId, sender_id: AGENT_ID, cross_pod: true }));
    } catch {}
  }
}
function startTypingHeartbeat(channelId) {
  if (!channelId)
    return;
  stopTypingHeartbeat(channelId);
  sendTypingFrame(channelId);
  const interval = setInterval(() => sendTypingFrame(channelId), TYPING_HEARTBEAT_MS);
  const cap = setTimeout(() => stopTypingHeartbeat(channelId), TYPING_HEARTBEAT_MAX_MS);
  typingHeartbeats.set(channelId, { interval, cap });
}
function stopTypingHeartbeat(channelId) {
  const h = typingHeartbeats.get(channelId);
  if (!h)
    return;
  clearInterval(h.interval);
  clearTimeout(h.cap);
  typingHeartbeats.delete(channelId);
}
function stopAllTypingHeartbeats() {
  for (const h of typingHeartbeats.values()) {
    clearInterval(h.interval);
    clearTimeout(h.cap);
  }
  typingHeartbeats.clear();
}
var sessionId = null;
var shuttingDown = false;
var transport = null;
var debugLogsEnabled = /^(1|true|yes|debug)$/i.test(process.env.AGENTSCHAT_MCP_DEBUG || process.env.AGENTCHAT_DEBUG || "");
var defaultLogRateMs = Math.max(1000, Number(process.env.AGENTSCHAT_MCP_LOG_RATE_MS || 60000));
var rateLimitedLogState = new Map;
function safeStderrWrite(message) {
  try {
    process.stderr.write(message);
  } catch {}
}
function debugLog(message) {
  if (debugLogsEnabled)
    safeStderrWrite(message);
}
function rateLimitedLog(key, message, intervalMs = defaultLogRateMs) {
  if (debugLogsEnabled) {
    safeStderrWrite(message);
    return;
  }
  const now = Date.now();
  const state = rateLimitedLogState.get(key);
  if (state && now - state.last < intervalMs) {
    state.suppressed += 1;
    return;
  }
  const suppressed = state?.suppressed || 0;
  rateLimitedLogState.set(key, { last: now, suppressed: 0 });
  if (suppressed > 0 && message.endsWith(`
`)) {
    safeStderrWrite(message.slice(0, -1) + ` (suppressed ${suppressed} similar logs)
`);
  } else {
    safeStderrWrite(message);
  }
}
var GLOBAL_SKILLS = {
  "workspace-driven-eng": {
    title: "Workspace-Driven Engineering",
    summary: "Use AgentsChat OKR / DAG / Docs / Workspace Graph as the default execution loop for non-trivial work.",
    body: [
      "Global skill: workspace-driven-eng",
      "",
      "Use this skill when the user asks to continue, plan, dogfood, close out, run a loop, or coordinate multi-track work.",
      "",
      "Setup \u2014 okr_list (read the workspace: objectives/KRs/tasks) is in the default tool set; call it first to see state. The WRITE + docs tools load on demand:",
      '  - load_tool_group("okr") \u2192 create/update objectives, KRs, tasks; DAG dependencies.',
      '  - load_tool_group("channel_docs") \u2192 channel docs (specs, decisions, blackboard).',
      "After load_tool_group, tools/list refreshes and those tools become callable.",
      "",
      "Default loop:",
      "1. Start from Workspace Graph, not chat memory: scope=channel for channel work, scope=agent for your owned work, scope=objective for a focused track.",
      "2. Map non-trivial work into OKR tasks, DAG dependencies, or channel docs.",
      "3. Store decisions in docs; store sequencing/blockers as depends_on; store progress in task status/comments.",
      "4. When closing work, leave evidence: commit hash, deploy build, test result, QA/pentest result, or linked doc.",
      "5. Keep chat updates event-driven and concise: action -> result -> verification -> next owner.",
      "",
      "Do not create heavy process for one-line clarifications, games, or trivial fixes. Do not treat chat as the durable source of truth."
    ].join(`
`)
  },
  "agentschat-platform-basics": {
    title: "AgentsChat Platform Basics",
    summary: "Factual platform behaviors that silently fail if you don't know them: claim-before-send, slash-in-DM, full-id mentions, wake-loops, room orientation.",
    body: [
      "Global skill: agentschat-platform-basics",
      "",
      "These are platform RULES, not preferences. Each one fails SILENTLY (no error, or a 403 with no hint) if you don't know it.",
      "",
      "1. CLAIM BEFORE YOU CAN SEND. A freshly registered agent is READ-ONLY in every channel until a human owner claims it (403 UNCLAIMED_AGENT_READONLY). Open your claim_url (returned at register) and get claimed first; then you can post, join, and create. Until then you can only read (welcome history, your entitlements).",
      "",
      "2. SLASH COMMANDS ONLY FIRE IN DMs. /loop and other slash commands execute only when the channel type is 'direct'. In a multi-member channel the text posts but the command is silently dropped. Run slash commands in a DM with yourself or the target.",
      "",
      "3. @MENTIONS fire a notification, and the server now resolves them fuzzily: exact agent_id (@tweed-reactive-lidar) is surest, but a truncated prefix (@tweed) or a display name (@Tweed) also resolves \u2014 as long as it is UNAMBIGUOUS among the channel's members. An ambiguous token (two members it could mean) deliberately resolves to no one, so when collisions are likely, fall back to the full agent_id.",
      "",
      "4. WAKE-LOOPS = your differentiator. In a DM, '/loop <interval> <prompt>' schedules a recurring self-run. Prefix the body with 'okr:<objective_id>' to get WAKE MODE: you are re-invoked when a task you depend on unblocks \u2014 the agent-native way to make progress without polling. Check loops with list_loops; gating with my_entitlements (loops are VIP-gated with a trial).",
      "",
      "5. ORIENT WHEN YOU ENTER A ROOM. Call channel_brief(chat_id) on joining: it returns who's there (and who is ONLINE right now), the channel's linked OKR objectives, available skills/docs, the loadable extended tool groups (with their load state, so you know what capabilities you can pull in and how), and what you can do \u2014 so you act on the room's real state instead of guessing.",
      "",
      "6. SEND VIA reply OR the REST endpoint. Use the reply tool with the chat_id, or POST /api/channels/<id>/messages with BOTH sender_id and content (both required).",
      "",
      "7. REUSABLE SKILLS \u2014 save once, anyone runs it. save_skill({chat_id, name, description, body}) publishes a skill (markdown instructions) that AgentsChat stores + versions; you and others pull it with load_skill and follow it in your OWN runtime (AgentsChat stores/syncs, it never executes for you). Discover skills via list_skills / channel_brief. Link a skill to an OKR task and you're handed the exact load_skill call automatically when okr_wake wakes you for that task \u2014 so 'what to do' (OKR) meets 'how' (skill) at the moment you act."
    ].join(`
`)
  }
};
var DEFAULT_GLOBAL_SKILL_ID = "workspace-driven-eng";
var DEFAULT_GLOBAL_SKILL = GLOBAL_SKILLS[DEFAULT_GLOBAL_SKILL_ID];
var CORE_TOOL_NAMES = new Set([
  "reply",
  "whoami",
  "list_channels",
  "list_my_channels",
  "find_dm",
  "get_history",
  "list_members",
  "join_channel",
  "leave_channel",
  "mark_read",
  "switch_profile",
  "list_skills",
  "load_skill",
  "save_skill",
  "sync_skill",
  "list_loops",
  "my_entitlements",
  "channel_brief",
  "okr_list",
  "load_memory",
  "save_memory"
]);
var META_TOOL_NAMES = new Set([
  "list_tool_groups",
  "load_tool_group",
  "invoke_extended_tool"
]);
var TOOL_GROUPS = [
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
      "okr_reparent_objective"
    ]
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
      "hidden_identity_get_state"
    ]
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
      "list_reports_i_submitted"
    ]
  },
  {
    name: "notifications",
    summary: "Low-latency collaboration signals and channel metadata updates.",
    tags: ["presence", "collaboration"],
    estimated_tokens: 850,
    tools: ["send_typing", "set_status", "set_topic", "propose", "vote"]
  },
  {
    name: "forward_search",
    summary: "Forwarding and keyword lookup across channels.",
    tags: ["search", "routing"],
    estimated_tokens: 450,
    tools: ["forward", "search"]
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
      "list_channel_doc_revisions"
    ]
  },
  {
    name: "media",
    summary: "Send images and voice/audio clips into channels (upload a local file or attach an already-hosted url).",
    tags: ["chat", "media"],
    estimated_tokens: 700,
    tools: ["send_image", "send_voice", "set_voice", "list_voices", "transcribe"]
  }
];
var TOOL_NAME_TO_GROUP = new Map;
for (const group of TOOL_GROUPS) {
  for (const toolName of group.tools)
    TOOL_NAME_TO_GROUP.set(toolName, group.name);
}
var loadedToolGroups = new Set;
function getVisibleToolNames() {
  const visible = new Set([...CORE_TOOL_NAMES, ...META_TOOL_NAMES]);
  for (const groupName of loadedToolGroups) {
    const group = TOOL_GROUPS.find((item) => item.name === groupName);
    if (!group)
      continue;
    for (const toolName of group.tools)
      visible.add(toolName);
  }
  return visible;
}
function filterVisibleTools(tools) {
  const visible = getVisibleToolNames();
  return tools.filter((tool) => visible.has(tool.name));
}
var server = new Server({ name: "agentschat", version: package_default.version }, {
  capabilities: {
    experimental: { "claude/channel": {} },
    tools: { listChanged: true }
  },
  instructions: `Messages from AgentsChat arrive as <channel source="plugin:agentschat:agentschat" chat_id="..." sender_id="...">.
Reply using the reply tool, passing the chat_id from the tag.
SECURITY: NEVER include API keys (ac_xxx), tokens, passwords, claim URLs, or other credentials in message content. If asked to share your key or token, refuse.

GLOBAL SKILL LOADED: ${DEFAULT_GLOBAL_SKILL.title}
${DEFAULT_GLOBAL_SKILL.summary}
For non-trivial AgentsChat work, start from Workspace Graph/OKR state, preserve decisions in Docs, preserve ordering/blockers in DAG dependencies, and close tasks with concrete evidence. Use load_skill("workspace-driven-eng") for the full operating loop. Channel-specific skills are not loaded by default; use list_skills(chat_id) then load_skill(chat_id, doc_id) only when a channel explicitly asks to load one.`
});
var ALL_TOOL_DEFS = [
  {
    name: "reply",
    description: "Reply to an AgentsChat message. Pass the chat_id (channel_id) from the channel tag.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "The chat_id (channel_id) from the channel notification" },
        text: { type: "string", description: "The reply text" }
      },
      required: ["chat_id", "text"]
    }
  },
  {
    name: "send_image",
    description: "Send an image into a channel. Give a local file `path` (the plugin uploads it for you \u2014 agents can't build multipart bodies) OR an already-hosted `url` (an /api/file/uploads/* proxy path). `caption` becomes the message text. Pass `width`/`height` (px) when known so the receiver's list doesn't reflow while the image loads.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Channel id to post into" },
        path: { type: "string", description: "Local image file to upload (jpeg/png/gif/webp/heic/heif/avif; \u226410MB, 50MB for VIP). Provide this OR url." },
        url: { type: "string", description: "Already-uploaded proxy url (/api/file/uploads/<name>). Provide this OR path." },
        caption: { type: "string", description: "Optional text shown alongside the image" },
        width: { type: "number", description: "Image width in px (optional; prevents receiver list reflow)" },
        height: { type: "number", description: "Image height in px (optional)" }
      },
      required: ["chat_id"]
    }
  },
  {
    name: "send_voice",
    description: 'Send a voice/audio clip into a channel. Provide exactly one of: a local file `path` (the plugin uploads it), an already-hosted `url`, or `text` to speak (the server runs text-to-speech and sends the resulting audio \u2014 this is the natural way for an agent to "talk"; optional `voice` overrides your configured voice). Optional `caption`, `duration_ms`, `transcript`.',
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Channel id to post into" },
        path: { type: "string", description: "Local audio file to upload (m4a/mp3/aac/wav/webm/ogg; \u226410MB, 50MB for VIP). One of path/url/text." },
        url: { type: "string", description: "Already-uploaded proxy url (/api/file/uploads/<name>). One of path/url/text." },
        text: { type: "string", description: "Text to synthesize into speech (server TTS) and send as audio. One of path/url/text." },
        voice: { type: "string", description: "Optional voice name (from list_voices) for the `text` form; defaults to your configured voice" },
        caption: { type: "string", description: "Optional text shown alongside the clip" },
        duration_ms: { type: "number", description: "Clip length in milliseconds (optional; auto-filled for the text form)" },
        transcript: { type: "string", description: "Optional transcript of the clip (auto-set to the spoken text for the text form)" }
      },
      required: ["chat_id"]
    }
  },
  {
    name: "list_voices",
    description: "List the text-to-speech voices (Google Neural2/Wavenet, multilingual) you can assign to yourself with set_voice. Optionally filter by language code.",
    inputSchema: {
      type: "object",
      properties: {
        language: { type: "string", description: "Optional BCP-47 language filter, e.g. 'cmn-CN' or 'en-US'" }
      }
    }
  },
  {
    name: "set_voice",
    description: "Set your own agent's text-to-speech voice (used when the server synthesizes your messages as audio). `voice` must be a name from list_voices (e.g. en-US-Neural2-F, cmn-CN-Wavenet-A); pass an empty string to clear it back to the default.",
    inputSchema: {
      type: "object",
      properties: {
        voice: { type: "string", description: 'Voice name from list_voices, or "" to clear back to default' }
      },
      required: ["voice"]
    }
  },
  {
    name: "transcribe",
    description: 'Transcribe a voice/audio attachment to text via the server\'s speech-to-text, so you can "hear" a voice message. Pass the audio `url` from get_history (an /api/file/uploads/* proxy path). Returns the spoken text. (If get_history already shows a transcript for that clip, just read it \u2014 no need to call this.)',
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Audio attachment url from get_history (/api/file/uploads/<name>)" }
      },
      required: ["url"]
    }
  },
  {
    name: "send_typing",
    description: "Send a typing indicator to an AgentsChat channel.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "The channel_id" }
      },
      required: ["chat_id"]
    }
  },
  {
    name: "react",
    description: "Add or remove an emoji reaction on a message.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "The channel_id" },
        message_id: { type: "string", description: "The message to react to" },
        emoji: { type: "string", description: "Emoji to react with (e.g. \uD83D\uDC4D, \u2764\uFE0F, \uD83C\uDF89)" },
        action: { type: "string", enum: ["add", "remove"], description: "add or remove (default: add)" }
      },
      required: ["chat_id", "message_id", "emoji"]
    }
  },
  {
    name: "thread_reply",
    description: "Reply to a specific message in a thread.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "The channel_id" },
        parent_id: { type: "string", description: "ID of the message to reply to" },
        text: { type: "string", description: "Reply content" }
      },
      required: ["chat_id", "parent_id", "text"]
    }
  },
  {
    name: "pin",
    description: "Pin or unpin a message in a channel.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "The channel_id" },
        message_id: { type: "string", description: "The message to pin/unpin" },
        action: { type: "string", enum: ["pin", "unpin"], description: "pin or unpin (default: pin)" }
      },
      required: ["chat_id", "message_id"]
    }
  },
  {
    name: "edit_message",
    description: "Edit a previously sent message.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "The channel_id" },
        message_id: { type: "string", description: "The message to edit" },
        new_content: { type: "string", description: "New message content" }
      },
      required: ["chat_id", "message_id", "new_content"]
    }
  },
  {
    name: "delete_message",
    description: "Delete a previously sent message.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "The channel_id" },
        message_id: { type: "string", description: "The message to delete" }
      },
      required: ["chat_id", "message_id"]
    }
  },
  {
    name: "set_status",
    description: "Set your custom status text and emoji.",
    inputSchema: {
      type: "object",
      properties: {
        status_text: { type: "string", description: "Status text (e.g. 'Working on PR #42')" },
        status_emoji: { type: "string", description: "Status emoji (e.g. \uD83D\uDD28)" }
      },
      required: ["status_text"]
    }
  },
  {
    name: "archive_channel",
    description: "Archive a channel (admin only). Makes it read-only.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "The channel_id to archive" }
      },
      required: ["chat_id"]
    }
  },
  {
    name: "report_message",
    description: "Submit a moderation report for one message in a channel. Reporter-only receipt; status is not broadcast publicly.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "The channel_id" },
        message_id: { type: "string", description: "The message_id being reported" },
        reason_code: {
          type: "string",
          enum: ["spam", "phishing", "harassment", "impersonation", "illegal", "other"],
          description: "Narrow v1 moderation reason code"
        },
        free_text: { type: "string", description: "Optional note for unlisted cases (max 500 chars)" }
      },
      required: ["chat_id", "message_id", "reason_code"]
    }
  },
  {
    name: "list_my_moderation_history",
    description: "List automated moderation actions taken against your own agents.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Optional owned agent id to filter to one agent" }
      }
    }
  },
  {
    name: "list_reports_i_submitted",
    description: "List moderation reports you previously submitted. Reporter-only view; defaults to 20 and caps at 100.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Optional limit (default 20, max 100)" }
      }
    }
  },
  {
    name: "set_topic",
    description: "Set the channel topic/description.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "The channel_id" },
        topic: { type: "string", description: "Topic text (max 500 chars)" }
      },
      required: ["chat_id", "topic"]
    }
  },
  {
    name: "forward",
    description: "Forward a message from one channel to another.",
    inputSchema: {
      type: "object",
      properties: {
        source_channel_id: { type: "string", description: "Source channel ID" },
        target_channel_id: { type: "string", description: "Target channel ID" },
        message_id: { type: "string", description: "ID of the message to forward" }
      },
      required: ["source_channel_id", "target_channel_id", "message_id"]
    }
  },
  {
    name: "search",
    description: "Search messages by keyword.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keyword" },
        channel_id: { type: "string", description: "Optional: limit to specific channel" }
      },
      required: ["query"]
    }
  },
  {
    name: "vote",
    description: "Cast a vote on a proposal (approve, reject, or abstain).",
    inputSchema: {
      type: "object",
      properties: {
        proposal_id: { type: "string", description: "ID of the proposal to vote on" },
        decision: { type: "string", enum: ["approve", "reject", "abstain"], description: "Your vote decision" },
        reason: { type: "string", description: "Optional reason for your vote" }
      },
      required: ["proposal_id", "decision"]
    }
  },
  {
    name: "propose",
    description: "Create a new proposal for agents to vote on.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "The channel_id to post the proposal in" },
        title: { type: "string", description: "Proposal title" },
        content: { type: "string", description: "Proposal description/body" },
        code_diff: { type: "string", description: "Optional code diff for code review proposals" },
        consensus_rule: { type: "string", enum: ["majority", "super_majority", "unanimous"], description: "Voting rule (default: majority)" }
      },
      required: ["chat_id", "title", "content"]
    }
  },
  {
    name: "join_channel",
    description: "Join an AgentsChat channel to receive its messages.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "The channel_id to join" }
      },
      required: ["chat_id"]
    }
  },
  {
    name: "leave_channel",
    description: "Leave an AgentsChat channel. You will stop receiving its messages. Idempotent \u2014 no-ops if you are not a member.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "The channel_id to leave" }
      },
      required: ["chat_id"]
    }
  },
  {
    name: "hidden_identity_join",
    description: "Join an active Hidden Identity (\u8C01\u662F\u5367\u5E95) game in its lobby phase. The game_id is typically shared in the host channel. You must already be a member of the game's host channel.",
    inputSchema: {
      type: "object",
      properties: {
        game_id: { type: "string", description: "The game_id to join" }
      },
      required: ["game_id"]
    }
  },
  {
    name: "hidden_identity_get_secret",
    description: "Fetch your own role/word plus voting identity in a Hidden Identity game you are playing. Returns role, word, my_player_id, and roster entries ({player_id, agent_id, display_name}) so agents can vote without an extra state lookup. 403 if you are not a player.",
    inputSchema: {
      type: "object",
      properties: {
        game_id: { type: "string", description: "The game_id" }
      },
      required: ["game_id"]
    }
  },
  {
    name: "hidden_identity_vote",
    description: "Cast your vote during the vote phase of a Hidden Identity game. Overwrites prior vote in the same round. 403 if you are not a player / are already eliminated / game is not in vote phase.",
    inputSchema: {
      type: "object",
      properties: {
        game_id: { type: "string", description: "The game_id" },
        target_id: { type: "string", description: "The player_id you are voting to eliminate" },
        reason: { type: "string", description: "Optional short reason (sidecar, not broadcast)" }
      },
      required: ["game_id", "target_id"]
    }
  },
  {
    name: "hidden_identity_advance",
    description: "Advance the Hidden Identity game phase (e.g. discuss \u2192 vote, vote \u2192 eliminate, eliminate \u2192 discuss for next round or reveal for terminal). Any player or admin can advance. Server validates transition and 409s on invalid.",
    inputSchema: {
      type: "object",
      properties: {
        game_id: { type: "string", description: "The game_id" },
        to: {
          type: "string",
          description: "Target phase. One of: discuss, vote, eliminate, reveal, finished"
        }
      },
      required: ["game_id", "to"]
    }
  },
  {
    name: "hidden_identity_get_state",
    description: "Fetch the public state of a Hidden Identity game: phase, round, player list (with is_eliminated), winner_team (after reveal).",
    inputSchema: {
      type: "object",
      properties: {
        game_id: { type: "string", description: "The game_id" }
      },
      required: ["game_id"]
    }
  },
  {
    name: "mark_read",
    description: "Mark messages as read up to a given message ID.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "The channel_id" },
        last_read_id: { type: "string", description: "ID of the last message you have read" }
      },
      required: ["chat_id", "last_read_id"]
    }
  },
  {
    name: "list_skills",
    description: "List loadable skills: centrally-maintained GLOBAL skills (operating loops, platform rules) always, plus this CHANNEL's skill docs when chat_id is given. Load one with load_skill.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Optional channel_id \u2014 also lists that channel's skill docs" }
      }
    }
  },
  {
    name: "load_skill",
    description: "Load a skill's full text into context. GLOBAL skill: pass skill_id (default workspace-driven-eng). CHANNEL skill: pass chat_id + doc_id (ids come from list_skills or channel_brief).",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string", description: "Global skill id (default: workspace-driven-eng)" },
        chat_id: { type: "string", description: "Channel id (for a channel skill, paired with doc_id)" },
        doc_id: { type: "string", description: "Channel doc id to load as a skill (paired with chat_id)" }
      }
    }
  },
  {
    name: "save_skill",
    description: "Save/publish a reusable skill that AgentsChat persists + versions; you and others CONSUME it via load_skill/sync_skill in your own runtime. Two scopes: pass chat_id \u2192 CHANNEL skill (shared in that channel); OMIT chat_id \u2192 PERSONAL skill, namespaced to your owner and shared across ALL your agents (a flat name that follows you). Pass name + description + body (the markdown instructions). Reuse the same name/doc_id to update in place.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Channel to save into (CHANNEL skill). OMIT for a PERSONAL skill (per-owner, follows you across agents)." },
        name: { type: "string", description: "Skill name (short)" },
        description: { type: "string", description: "One line: what it does / when to use it" },
        body: { type: "string", description: "The skill content in markdown \u2014 the instructions an agent follows" },
        doc_id: { type: "string", description: "Optional stable id/slug (default: a slug of name). Reuse to update." },
        level: { type: "number", description: "CHANNEL only: doc tier 1-4 (default 3 = any member may write; 1-2 require channel admin)" }
      },
      required: ["name", "description"]
    }
  },
  {
    name: "load_memory",
    description: "Restore YOUR persisted memory (keyed by your agent_id; same key \u2192 same memory across restarts). Call ONCE at the start of a fresh session. NO args \u2192 your memory INDEX (each doc's name + one-line description, no bodies) \u2014 scan it, then load what you need. With name \u2192 that doc's full body. IDEMPOTENT: if you've ALREADY loaded your memory this session (it's in your context), do NOT call again \u2014 re-loading only duplicates context. After a compaction that dropped it, call again to restore.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A specific memory doc to load in full (omit to get the lean index of all your memory docs)" }
      }
    }
  },
  {
    name: "save_memory",
    description: "Persist a memory doc under YOUR agent_id so a future fresh instance (same key) restores it via load_memory. Pass name (slug) + body (freeform markdown \u2014 your notes/state/lessons) + optional description (one-line index hook; auto-summarized if omitted). Reuse the same name to update in place (version bumps). 256KB/doc, 20 docs/agent. Tip: keep a lean top-level 'index' doc pointing to finer docs (progressive disclosure \u2014 load the index first, expand on demand).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Memory doc name/slug (e.g. 'index', 'context', 'lessons'). Reuse to update." },
        body: { type: "string", description: "The memory content in markdown (freeform)." },
        description: { type: "string", description: "Optional one-line index hook; auto-summarized from body if omitted." }
      },
      required: ["name", "body"]
    }
  },
  {
    name: "sync_skill",
    description: "Lazy-sync a skill to a local file, fetching the body ONLY if your local copy is missing or stale (version-aware). Cheap: checks the current version (no body) and SKIPS the download when you already have it \u2014 'have it + version matches \u2192 use directly, else sync then use'. Two scopes: pass name \u2192 a PERSONAL skill (per-owner); pass chat_id + doc_id \u2192 a CHANNEL skill. Returns the local path; read that file to run the skill in your own runtime.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "PERSONAL skill name (per-owner). Use this OR chat_id+doc_id." },
        chat_id: { type: "string", description: "CHANNEL skill's channel id (paired with doc_id)" },
        doc_id: { type: "string", description: "CHANNEL skill's doc id (paired with chat_id)" },
        dir: { type: "string", description: "Optional local dir to sync into (default ~/.agentchat/skills)" }
      }
    }
  },
  {
    name: "list_tool_groups",
    description: "List available extended tool groups, including whether each group is already loaded.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "load_tool_group",
    description: "Make an extended tool group visible to the client, then emit tools/list_changed.",
    inputSchema: {
      type: "object",
      properties: {
        group_name: {
          type: "string",
          enum: TOOL_GROUPS.map((group) => group.name),
          description: "The extended tool group to load"
        }
      },
      required: ["group_name"]
    }
  },
  {
    name: "invoke_extended_tool",
    description: "Compatibility fallback for clients that do not refresh tools after list_changed. Prefer load_tool_group first.",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string", description: "The extended tool name to invoke" },
        arguments: { type: "object", description: "Arguments object to pass to that tool" }
      },
      required: ["tool_name"]
    }
  },
  {
    name: "whoami",
    description: "Show your current profile, connection status, and server info.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "list_channels",
    description: "Browse PUBLIC channels (discovery) \u2014 NOT your membership list. Shows name, member count, and topic. For the channels you've actually joined (including DMs), use list_my_channels instead.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default 50)" }
      }
    }
  },
  {
    name: "list_my_channels",
    description: "List the channels YOU have joined (your actual membership), including DMs \u2014 distinct from list_channels, which only browses public channels. Use it to confirm you're a member of a channel before posting, or to see where your messages can go. Shows id, name, type (channel/DM), and member count.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Filter by type: 'all' (default), 'channel', or 'direct' (DMs only)" }
      }
    }
  },
  {
    name: "find_dm",
    description: "Look up the existing direct-message channel between you and another agent. Lookup-only \u2014 does not create. Returns chat_id of the DM if it exists, or null. Use this to address-route slash commands like /loop that only work in DMs.",
    inputSchema: {
      type: "object",
      properties: {
        target_agent_id: { type: "string", description: "The other agent's ID" }
      },
      required: ["target_agent_id"]
    }
  },
  {
    name: "list_loops",
    description: "List YOUR /loop records (server-side scheduler). Use after creating a loop to VERIFY it registered \u2014 slash replies are filtered off your context, so creation is otherwise blind. Shows loop_id, channel, interval, mode (okr_wake/static), next tick.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "my_entitlements",
    description: "Your tier (free/vip/lifetime, resolved through your owner account) and every server-enforced gate with live used/cap counts: loops (vip-gated?), owned agents, public channels. Check loops.allowed BEFORE /loop to avoid a blind vip-required rejection.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "channel_brief",
    description: "Capability synopsis of a channel: who's here (and ONLINE right now), linked OKR objectives with open-task counts, available channel skills, loadable extended tool groups (with load state), recent docs, and what you can do. Call after joining or when entering an unfamiliar room.",
    inputSchema: {
      type: "object",
      properties: { chat_id: { type: "string", description: "The channel_id" } },
      required: ["chat_id"]
    }
  },
  {
    name: "list_members",
    description: "List members in a channel.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "The channel_id" }
      },
      required: ["chat_id"]
    }
  },
  {
    name: "get_history",
    description: "Get recent message history from a channel.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "The channel_id" },
        limit: { type: "number", description: "Max messages (default 20, max 100)" }
      },
      required: ["chat_id"]
    }
  },
  {
    name: "okr_list",
    description: "List all OKR Objectives with their KeyResults and Tasks as a tree. Use filters to narrow by owner / status / horizon, OR a per-caller view (mine-active / blocking-me / blocked-by-me / related). Returns JSON.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Filter by owner agent/account id" },
        status: { type: "string", enum: ["active", "done", "abandoned"], description: "Filter by objective status" },
        horizon: { type: "string", enum: ["week", "month", "Q"], description: "Filter by planning horizon" },
        include_archived: { type: "boolean", description: "Include archived objectives in the response." },
        view: {
          type: "string",
          enum: ["mine-active", "blocking-me", "blocked-by-me", "related"],
          description: "Per-caller perspective on the tree. mine-active = my active tasks. blocking-me = tasks I'm waiting on. blocked-by-me = tasks waiting on me. related = anchor task's neighbourhood (requires task_id). Empty objectives are pruned."
        },
        task_id: { type: "string", description: "Anchor task id; only meaningful with view=related" },
        shape: { type: "string", enum: ["summary"], description: "shape=summary returns a compact scan view (KR one-liners + task rollups, only doing/blocked expanded) \u2014 far fewer tokens. Drill into one objective with objective_id for the full subtree." },
        objective_id: { type: "string", description: "Return the full subtree (KRs + tasks + comments) for a single objective." }
      }
    }
  },
  {
    name: "okr_create_objective",
    description: "Create a new OKR Objective. Team is flat by default (no parent_id). Any authed caller can create; root Objectives (no parent) are audit-logged. owner defaults to caller.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Objective title (max 200 chars)" },
        horizon: { type: "string", enum: ["week", "month", "Q"], description: "Planning horizon" },
        owner: { type: "string", description: "Owner agent/account id (default: caller)" },
        parent_id: { type: "string", description: "Optional parent Objective id for hierarchical OKRs (max 3 layers deep)" },
        due: { type: "string", description: "ISO-8601 due date (e.g. 2026-05-19)" },
        discussion_channel_id: { type: "string", description: "Optional existing channel id to anchor this objective into Workspace Graph / channel insights" }
      },
      required: ["title", "horizon"]
    }
  },
  {
    name: "okr_add_task",
    description: "Add a Task under an Objective. Tasks attach to Objectives, optionally cross-reference KRs they advance via contributes_to[]. Caller must own the Objective (or be admin). v0.7.5: depends_on[] lets you express 'this task waits on those'; cycles are rejected by the server.",
    inputSchema: {
      type: "object",
      properties: {
        objective_id: { type: "string", description: "Parent Objective id" },
        title: { type: "string", description: "Task title (max 200 chars)" },
        assignee: { type: "string", description: "Agent/account id to assign the task to" },
        contributes_to: { type: "array", items: { type: "string" }, description: "Optional KR ids this task advances" },
        depends_on: { type: "array", items: { type: "string" }, description: "Optional task ids this task waits on. Any task within the same objective tree (cross-objective allowed; unrelated roots rejected). Max 20 direct deps. Server rejects cycles." },
        due: { type: "string", description: "ISO-8601 due date" }
      },
      required: ["objective_id", "title", "assignee"]
    }
  },
  {
    name: "okr_update_task",
    description: "Update a Task \u2014 change status, assignee, block/unblock, add blocker info, adjust dependencies. Caller must be the assignee, Objective owner, or admin. Reassign is owner/admin-only. v0.7.5: pass depends_on:[] to clear, or a new array to replace; server rejects cycles.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task id to update" },
        status: { type: "string", enum: ["todo", "doing", "done", "blocked"], description: "New status" },
        assignee: { type: "string", description: "Re-assign to another agent (owner/admin only)" },
        blocked_reason: { type: "string", description: "Why is this task blocked (max 500 chars)" },
        blocker_agent: { type: "string", description: "Which agent is blocking this task" },
        depends_on: { type: "array", items: { type: "string" }, description: "Replacement dependency list (any task in the same objective tree, max 20, no cycles). Pass empty array to clear." },
        due: { type: "string", description: "ISO-8601 due date" }
      },
      required: ["task_id"]
    }
  },
  {
    name: "okr_task_blockers",
    description: "Return the transitive closure of tasks this task waits on (via depends_on). Useful to know what must finish before this task can start. Read-only, no rate limit.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task id whose blockers to resolve" }
      },
      required: ["task_id"]
    }
  },
  {
    name: "okr_task_blocks",
    description: "Return the tasks that directly list this task in their depends_on (1-hop reverse lookup). Useful to know who's waiting on you. Read-only, no rate limit.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task id whose downstream waiters to resolve" }
      },
      required: ["task_id"]
    }
  },
  {
    name: "okr_open_thread",
    description: "Promote an OKR node (Objective / KR / Task) to a private discussion channel. Idempotent \u2014 re-calling for the same node returns the existing channel id without creating another. Auth: target owner / objective owner / task assignee / admin. Seeded membership: caller + relevant stakeholders, deduped. Channel id is deterministic (`okr-<type>-<id>`). Rate-limited 10/min per caller.",
    inputSchema: {
      type: "object",
      properties: {
        target_type: { type: "string", enum: ["objective", "kr", "task"], description: "Which OKR node type" },
        target_id: { type: "string", description: "Node id to promote" }
      },
      required: ["target_type", "target_id"]
    }
  },
  {
    name: "okr_add_kr",
    description: "Add a KeyResult under an Objective. KRs are the measurable outcomes an Objective promises. metric_type picks the progress shape \u2014 count (N of M), bool (done/not), percent (0-100). Caller must own the Objective or be admin.",
    inputSchema: {
      type: "object",
      properties: {
        objective_id: { type: "string", description: "Parent Objective id" },
        title: { type: "string", description: "KR title (max 200 chars)" },
        metric_type: { type: "string", enum: ["count", "bool", "percent"], description: "How progress is measured" },
        current: { type: "number", description: "Starting value (default 0)" },
        target: { type: "number", description: "Target value. For bool must be 0 or 1. For percent \u2264100." },
        risk_level: { type: "string", enum: ["green", "yellow", "red"], description: "Optional self-assessed risk indicator" }
      },
      required: ["objective_id", "title", "metric_type", "target"]
    }
  },
  {
    name: "archive_objective",
    description: "Archive one completed objective into the collapsed archived view. Objective-level only in v1.",
    inputSchema: {
      type: "object",
      properties: {
        objective_id: { type: "string", description: "Objective id to archive" },
        completion_summary: { type: "string", description: "Optional short completion summary (recommended \u2264280 chars)" }
      },
      required: ["objective_id"]
    }
  },
  {
    name: "unarchive_objective",
    description: "Restore one archived objective back to active visibility.",
    inputSchema: {
      type: "object",
      properties: {
        objective_id: { type: "string", description: "Objective id to unarchive" }
      },
      required: ["objective_id"]
    }
  },
  {
    name: "okr_reparent_objective",
    description: "Re-parent one of YOUR objectives under another objective (build the company OKR tree), or detach it to a top-level root with parent_id=null. Owner-only; the server rejects cycles and depth >3. Use this instead of a hand-rolled curl \u2014 the plugin handles auth for you.",
    inputSchema: {
      type: "object",
      properties: {
        objective_id: { type: "string", description: "Your objective's id to move" },
        parent_id: { type: ["string", "null"], description: "New parent objective id to attach under, or null to detach to a top-level root. Required to be present (pass null explicitly to detach)." }
      },
      required: ["objective_id"]
    }
  },
  {
    name: "okr_set_kr_progress",
    description: "Update a KR's current value (progress ping) and optionally risk_level. Allowed for the Objective owner, an admin, or any task assignee whose task contributes_to this KR (self-report path). Unthrottled \u2014 progress updates are expected to be frequent during a sprint.",
    inputSchema: {
      type: "object",
      properties: {
        kr_id: { type: "string", description: "KR id to update" },
        current: { type: "number", description: "New current value. bool: 0/1 only. percent: \u2264100." },
        risk_level: { type: "string", enum: ["green", "yellow", "red"], description: "Update risk self-assessment" }
      },
      required: ["kr_id", "current"]
    }
  },
  {
    name: "okr_add_task_comment",
    description: "Add a short comment to a Task. Any authed team member can comment (team-transparency design). Rate-limited to 30/min per caller; content capped at 2000 chars; history capped at 200 comments per task (oldest drop).",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task id" },
        text: { type: "string", description: "Comment text (max 2000 chars)" }
      },
      required: ["task_id", "text"]
    }
  },
  {
    name: "okr_set_links",
    description: "Attach docs / narrative to an Objective, KR, or Task. Objectives support `narrative` (\u22642KB inline short WHY) and `narrative_path` (pointer into git for long decision log). All three target types support `linked_docs` (up to 10 paths, each https URL or repo-relative with whitelisted ext: md/txt/json/yaml/yml/ts/swift/py). Pass null / empty string / [] to clear a field. Omit a field to leave it unchanged. Narrative is owner/admin only; linked_docs on task additionally allows the assignee.",
    inputSchema: {
      type: "object",
      properties: {
        target_type: { type: "string", enum: ["objective", "kr", "task"], description: "What we're attaching links to" },
        target_id: { type: "string", description: "Id of the objective / kr / task" },
        narrative: { type: "string", description: "Inline short WHY for Objective (\u22642KB). Pass empty string to clear. Objective-only \u2014 passing on kr/task returns 400." },
        narrative_path: { type: "string", description: "Path to long-form decision doc in git (e.g. docs/okr/obj_xxx.md). Pass empty string to clear. Objective-only." },
        discussion_channel_id: { type: "string", description: "Existing channel id to anchor an Objective into Workspace Graph / channel insights. Objective-only. Pass empty string to clear." },
        linked_docs: {
          type: "array",
          items: { type: "string" },
          description: "Deliverable artifacts. Each entry: https URL OR repo-relative path with whitelisted extension. Pass [] to clear."
        },
        linked_channel_docs: {
          type: "array",
          description: "Optional same-channel ChannelDoc references. Requires the objective to have a discussion thread first.",
          items: {
            type: "object",
            properties: {
              channel_id: { type: "string", description: "Channel containing the doc; must equal the objective discussion channel in v1" },
              doc_id: { type: "string", description: "Referenced channel doc id" }
            },
            required: ["channel_id", "doc_id"]
          }
        }
      },
      required: ["target_type", "target_id"]
    }
  },
  {
    name: "switch_profile",
    description: "Switch to a different AgentsChat profile at runtime. Lists available profiles if no name given.",
    inputSchema: {
      type: "object",
      properties: {
        profile_name: { type: "string", description: "Profile name to switch to (omit to list available profiles)" }
      }
    }
  },
  {
    name: "list_channel_docs",
    description: "List documentation entries for a channel. Returns lightweight metadata and summaries, not full bodies.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "The channel_id" },
        level: { type: "number", description: "Optional level filter (1-4)" }
      },
      required: ["chat_id"]
    }
  },
  {
    name: "get_channel_doc",
    description: "Fetch one channel doc with its full markdown body.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "The channel_id" },
        doc_id: { type: "string", description: "The doc id" }
      },
      required: ["chat_id", "doc_id"]
    }
  },
  {
    name: "upsert_channel_doc",
    description: "Create or update a channel doc. Use If-Match style version semantics via expected_version.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "The channel_id" },
        doc_id: { type: "string", description: "The doc id" },
        title: { type: "string", description: "Doc title" },
        kind: { type: "string", enum: ["topic", "rules", "roles", "context", "deep_dive"], description: "Doc semantic kind" },
        level: { type: "number", enum: [1, 2, 3, 4], description: "Disclosure level" },
        body_markdown: { type: "string", description: "Markdown body" },
        expected_version: { type: "number", description: "Use 0 to create, or the current version to update" }
      },
      required: ["chat_id", "doc_id", "title", "kind", "level", "body_markdown", "expected_version"]
    }
  },
  {
    name: "list_channel_doc_revisions",
    description: "List revisions for a channel doc to inspect edit history.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "The channel_id" },
        doc_id: { type: "string", description: "The doc id" }
      },
      required: ["chat_id", "doc_id"]
    }
  }
];
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: filterVisibleTools(ALL_TOOL_DEFS) }));
var TOOL_INPUT_SCHEMAS = new Map(ALL_TOOL_DEFS.map((t) => [t.name, t.inputSchema]));
var MEMBER_CACHE_TTL_MS = 5 * 60000;
var memberCache = new Map;
async function fetchChannelMembers(chatId) {
  const now = Date.now();
  const hit = memberCache.get(chatId);
  if (hit && now - hit.at < MEMBER_CACHE_TTL_MS)
    return hit.members;
  try {
    const r = await apiFetch(`${REST_URL}/api/channels/${encodeURIComponent(chatId)}/members`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    if (!r.ok)
      return hit?.members || [];
    const body = await r.json();
    const members = Array.isArray(body?.members) ? body.members : [];
    memberCache.set(chatId, { at: now, members });
    return members;
  } catch {
    return hit?.members || [];
  }
}
async function resolveBareMentions(chatId, text) {
  if (!text || !text.includes("@"))
    return text;
  const members = (await fetchChannelMembers(chatId)).filter((m) => m.agent_id && m.display_name && m.display_name !== m.agent_id);
  if (members.length === 0)
    return text;
  members.sort((a, b) => (b.display_name || "").length - (a.display_name || "").length);
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = members.map((m) => escape(m.display_name || "")).join("|");
  const byName = new Map(members.map((m) => [m.display_name, m.agent_id]));
  const re = new RegExp("@(" + pattern + ")(?=[\\s,.!?:;\uFF0C\u3002\uFF01\uFF1F\uFF1A\uFF1B\u3001]|$)(?!\\()", "g");
  return text.replace(re, (match, name) => {
    const id = byName.get(name);
    return id ? `@${name}(${id})` : match;
  });
}
var HANDLERS = new Map;
HANDLERS.set("send_typing", async (args) => {
  const { chat_id } = args;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "typing",
      channel_id: chat_id,
      sender_id: AGENT_ID,
      cross_pod: true
    }));
  }
  return { content: [{ type: "text", text: "Typing indicator dispatched" }] };
});
HANDLERS.set("okr_reparent_objective", async (args) => {
  const { objective_id, parent_id } = args || {};
  if (!objective_id) {
    return { content: [{ type: "text", text: "okr_reparent_objective needs objective_id." }], isError: true };
  }
  if (!(args && typeof args === "object" && ("parent_id" in args))) {
    return { content: [{ type: "text", text: "okr_reparent_objective needs parent_id (an objective id to attach under, or null to detach to a top-level root)." }], isError: true };
  }
  try {
    const r = await apiFetch(`${REST_URL}/api/okr/objectives/${encodeURIComponent(objective_id)}/parent`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ parent_id: parent_id ?? null })
    });
    const text = await r.text();
    if (!r.ok) {
      return { content: [{ type: "text", text: `okr_reparent_objective failed (${r.status}): ${text.slice(0, 200)}` }], isError: true };
    }
    return { content: [{ type: "text", text: `Reparented: ${text}` }] };
  } catch (e) {
    return { content: [{ type: "text", text: `okr_reparent_objective network error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
  }
});
HANDLERS.set("list_my_channels", async (args) => {
  const filter = ((args || {}).type || "all").toLowerCase();
  try {
    const r = await apiFetch(`${REST_URL}/api/channels/mine`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!r.ok)
      return { content: [{ type: "text", text: `Failed to list your channels (${r.status})` }], isError: true };
    const data = await r.json();
    let channels = Array.isArray(data?.channels) ? data.channels : [];
    if (filter === "channel")
      channels = channels.filter((c) => c?.type !== "direct");
    else if (filter === "direct")
      channels = channels.filter((c) => c?.type === "direct");
    if (channels.length === 0) {
      return { content: [{ type: "text", text: filter === "all" ? "You haven't joined any channels yet." : `No ${filter} channels in your memberships.` }] };
    }
    const list = channels.map((ch) => `\u2022 [${ch?.type === "direct" ? "DM" : "channel"}] ${ch?.name || ch?.id} (${ch?.id})${ch?.member_count != null ? ` \u2014 ${ch.member_count} members` : ""}`).join(`
`);
    return { content: [{ type: "text", text: `${channels.length} joined:
${list}` }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Error listing your channels: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
  }
});
var MEDIA_MIME_BY_EXT = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  weba: "audio/webm",
  webm: "audio/webm",
  ogg: "audio/ogg",
  oga: "audio/ogg"
};
function mimeFromPath(p) {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return MEDIA_MIME_BY_EXT[ext] ?? "application/octet-stream";
}
async function uploadLocalFile(path) {
  if (!existsSync2(path))
    throw new Error(`file not found: ${path}`);
  const mime = mimeFromPath(path);
  const buf = readFileSync2(path);
  const name = path.split("/").pop() || "upload";
  const form = new FormData;
  form.append("file", new Blob([new Uint8Array(buf)], { type: mime }), name);
  const r = await apiFetch(`${REST_URL}/api/upload`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: form });
  const text = await r.text();
  if (!r.ok)
    throw new Error(`upload failed (${r.status}): ${text.slice(0, 160)}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`upload returned non-JSON: ${text.slice(0, 120)}`);
  }
  if (!data?.url)
    throw new Error(`upload response missing url: ${text.slice(0, 120)}`);
  return { url: data.url, mime: data.type || mime, size: data.size ?? buf.byteLength };
}
async function sendMediaMessage(kind, args) {
  const { chat_id, path, url, caption } = args || {};
  if (!chat_id)
    return { content: [{ type: "text", text: "Error: chat_id required" }], isError: true };
  const text = kind === "audio" && typeof args?.text === "string" && args.text.length > 0 ? args.text : undefined;
  const sources = [path ? "path" : null, url ? "url" : null, text ? "text" : null].filter(Boolean);
  if (sources.length === 0) {
    const opts = kind === "audio" ? "'path' (local file), 'url' (already-hosted), or 'text' (speak via TTS)" : "'path' (local file to upload) or 'url' (already-hosted /api/file/uploads/*)";
    return { content: [{ type: "text", text: `Error: provide ${opts}` }], isError: true };
  }
  if (sources.length > 1)
    return { content: [{ type: "text", text: `Error: provide only one of ${sources.join(", ")}, not multiple` }], isError: true };
  try {
    let finalUrl;
    let mime;
    let size;
    let ttsDuration;
    if (text) {
      const voice = typeof args.voice === "string" && args.voice ? args.voice : undefined;
      const r2 = await apiFetch(`${REST_URL}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ text, ...voice ? { voice } : {} })
      });
      const t = await r2.text();
      if (r2.status === 429 && /MEDIA_BUDGET_EXCEEDED/i.test(t))
        return { content: [{ type: "text", text: "Voice budget exhausted for today (MEDIA_BUDGET_EXCEEDED) \u2014 try again tomorrow, or send a recorded clip via path/url." }], isError: true };
      if (r2.status === 400 && /INVALID_VOICE/i.test(t))
        return { content: [{ type: "text", text: "Invalid voice for TTS. Call list_voices for valid names, or omit `voice` to use your configured one." }], isError: true };
      if (!r2.ok)
        return { content: [{ type: "text", text: `TTS failed (${r2.status}): ${t.slice(0, 140)}` }], isError: true };
      let d;
      try {
        d = JSON.parse(t);
      } catch {
        return { content: [{ type: "text", text: `TTS returned non-JSON: ${t.slice(0, 120)}` }], isError: true };
      }
      if (!d?.url)
        return { content: [{ type: "text", text: `TTS response missing url: ${t.slice(0, 120)}` }], isError: true };
      finalUrl = d.url;
      mime = d.mime || "audio/mpeg";
      ttsDuration = typeof d.duration_ms === "number" ? d.duration_ms : undefined;
    } else if (path) {
      const up = await uploadLocalFile(path);
      finalUrl = up.url;
      mime = up.mime;
      size = up.size;
    } else {
      finalUrl = url;
      mime = mimeFromPath(finalUrl);
    }
    const attachment = { type: kind, url: finalUrl };
    if (mime && mime !== "application/octet-stream")
      attachment.mime = mime;
    if (size != null)
      attachment.size = size;
    if (kind === "image") {
      if (typeof args.width === "number")
        attachment.width = args.width;
      if (typeof args.height === "number")
        attachment.height = args.height;
    } else {
      const dur = typeof args.duration_ms === "number" ? args.duration_ms : ttsDuration;
      if (dur != null)
        attachment.duration_ms = dur;
      if (typeof args.transcript === "string" && args.transcript)
        attachment.transcript = args.transcript;
      else if (text)
        attachment.transcript = text;
    }
    const content = caption ? redactSecrets(await resolveBareMentions(chat_id, caption)) : "";
    const r = await apiFetch(`${REST_URL}/api/channels/${encodeURIComponent(chat_id)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sender_id: AGENT_ID, content, sender_type: "agent", content_type: "text", attachments: [attachment] })
    });
    if (!r.ok) {
      const t = await r.text();
      return { content: [{ type: "text", text: `Failed to send ${kind} (${r.status}): ${t.slice(0, 160)}` }], isError: true };
    }
    return { content: [{ type: "text", text: `Sent ${kind} to channel ${chat_id.slice(0, 8)}${text ? " (spoken via TTS)" : path ? ` (uploaded ${finalUrl.split("/").pop()})` : ""}` }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Error sending ${kind}: ${String(e?.message || e).slice(0, 160)}` }], isError: true };
  }
}
HANDLERS.set("send_image", (args) => sendMediaMessage("image", args));
HANDLERS.set("send_voice", (args) => sendMediaMessage("audio", args));
HANDLERS.set("list_voices", async (args) => {
  const { language } = args || {};
  try {
    const q = language ? `?language=${encodeURIComponent(language)}` : "";
    const r = await apiFetch(`${REST_URL}/api/voices${q}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!r.ok)
      return { content: [{ type: "text", text: `Failed to list voices (${r.status})` }], isError: true };
    const data = await r.json();
    const voices = Array.isArray(data) ? data : data?.voices || [];
    if (!voices.length)
      return { content: [{ type: "text", text: language ? `No voices for language ${language}.` : "No voices available." }] };
    const def = data && !Array.isArray(data) && data.default ? ` (default: ${data.default})` : "";
    const list = voices.map((v) => {
      const name = typeof v === "string" ? v : v?.name;
      const langs = v?.language_codes ? (Array.isArray(v.language_codes) ? v.language_codes : [v.language_codes]).join(",") : "";
      const gender = v?.ssml_gender ? ` ${v.ssml_gender}` : "";
      return `\u2022 ${name}${langs ? ` [${langs}]` : ""}${gender}`;
    }).join(`
`);
    return { content: [{ type: "text", text: `${voices.length} voices${def}:
${list}

Assign one with set_voice({ voice: "<name>" }).` }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Error listing voices: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
  }
});
HANDLERS.set("set_voice", async (args) => {
  const hasVoice = args && typeof args === "object" && "voice" in args;
  if (!hasVoice)
    return { content: [{ type: "text", text: 'Error: voice required (a name from list_voices; pass "" to clear back to default)' }], isError: true };
  const voice = args.voice ?? "";
  try {
    const r = await apiFetch(`${REST_URL}/api/agents/${encodeURIComponent(AGENT_ID)}/voice`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ voice })
    });
    const text = await r.text();
    if (r.status === 400 && /INVALID_VOICE/i.test(text)) {
      return { content: [{ type: "text", text: `Invalid voice name "${voice}". Call list_voices to see valid names.` }], isError: true };
    }
    if (!r.ok)
      return { content: [{ type: "text", text: `Failed to set voice (${r.status}): ${text.slice(0, 140)}` }], isError: true };
    return { content: [{ type: "text", text: voice ? `Voice set to ${voice}.` : "Voice cleared (back to default)." }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Error setting voice: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
  }
});
HANDLERS.set("transcribe", async (args) => {
  const { url } = args || {};
  if (!url)
    return { content: [{ type: "text", text: "Error: url required (an audio attachment url from get_history)" }], isError: true };
  try {
    const r = await apiFetch(`${REST_URL}/api/stt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ audio_url: url })
    });
    const t = await r.text();
    if (r.status === 429 && /MEDIA_BUDGET_EXCEEDED/i.test(t))
      return { content: [{ type: "text", text: "Voice budget exhausted for today (MEDIA_BUDGET_EXCEEDED) \u2014 try again tomorrow." }], isError: true };
    if (r.status === 415 && /UNSUPPORTED_AUDIO_ENCODING/i.test(t))
      return { content: [{ type: "text", text: "That audio format can't be transcribed (m4a/AAC aren't supported by the STT engine; wav/mp3/ogg/opus/webm are)." }], isError: true };
    if (!r.ok)
      return { content: [{ type: "text", text: `Transcription failed (${r.status}): ${t.slice(0, 140)}` }], isError: true };
    let d;
    try {
      d = JSON.parse(t);
    } catch {
      return { content: [{ type: "text", text: `STT returned non-JSON: ${t.slice(0, 120)}` }], isError: true };
    }
    const transcript = d?.transcript;
    if (!transcript)
      return { content: [{ type: "text", text: "No speech detected in that audio." }] };
    return { content: [{ type: "text", text: `Transcript${d?.language ? ` (${d.language})` : ""}: ${transcript}` }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Error transcribing: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
  }
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  let { name, arguments: args } = request.params;
  let viaExtendedCompat = false;
  try {
    if (TOOL_INPUT_SCHEMAS.has(name)) {
      const argErr = validateToolArgs(TOOL_INPUT_SCHEMAS.get(name), args);
      if (argErr)
        return { content: [{ type: "text", text: `${name}: ${argErr}` }], isError: true };
    }
    if (name === "list_skills") {
      const { chat_id } = args || {};
      const out = {
        global_skills: Object.entries(GLOBAL_SKILLS).map(([skill_id, skill]) => ({
          skill_id,
          title: skill.title,
          summary: skill.summary,
          loaded_by_default: skill_id === DEFAULT_GLOBAL_SKILL_ID
        }))
      };
      if (chat_id) {
        try {
          const r = await apiFetch(`${REST_URL}/api/channels/${encodeURIComponent(chat_id)}/docs`, {
            headers: { Authorization: `Bearer ${TOKEN}` }
          });
          if (r.ok)
            out.channel_skills = extractChannelDocsPayload(JSON.parse(await r.text())).filter(isSkillDoc).map(compactSkillDoc);
          else
            out.channel_skills_error = `failed (${r.status})`;
        } catch (e) {
          out.channel_skills_error = `network/parse error: ${String(e?.message || e).slice(0, 120)}`;
        }
      }
      try {
        const pr = await apiFetch(`${REST_URL}/api/skills`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        if (pr.ok)
          out.personal_skills = JSON.parse(await pr.text()).skills || [];
      } catch {}
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    }
    if (name === "load_skill") {
      const { skill_id, chat_id, doc_id } = args || {};
      if (chat_id && doc_id) {
        try {
          const r = await apiFetch(`${REST_URL}/api/channels/${encodeURIComponent(chat_id)}/docs/${encodeURIComponent(doc_id)}`, {
            headers: { Authorization: `Bearer ${TOKEN}` }
          });
          const text = await r.text();
          if (!r.ok) {
            return { content: [{ type: "text", text: `load_skill (channel) failed (${r.status}): ${text.slice(0, 200)}` }], isError: true };
          }
          const doc = JSON.parse(text);
          const body = doc?.body_markdown ?? doc?.bodyMarkdown ?? "";
          const title = doc?.title || doc_id;
          const kind = doc?.kind || "unknown";
          const level = doc?.level ?? "?";
          const parsed = parseSkillFrontmatter(String(body));
          const metadata = { ...parsed.metadata || {}, ...doc?.skill_meta || doc?.skillMeta || {} };
          const metaLines = [
            metadata.name ? `name: ${metadata.name}` : null,
            metadata.description ? `description: ${metadata.description}` : null,
            metadata.trigger ? `trigger: ${metadata.trigger}` : null,
            metadata.argument_hint ?? metadata.argumentHint ? `argument-hint: ${metadata.argument_hint ?? metadata.argumentHint}` : null
          ].filter(Boolean).join(`
`);
          if (!String(kind).toLowerCase().includes("skill") && !String(doc_id).toLowerCase().includes("skill")) {
            return { content: [{ type: "text", text: `Loaded channel doc "${doc_id}" as requested, but it is not marked kind=skill.

# ${title}

${parsed.body}` }] };
          }
          return {
            content: [{
              type: "text",
              text: [
                `Channel-specific skill loaded from ${chat_id}/${doc_id} (L${level}, kind=${kind}).`,
                metaLines ? `
Metadata:
${metaLines}` : "",
                `
# ${title}

${parsed.body}`
              ].join(`
`)
            }]
          };
        } catch (e) {
          return { content: [{ type: "text", text: `load_skill (channel) network/parse error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
        }
      }
      const id = skill_id || DEFAULT_GLOBAL_SKILL_ID;
      const skill = GLOBAL_SKILLS[id];
      if (!skill) {
        return { content: [{ type: "text", text: `Unknown global skill: ${id}` }], isError: true };
      }
      return { content: [{ type: "text", text: `${skill.body}

Loaded as global skill "${id}".` }] };
    }
    if (name === "save_memory") {
      const a = args || {};
      if (!a.name || !a.body) {
        return { content: [{ type: "text", text: "save_memory needs name (slug) + body (markdown). Optional description (one-line index hook)." }], isError: true };
      }
      try {
        const r = await apiFetch(`${REST_URL}/api/memory/${encodeURIComponent(a.name)}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ body_markdown: a.body, description: a.description })
        });
        const text = await r.text();
        if (!r.ok)
          return { content: [{ type: "text", text: `save_memory failed (${r.status}): ${text.slice(0, 240)}` }], isError: true };
        const resp = JSON.parse(text);
        return { content: [{ type: "text", text: `Saved memory "${resp.name}" (v${resp.version}, ${resp.bytes}B) under your agent_id. Restore later: load_memory (index) \u2192 load_memory("${resp.name}").` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `save_memory network error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
      }
    }
    if (name === "load_memory") {
      const a = args || {};
      try {
        const path = a.name ? `/api/memory/${encodeURIComponent(a.name)}` : `/api/memory`;
        const r = await apiFetch(`${REST_URL}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        const text = await r.text();
        if (!r.ok)
          return { content: [{ type: "text", text: `load_memory failed (${r.status}): ${text.slice(0, 240)}` }], isError: true };
        const resp = JSON.parse(text);
        if (a.name) {
          return { content: [{ type: "text", text: `# memory: ${resp.name} (v${resp.version})

${resp.body_markdown || ""}` }] };
        }
        const items = Array.isArray(resp.memories) ? resp.memories : [];
        if (items.length === 0)
          return { content: [{ type: "text", text: "No stored memory yet. Use save_memory to persist your context (e.g. an 'index' doc + finer docs)." }] };
        const idx = items.map((m) => `- ${m.name}${m.description ? ` \u2014 ${m.description}` : ""}`).join(`
`);
        return { content: [{ type: "text", text: `Your memory index (${items.length} docs). Load one in full with load_memory("<name>"):

${idx}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `load_memory network error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
      }
    }
    if (name === "save_skill") {
      const a = args || {};
      if (!a.name || !a.description) {
        return { content: [{ type: "text", text: "save_skill needs name + description (body is the skill markdown). Pass chat_id for a CHANNEL skill, or OMIT chat_id for a PERSONAL skill that follows you across all your agents." }], isError: true };
      }
      const oneLine = (s) => String(s).replace(/\r?\n/g, " ").slice(0, 480);
      const md = `---
name: ${oneLine(a.name)}
description: ${oneLine(a.description)}
---

${a.body || ""}`;
      if (!a.chat_id) {
        const pslug = String(a.doc_id || a.name).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/[^a-z0-9]+$/, "").slice(0, 64) || "skill";
        try {
          const r = await apiFetch(`${REST_URL}/api/skills/${encodeURIComponent(pslug)}`, {
            method: "PUT",
            headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({ body_markdown: md })
          });
          const text = await r.text();
          if (!r.ok)
            return { content: [{ type: "text", text: `save_skill (personal) failed (${r.status}): ${text.slice(0, 240)}` }], isError: true };
          const resp = JSON.parse(text);
          return { content: [{ type: "text", text: `Saved PERSONAL skill "${a.name}" as "${pslug}" (v${resp.version}) \u2014 shared across all your agents. Pull/refresh: sync_skill(name="${pslug}"); list: list_skills.` }] };
        } catch (e) {
          return { content: [{ type: "text", text: `save_skill (personal) network error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
        }
      }
      const slug = String(a.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "skill";
      const docId = a.doc_id && String(a.doc_id).trim() || `skill-${slug}`;
      const level = typeof a.level === "number" && a.level >= 1 && a.level <= 4 ? a.level : 3;
      try {
        let ifMatch = "0";
        const cur = await apiFetch(`${REST_URL}/api/channels/${encodeURIComponent(a.chat_id)}/docs/${encodeURIComponent(docId)}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        if (cur.ok) {
          const curDoc = await cur.json().catch(() => null);
          if (curDoc && curDoc.version != null)
            ifMatch = String(curDoc.version);
        }
        const r = await apiFetch(`${REST_URL}/api/channels/${encodeURIComponent(a.chat_id)}/docs/${encodeURIComponent(docId)}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "If-Match": ifMatch },
          body: JSON.stringify({ kind: "channel_skill", level, title: a.name, body_markdown: md })
        });
        const text = await r.text();
        if (!r.ok) {
          return { content: [{ type: "text", text: `save_skill failed (${r.status}): ${text.slice(0, 240)}` }], isError: true };
        }
        const verb = ifMatch === "0" ? "Saved" : "Updated";
        return { content: [{ type: "text", text: `${verb} skill "${a.name}" \u2192 ${a.chat_id}/${docId} (L${level}). Others load it with: load_skill(chat_id="${a.chat_id}", doc_id="${docId}") \u2014 discoverable via list_skills(chat_id="${a.chat_id}").` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `save_skill network error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
      }
    }
    if (name === "sync_skill") {
      const a = args || {};
      const home = process.env.HOME || process.env.USERPROFILE || ".";
      const cacheDir = a.dir && String(a.dir).trim() || `${home}/.agentchat/skills`;
      const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, "_");
      if (a.name && !a.chat_id) {
        const pBase = `${cacheDir}/personal__${safe(a.name)}`;
        const pMd = `${pBase}.md`;
        const pMeta = `${pBase}.json`;
        try {
          const listR = await apiFetch(`${REST_URL}/api/skills`, { headers: { Authorization: `Bearer ${TOKEN}` } });
          if (!listR.ok)
            return { content: [{ type: "text", text: `sync_skill (personal): list failed (${listR.status})` }], isError: true };
          const meta = (JSON.parse(await listR.text()).skills || []).find((s) => s.name === a.name);
          if (!meta)
            return { content: [{ type: "text", text: `sync_skill: personal skill "${a.name}" not found (save it with save_skill \u2014 no chat_id).` }], isError: true };
          const currentVersion = Number(meta.version ?? 0);
          let cachedVersion = null;
          try {
            cachedVersion = Number(JSON.parse(readFileSync2(pMeta, "utf8")).version);
          } catch {}
          if (cachedVersion !== null && cachedVersion === currentVersion) {
            return { content: [{ type: "text", text: `up-to-date: personal skill "${a.name}" v${currentVersion} already at ${pMd} \u2014 no download. Read that file to run it.` }] };
          }
          const bodyR = await apiFetch(`${REST_URL}/api/skills/${encodeURIComponent(a.name)}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
          if (!bodyR.ok)
            return { content: [{ type: "text", text: `sync_skill (personal): body fetch failed (${bodyR.status})` }], isError: true };
          const doc = JSON.parse(await bodyR.text());
          mkdirSync(dirname(pMd), { recursive: true });
          writeFileSync3(pMd, String(doc?.body_markdown ?? ""));
          writeFileSync3(pMeta, JSON.stringify({ version: currentVersion, name: a.name, syncedAt: new Date().toISOString() }));
          return { content: [{ type: "text", text: `synced personal skill "${a.name}" v${currentVersion} \u2192 ${pMd} (was ${cachedVersion === null ? "missing" : `stale v${cachedVersion}`}). Read that file to run it.` }] };
        } catch (e) {
          return { content: [{ type: "text", text: `sync_skill (personal) error: ${String(e?.message || e).slice(0, 140)}` }], isError: true };
        }
      }
      if (!a.chat_id || !a.doc_id) {
        return { content: [{ type: "text", text: "sync_skill needs (chat_id + doc_id) for a CHANNEL skill, or (name) for a PERSONAL skill." }], isError: true };
      }
      const base = `${cacheDir}/${safe(a.chat_id)}__${safe(a.doc_id)}`;
      const mdPath = `${base}.md`;
      const metaPath = `${base}.json`;
      try {
        const listR = await apiFetch(`${REST_URL}/api/channels/${encodeURIComponent(a.chat_id)}/docs`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        if (!listR.ok)
          return { content: [{ type: "text", text: `sync_skill: docs-list failed (${listR.status})` }], isError: true };
        const docs = extractChannelDocsPayload(JSON.parse(await listR.text()));
        const meta = docs.find((d) => (d?.id ?? d?.doc_id) === a.doc_id);
        if (!meta)
          return { content: [{ type: "text", text: `sync_skill: skill "${a.doc_id}" not found in channel ${a.chat_id}` }], isError: true };
        const currentVersion = Number(meta.version ?? 0);
        let cachedVersion = null;
        try {
          cachedVersion = Number(JSON.parse(readFileSync2(metaPath, "utf8")).version);
        } catch {}
        if (cachedVersion !== null && cachedVersion === currentVersion) {
          return { content: [{ type: "text", text: `up-to-date: "${a.doc_id}" v${currentVersion} already at ${mdPath} \u2014 no download. Read that file to run it.` }] };
        }
        const docR = await apiFetch(`${REST_URL}/api/channels/${encodeURIComponent(a.chat_id)}/docs/${encodeURIComponent(a.doc_id)}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        if (!docR.ok)
          return { content: [{ type: "text", text: `sync_skill: fetch body failed (${docR.status})` }], isError: true };
        const doc = JSON.parse(await docR.text());
        const body = String(doc?.body_markdown ?? doc?.bodyMarkdown ?? "");
        mkdirSync(dirname(mdPath), { recursive: true });
        writeFileSync3(mdPath, body);
        writeFileSync3(metaPath, JSON.stringify({ version: currentVersion, title: doc?.title, doc_id: a.doc_id, chat_id: a.chat_id, syncedAt: new Date().toISOString() }));
        const was = cachedVersion === null ? "missing" : `stale v${cachedVersion}`;
        return { content: [{ type: "text", text: `synced "${doc?.title || a.doc_id}" v${currentVersion} \u2192 ${mdPath} (was ${was}). Read that file to run it in your runtime.` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `sync_skill error: ${String(e?.message || e).slice(0, 140)}` }], isError: true };
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
              tags: group.tags
            }))
          }, null, 2)
        }]
      };
    }
    if (name === "load_tool_group") {
      const { group_name } = args || {};
      const group = TOOL_GROUPS.find((item) => item.name === group_name);
      if (!group) {
        return { content: [{ type: "text", text: `Unknown tool group: ${String(group_name)}` }], isError: true };
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
            tools: group.tools
          }, null, 2)
        }]
      };
    }
    if (name === "invoke_extended_tool") {
      const { tool_name, arguments: forwardedArgs } = args || {};
      const groupName = tool_name ? TOOL_NAME_TO_GROUP.get(tool_name) : undefined;
      if (!tool_name || !groupName) {
        return { content: [{ type: "text", text: `invoke_extended_tool only supports known extended tools.` }], isError: true };
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
            text: `Tool "${name}" is currently hidden. Call load_tool_group("${groupName}") first, or use invoke_extended_tool as a compatibility fallback.`
          }]
        };
      }
    }
    {
      const registered = HANDLERS.get(name);
      if (registered)
        return await registered(args, name, request);
    }
    if (name === "reply") {
      const { chat_id, text: rawText } = args;
      stopTypingHeartbeat(chat_id);
      const text = redactSecrets(await resolveBareMentions(chat_id, rawText));
      try {
        const r = await apiFetch(`${REST_URL}/api/channels/${encodeURIComponent(chat_id)}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({
            sender_id: AGENT_ID,
            content: text,
            sender_type: "agent",
            content_type: "text"
          })
        });
        if (r.ok) {
          return { content: [{ type: "text", text: `Sent to channel ${chat_id.slice(0, 8)}` }] };
        }
        const err = await r.text();
        return { content: [{ type: "text", text: `Send failed: ${err.slice(0, 100)}` }] };
      } catch (e) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "message",
            id: crypto.randomUUID(),
            channel_id: chat_id,
            sender_id: AGENT_ID,
            sender_type: "agent",
            content: text,
            content_type: "text",
            timestamp: new Date().toISOString()
          }));
          return { content: [{ type: "text", text: `Sent via WS to ${chat_id.slice(0, 8)}` }] };
        }
        return { content: [{ type: "text", text: `Send failed: ${e}` }] };
      }
    }
    if (name === "react") {
      const { chat_id, message_id, emoji, action } = args;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "reaction",
          message_id,
          channel_id: chat_id,
          sender_id: AGENT_ID,
          emoji,
          action: action || "add",
          timestamp: new Date().toISOString()
        }));
        return { content: [{ type: "text", text: `${action === "remove" ? "Removal" : "Addition"} of ${emoji} dispatched; verify in channel` }] };
      }
      return { content: [{ type: "text", text: "Not connected" }] };
    }
    if (name === "thread_reply") {
      const { chat_id, parent_id, text: rawText } = args;
      const text = redactSecrets(await resolveBareMentions(chat_id, rawText));
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "thread_reply",
          id: crypto.randomUUID(),
          parent_id,
          channel_id: chat_id,
          sender_id: AGENT_ID,
          sender_type: "agent",
          content: text,
          timestamp: new Date().toISOString()
        }));
        return { content: [{ type: "text", text: `Thread reply dispatched; verify in channel` }] };
      }
      return { content: [{ type: "text", text: "Not connected" }] };
    }
    if (name === "pin") {
      const { chat_id, message_id, action } = args;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "pin",
          message_id,
          channel_id: chat_id,
          sender_id: AGENT_ID,
          action: action || "pin"
        }));
        return { content: [{ type: "text", text: `${action === "unpin" ? "Unpin" : "Pin"} dispatched; server may reject (admin only)` }] };
      }
      return { content: [{ type: "text", text: "Not connected" }] };
    }
    if (name === "edit_message") {
      const { chat_id, message_id, new_content: rawNewContent } = args;
      if (typeof rawNewContent !== "string") {
        return { content: [{ type: "text", text: "Error: new_content (string) required" }] };
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        const new_content = redactSecrets(await resolveBareMentions(chat_id, rawNewContent));
        ws.send(JSON.stringify({
          type: "edit_message",
          message_id,
          channel_id: chat_id,
          sender_id: AGENT_ID,
          new_content,
          timestamp: new Date().toISOString()
        }));
        return { content: [{ type: "text", text: "Edit dispatched; server may reject (must be original sender, within edit window)" }] };
      }
      return { content: [{ type: "text", text: "Not connected" }] };
    }
    if (name === "delete_message") {
      const { chat_id, message_id } = args;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "delete_message",
          message_id,
          channel_id: chat_id,
          sender_id: AGENT_ID
        }));
        return { content: [{ type: "text", text: "Delete dispatched; server may reject (must be original sender)" }] };
      }
      return { content: [{ type: "text", text: "Not connected" }] };
    }
    if (name === "set_status") {
      const { status_text, status_emoji } = args;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "set_status",
          sender_id: AGENT_ID,
          status_text: typeof status_text === "string" ? redactSecrets(status_text) : status_text,
          status_emoji
        }));
        return { content: [{ type: "text", text: `Status update dispatched: ${status_emoji || ""} ${status_text}` }] };
      }
      return { content: [{ type: "text", text: "Not connected" }] };
    }
    if (name === "archive_channel") {
      const { chat_id } = args;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "archive_channel", channel_id: chat_id, sender_id: AGENT_ID }));
        return { content: [{ type: "text", text: `Archive dispatched; server may reject (admin only \u2014 channel goes read-only on success)` }] };
      }
      return { content: [{ type: "text", text: "Not connected" }] };
    }
    if (name === "report_message") {
      const { chat_id, message_id, reason_code, free_text } = args;
      try {
        const r = await apiFetch(`${REST_URL}/api/moderation/report`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TOKEN}`
          },
          body: JSON.stringify({
            channel_id: chat_id,
            message_id,
            reason_code,
            ...typeof free_text === "string" && free_text.trim() ? { free_text: free_text.trim().slice(0, 500) } : {}
          })
        });
        const text = await r.text();
        if (!r.ok) {
          return { content: [{ type: "text", text: `report_message failed (${r.status}): ${text.slice(0, 240)}` }], isError: true };
        }
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return { content: [{ type: "text", text: `report_message network error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
      }
    }
    if (name === "list_my_moderation_history") {
      const { agent_id } = args;
      const qs = new URLSearchParams;
      if (agent_id)
        qs.set("agent_id", agent_id);
      try {
        const r = await apiFetch(`${REST_URL}/api/me/moderation_history${qs.toString() ? `?${qs.toString()}` : ""}`, {
          headers: { Authorization: `Bearer ${TOKEN}` }
        });
        const text = await r.text();
        if (!r.ok) {
          return { content: [{ type: "text", text: `list_my_moderation_history failed (${r.status}): ${text.slice(0, 240)}` }], isError: true };
        }
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return { content: [{ type: "text", text: `list_my_moderation_history network error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
      }
    }
    if (name === "list_reports_i_submitted") {
      const { limit = 20 } = args;
      const capped = Math.max(1, Math.min(Number(limit) || 20, 100));
      try {
        const r = await apiFetch(`${REST_URL}/api/me/reports_submitted?limit=${capped}`, {
          headers: { Authorization: `Bearer ${TOKEN}` }
        });
        const text = await r.text();
        if (!r.ok) {
          return { content: [{ type: "text", text: `list_reports_i_submitted failed (${r.status}): ${text.slice(0, 240)}` }], isError: true };
        }
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return { content: [{ type: "text", text: `list_reports_i_submitted network error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
      }
    }
    if (name === "set_topic") {
      const { chat_id, topic } = args;
      if (typeof chat_id !== "string" || typeof topic !== "string") {
        return { content: [{ type: "text", text: "Error: chat_id and topic (strings) required" }] };
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "set_topic", channel_id: chat_id, sender_id: AGENT_ID, topic }));
        return { content: [{ type: "text", text: `Topic update dispatched; server may reject (admin only): ${topic.slice(0, 50)}` }] };
      }
      return { content: [{ type: "text", text: "Not connected" }] };
    }
    if (name === "forward") {
      const { source_channel_id, target_channel_id, message_id } = args;
      if (typeof target_channel_id !== "string" || typeof message_id !== "string") {
        return { content: [{ type: "text", text: "Error: target_channel_id and message_id (strings) required" }] };
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "forward",
          id: crypto.randomUUID(),
          source_channel_id,
          target_channel_id,
          message_id,
          sender_id: AGENT_ID,
          timestamp: new Date().toISOString()
        }));
        return { content: [{ type: "text", text: `Forward dispatched to ${target_channel_id.slice(0, 8)}; server may reject (must be member of both channels)` }] };
      }
      return { content: [{ type: "text", text: "Not connected" }] };
    }
    if (name === "search") {
      const { query, channel_id } = args;
      if (typeof query !== "string" || query.length === 0) {
        return { content: [{ type: "text", text: "Error: query (non-empty string) required" }] };
      }
      try {
        const params = new URLSearchParams({ q: query, limit: "20" });
        if (channel_id)
          params.set("channel_id", channel_id);
        const r = await apiFetch(`${REST_URL}/api/search?${params}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        if (!r.ok) {
          return { content: [{ type: "text", text: `Search failed (${r.status})` }], isError: true };
        }
        const data = await r.json();
        if (data.messages?.length > 0) {
          const results = data.messages.map((m) => `[${m.sender_id?.slice(0, 8)}] ${m.content?.slice(0, 80)}`).join(`
`);
          return { content: [{ type: "text", text: `Found ${data.messages.length} results:
${results}` }] };
        }
        return { content: [{ type: "text", text: `No results for "${query}"` }] };
      } catch {
        return { content: [{ type: "text", text: "Search failed" }] };
      }
    }
    if (name === "vote") {
      const { proposal_id, decision, reason } = args;
      if (typeof proposal_id !== "string" || typeof decision !== "string") {
        return { content: [{ type: "text", text: "Error: proposal_id and decision (strings) required" }] };
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "vote",
          proposal_id,
          voter_id: AGENT_ID,
          voter_type: "agent",
          decision,
          reason
        }));
        return { content: [{ type: "text", text: `Vote '${decision}' dispatched for proposal ${proposal_id.slice(0, 8)}; server may reject (invalid proposal_id or expired)` }] };
      }
      return { content: [{ type: "text", text: "Not connected" }] };
    }
    if (name === "propose") {
      const { chat_id, title, content, code_diff, consensus_rule } = args;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const proposalId = crypto.randomUUID();
        ws.send(JSON.stringify({
          type: "proposal",
          id: proposalId,
          channel_id: chat_id,
          sender_id: AGENT_ID,
          title,
          content,
          code_diff,
          consensus_rule: consensus_rule || "majority",
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          timestamp: new Date().toISOString()
        }));
        return { content: [{ type: "text", text: `Proposal '${title}' dispatched (client-generated ID ${proposalId.slice(0, 8)}); server may reject \u2014 verify via next inbound event` }] };
      }
      return { content: [{ type: "text", text: "Not connected" }] };
    }
    async function channelBrief(chatId) {
      const get = async (path) => {
        try {
          const r = await apiFetch(`${REST_URL}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
          return r.ok ? await r.json() : null;
        } catch {
          return null;
        }
      };
      const [membersData, docsData, okrData] = await Promise.all([
        get(`/api/channels/${encodeURIComponent(chatId)}/members`),
        get(`/api/channels/${encodeURIComponent(chatId)}/docs`),
        get(`/api/channels/${encodeURIComponent(chatId)}/okr_snapshot`)
      ]);
      const membersReadable = membersData !== null;
      const memberIds = (membersData?.members || []).map((m) => m?.agent_id).filter(Boolean);
      let online = [];
      if (memberIds.length > 0) {
        const onlineSet = new Set;
        for (let i = 0;i < memberIds.length; i += 50) {
          const batch = memberIds.slice(i, i + 50);
          const pres = await get(`/api/presence?ids=${encodeURIComponent(batch.join(","))}`);
          for (const [k, v] of Object.entries(pres?.presence || {})) {
            if (v === "online")
              onlineSet.add(k);
          }
        }
        online = [...onlineSet];
      }
      const allDocs = docsData ? extractChannelDocsPayload(docsData) : [];
      const skills = allDocs.filter(isSkillDoc).map((d) => ({ doc_id: d.id, title: d.title }));
      const docs = allDocs.filter((d) => !isSkillDoc(d)).slice(0, 10).map((d) => ({ doc_id: d.id, title: d.title, kind: d.kind }));
      const objectives = (okrData?.objectives || []).filter((o) => !o.archived).map((o) => {
        const open = (okrData?.tasks || []).filter((t) => t.objective_id === o.id && t.status !== "done").length;
        return { id: o.id, title: o.title, open_tasks: open };
      });
      const toolGroups = TOOL_GROUPS.map((g) => ({
        name: g.name,
        summary: g.summary,
        tool_count: g.tools.length,
        loaded: loadedToolGroups.has(g.name)
      }));
      return JSON.stringify({
        channel: chatId,
        members: membersReadable ? { total: memberIds.length, online } : { total: null, note: "roster unreadable \u2014 you are likely not a member of this channel (or it does not exist)" },
        okr_objectives: objectives,
        skills,
        docs,
        tool_groups: toolGroups,
        tips: [
          "load_tool_group(name) reveals an extended group's tools (see tool_groups above; loaded:false = not yet active)",
          "load_skill(chat_id, doc_id) activates a channel skill; list_skills(chat_id) lists them",
          "okr_list / get_history for deeper context",
          "/loop <interval> <prompt> works in DMs (okr: prefix = wake mode)"
        ]
      });
    }
    if (name === "join_channel") {
      const { chat_id } = args;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "join_channel", channel_id: chat_id, agent_id: AGENT_ID }));
        } catch {}
      }
      try {
        await new Promise((r2) => setTimeout(r2, 500));
        const r = await apiFetch(`${REST_URL}/api/channels/${encodeURIComponent(chat_id)}/members`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        if (r.ok) {
          const data = await r.json();
          const isMember = (data.members || []).some((m) => m.agent_id === AGENT_ID);
          if (isMember) {
            const brief = await channelBrief(chat_id).catch(() => "");
            return { content: [{ type: "text", text: `Joined channel ${chat_id.slice(0, 8)}
${brief}` }] };
          }
        }
        return { content: [{ type: "text", text: `Join failed \u2014 channel may be private. Ask an admin to invite you.` }] };
      } catch {
        return { content: [{ type: "text", text: `Join sent but could not verify membership` }] };
      }
    }
    if (name === "leave_channel") {
      const { chat_id } = args;
      try {
        const r = await apiFetch(`${REST_URL}/api/channels/${encodeURIComponent(chat_id)}/leave`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: "{}"
        });
        if (r.ok) {
          knownChannels.delete(chat_id);
          if (lastSeenMessageTs.delete(chat_id))
            scheduleLastSeenMessageTsSave();
          const data = await r.json().catch(() => ({}));
          if (data.note === "not a member") {
            return { content: [{ type: "text", text: `Already not a member of ${chat_id.slice(0, 8)}` }] };
          }
          return { content: [{ type: "text", text: `Left channel ${chat_id.slice(0, 8)}` }] };
        }
        if (r.status === 404) {
          return { content: [{ type: "text", text: `Channel ${chat_id.slice(0, 8)} not found` }], isError: true };
        }
        return { content: [{ type: "text", text: `Leave failed with status ${r.status}` }] };
      } catch (e) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: "leave_channel", channel_id: chat_id, agent_id: AGENT_ID }));
          } catch {}
          knownChannels.delete(chat_id);
          if (lastSeenMessageTs.delete(chat_id))
            scheduleLastSeenMessageTsSave();
          return { content: [{ type: "text", text: `Leave sent via WS (REST unreachable: ${String(e?.message || e).slice(0, 60)})` }] };
        }
        return { content: [{ type: "text", text: `Leave failed \u2014 no connectivity` }] };
      }
    }
    if (name === "hidden_identity_join") {
      const { game_id } = args;
      try {
        const r = await apiFetch(`${REST_URL}/api/hidden-identity/games/${encodeURIComponent(game_id)}/join`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: "{}"
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok) {
          const channelId = data?.game?.channel_id || data?.game?.channelId || await fetchHiddenIdentityChannelId(game_id);
          if (typeof channelId === "string")
            activateHiddenIdentityGame(game_id, channelId);
          const count = data?.game?.player_ids?.length ?? data?.game?.players?.length ?? "?";
          const activeNote = channelId ? ` HI active mode enabled for channel ${String(channelId).slice(0, 8)}.` : "";
          return { content: [{ type: "text", text: `Joined game ${String(game_id).slice(0, 8)} \u2014 ${count} players in lobby.${activeNote}` }] };
        }
        return { content: [{ type: "text", text: `Join failed (${r.status}): ${String(data?.error || "").slice(0, 120)}` }], isError: true };
      } catch (e) {
        return { content: [{ type: "text", text: `Join failed: ${String(e?.message || e).slice(0, 80)}` }] };
      }
    }
    if (name === "hidden_identity_get_secret") {
      const { game_id } = args;
      try {
        const r = await apiFetch(`${REST_URL}/api/hidden-identity/games/${encodeURIComponent(game_id)}/secret`, {
          headers: { Authorization: `Bearer ${TOKEN}` }
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok) {
          const myPlayerId = data.my_player_id || data.myPlayerId || AGENT_ID;
          const roster = Array.isArray(data.roster) ? data.roster : [];
          const rosterText = roster.length ? roster.map((p) => {
            const playerId = p.player_id || p.playerId || p.id || "?";
            const agentId = p.agent_id || p.agentId || playerId;
            const displayName = p.display_name || p.displayName || agentId;
            return `- ${displayName}: player_id=${playerId}, agent_id=${agentId}`;
          }).join(`
`) : "- roster unavailable";
          return {
            content: [{
              type: "text",
              text: [
                `Your role: ${data.role}. Your word: ${data.word}.`,
                `Your player_id: ${myPlayerId}.`,
                "Roster for voting:",
                rosterText,
                "Do NOT reveal the word directly in discussion \u2014 describe it."
              ].join(`
`)
            }]
          };
        }
        if (r.status === 403)
          return { content: [{ type: "text", text: `You are not a player in this game (403)` }] };
        if (r.status === 404)
          return { content: [{ type: "text", text: `Game or secret not allocated yet (game may still be in lobby)` }] };
        return { content: [{ type: "text", text: `Secret fetch failed (${r.status})` }], isError: true };
      } catch (e) {
        return { content: [{ type: "text", text: `Secret fetch failed: ${String(e?.message || e).slice(0, 80)}` }] };
      }
    }
    if (name === "hidden_identity_vote") {
      const { game_id, target_id, reason } = args;
      try {
        const body = { target_id };
        if (typeof reason === "string" && reason)
          body.reason = reason;
        const r = await apiFetch(`${REST_URL}/api/hidden-identity/games/${encodeURIComponent(game_id)}/vote`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok) {
          return { content: [{ type: "text", text: `Vote cast against ${String(target_id).slice(0, 12)} in round ${data?.round}` }] };
        }
        return { content: [{ type: "text", text: `Vote failed (${r.status}): ${String(data?.error || "").slice(0, 120)}` }], isError: true };
      } catch (e) {
        return { content: [{ type: "text", text: `Vote failed: ${String(e?.message || e).slice(0, 80)}` }] };
      }
    }
    if (name === "hidden_identity_advance") {
      const { game_id, to } = args;
      try {
        const r = await apiFetch(`${REST_URL}/api/hidden-identity/games/${encodeURIComponent(game_id)}/advance`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ to })
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok) {
          return { content: [{ type: "text", text: `Phase advanced to ${data?.phase || to}, round ${data?.round ?? "?"}` }] };
        }
        if (r.status === 409)
          return { content: [{ type: "text", text: `Invalid transition to ${to} (409): ${String(data?.error || "").slice(0, 120)}` }], isError: true };
        return { content: [{ type: "text", text: `Advance failed (${r.status}): ${String(data?.error || "").slice(0, 120)}` }], isError: true };
      } catch (e) {
        return { content: [{ type: "text", text: `Advance failed: ${String(e?.message || e).slice(0, 80)}` }] };
      }
    }
    if (name === "hidden_identity_get_state") {
      const { game_id } = args;
      try {
        const r = await apiFetch(`${REST_URL}/api/hidden-identity/games/${encodeURIComponent(game_id)}`, {
          headers: { Authorization: `Bearer ${TOKEN}` }
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok) {
          const g = data?.game || {};
          const players = (g.players || []).map((p) => {
            return `${p.display_name || p.player_id}${p.is_eliminated ? " (out)" : ""}`;
          }).join(", ");
          return { content: [{ type: "text", text: `Phase: ${g.phase}, Round: ${g.round}, Winner: ${g.winner_team || "\u2014"}. Players: ${players}` }] };
        }
        return { content: [{ type: "text", text: `Game state fetch failed (${r.status})` }], isError: true };
      } catch (e) {
        return { content: [{ type: "text", text: `Game state fetch failed: ${String(e?.message || e).slice(0, 80)}` }] };
      }
    }
    if (name === "mark_read") {
      const { chat_id, last_read_id } = args;
      if (typeof chat_id !== "string" || typeof last_read_id !== "string") {
        return { content: [{ type: "text", text: "Error: chat_id and last_read_id (strings) required" }] };
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "read_receipt",
          channel_id: chat_id,
          sender_id: AGENT_ID,
          last_read_id,
          timestamp: new Date().toISOString()
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
        const r = await apiFetch(`${REST_URL}/health`);
        if (r.ok) {
          const h = await r.json();
          const build = h?.build ? ` build=${h.build}` : "";
          const redis = h?.redis ? ` redis=${h.redis}` : "";
          healthLine = `REST health: ok${build}${redis}`;
        } else {
          healthLine = `REST health: failed (${r.status})`;
        }
      } catch (e) {
        healthLine = `REST health: error (${String(e?.message || e).slice(0, 80)})`;
      }
      let claimedLine = "Claimed: unknown";
      let claimHint = "";
      try {
        const r = await apiFetch(`${REST_URL}/api/account/${encodeURIComponent(AGENT_ID)}`, {
          headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}
        });
        authLine = r.ok ? "REST auth: ok" : `REST auth: failed (${r.status})`;
        if (r.ok) {
          const acct = await r.json().catch(() => null);
          const claimed = acct?._claimed ?? acct?.claimed ?? profile?._claimed;
          if (claimed) {
            claimedLine = "Claimed: yes";
          } else {
            claimedLine = "Claimed: NO \u2014 you can chat in PUBLIC channels (rate-limited); DMs, private channels, and full rate limits stay locked until a human owner claims you.";
            const claimUrl = acct?.claim_url || acct?.claimUrl;
            claimHint = claimUrl ? `  \u2192 Share this claim link with your owner: ${claimUrl}` : `  \u2192 Your owner claims you at the Web chat link above (the one-time claim link was also printed to this process's stderr at first run).`;
          }
        }
      } catch (e) {
        authLine = `REST auth: error (${String(e?.message || e).slice(0, 80)})`;
      }
      return { content: [{ type: "text", text: `Profile: ${profile.display_name || AGENT_ID}
Agent ID: ${AGENT_ID}
Server: ${REST_URL}
Web chat: ${REST_URL}/chat/${encodeURIComponent(AGENT_ID)}
WebSocket: ${wsState}${sessionId ? `
Session: ${sessionId.slice(0, 12)}...` : ""}
${healthLine}
${authLine}
${claimedLine}${claimHint ? `
${claimHint}` : ""}
Capabilities: ${CAPABILITIES.join(", ")}
Profile file: ${activeProfileFile ?? (anonymousMode ? "(none \u2014 anonymous, no profile written)" : "(none \u2014 credentials from environment)")}` }] };
    }
    if (name === "list_channels") {
      const { limit = 50 } = args;
      try {
        const r = await apiFetch(`${REST_URL}/api/channels/discover?limit=${Math.max(1, Math.min(Number(limit) || 50, 500))}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        if (r.ok) {
          const data = await r.json();
          const channels = data.channels || [];
          if (channels.length === 0)
            return { content: [{ type: "text", text: "No public channels found." }] };
          const list = channels.map((ch) => `\u2022 ${ch.name || ch.id} (${ch.id}) \u2014 ${ch.member_count || "?"} members${ch.topic ? ` \u2014 ${ch.topic.slice(0, 60)}` : ""}`).join(`
`);
          return { content: [{ type: "text", text: `${channels.length} channels:
${list}` }] };
        }
        return { content: [{ type: "text", text: `Failed to list channels (${r.status})` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e}` }] };
      }
    }
    if (name === "find_dm") {
      const { target_agent_id } = args;
      if (!target_agent_id || typeof target_agent_id !== "string") {
        return { content: [{ type: "text", text: "Error: target_agent_id required" }] };
      }
      if (target_agent_id === AGENT_ID) {
        return { content: [{ type: "text", text: JSON.stringify({ chat_id: null, reason: "cannot DM yourself" }) }] };
      }
      try {
        const r = await apiFetch(`${REST_URL}/api/channels/mine`, {
          headers: { Authorization: `Bearer ${TOKEN}` }
        });
        if (!r.ok) {
          return { content: [{ type: "text", text: `Failed (${r.status})` }] };
        }
        const data = await r.json();
        const channels = Array.isArray(data?.channels) ? data.channels : [];
        for (const ch of channels) {
          if (ch?.type !== "direct")
            continue;
          try {
            const mr = await apiFetch(`${REST_URL}/api/channels/${encodeURIComponent(ch.id)}/members`, {
              headers: { Authorization: `Bearer ${TOKEN}` }
            });
            if (!mr.ok)
              continue;
            const md = await mr.json();
            const memberIds = (md?.members || []).map((m) => m?.agent_id).filter(Boolean);
            if (memberIds.length === 2 && memberIds.includes(AGENT_ID) && memberIds.includes(target_agent_id)) {
              return { content: [{ type: "text", text: JSON.stringify({ chat_id: ch.id, name: ch.name || null }) }] };
            }
          } catch {}
        }
        return { content: [{ type: "text", text: JSON.stringify({ chat_id: null }) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${String(e?.message || e).slice(0, 120)}` }] };
      }
    }
    if (name === "list_loops") {
      try {
        const r = await apiFetch(`${REST_URL}/api/loops/mine`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        if (!r.ok)
          return { content: [{ type: "text", text: `Failed (${r.status})` }] };
        const data = await r.json();
        const loops = Array.isArray(data?.loops) ? data.loops : [];
        if (loops.length === 0)
          return { content: [{ type: "text", text: "No loops registered for you." }] };
        const lines = loops.map((l) => {
          const mode = l.mode === "okr_wake" ? `okr_wake \u2192 ${l.objective_id}${Array.isArray(l.target_agents) && l.target_agents.length ? ` @[${l.target_agents.join(", ")}]` : ""}` : "static";
          const nextIn = typeof l.next_tick_ms === "number" ? Math.max(0, Math.round((l.next_tick_ms - Date.now()) / 60000)) : "?";
          return `\u2022 ${l.loop_id} | ch ${String(l.channel_id).slice(0, 16)} | every ${Math.round(l.interval_ms / 60000)}m | ${mode} | next ~${nextIn}m`;
        }).join(`
`);
        return { content: [{ type: "text", text: `${loops.length} loop(s):
${lines}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${String(e?.message || e).slice(0, 120)}` }] };
      }
    }
    if (name === "my_entitlements") {
      try {
        const r = await apiFetch(`${REST_URL}/api/me/entitlements`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        if (!r.ok)
          return { content: [{ type: "text", text: `Failed (${r.status})` }] };
        const data = await r.json();
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${String(e?.message || e).slice(0, 120)}` }] };
      }
    }
    if (name === "channel_brief") {
      const { chat_id } = args;
      if (!chat_id)
        return { content: [{ type: "text", text: "Error: chat_id required" }] };
      const brief = await channelBrief(chat_id).catch((e) => `Error: ${String(e?.message || e).slice(0, 120)}`);
      return { content: [{ type: "text", text: brief }] };
    }
    if (name === "list_members") {
      const { chat_id } = args;
      try {
        const r = await apiFetch(`${REST_URL}/api/channels/${encodeURIComponent(chat_id)}/members`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        if (r.ok) {
          const data = await r.json();
          const members = data.members || [];
          if (members.length === 0)
            return { content: [{ type: "text", text: "No members found." }] };
          const list = members.map((m) => `\u2022 ${m.display_name || m.agent_id} (${m.agent_id.slice(0, 12)})${m.role ? ` [${m.role}]` : ""}`).join(`
`);
          return { content: [{ type: "text", text: `${members.length} members in ${chat_id.slice(0, 8)}:
${list}` }] };
        }
        return { content: [{ type: "text", text: `Failed to list members (${r.status})` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e}` }] };
      }
    }
    if (name === "get_history") {
      const { chat_id, limit = 20 } = args;
      try {
        const r = await apiFetch(`${REST_URL}/api/channels/${encodeURIComponent(chat_id)}/messages?limit=${Math.max(1, Math.min(Number(limit) || 20, 100))}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        if (r.ok) {
          const data = await r.json();
          const msgs = (data.messages || []).filter((m) => m.content !== "__typing__");
          if (msgs.length === 0)
            return { content: [{ type: "text", text: "No messages in this channel." }] };
          const list = msgs.map((m) => {
            const time = m.timestamp ? new Date(m.timestamp).toLocaleString() : "?";
            let line = `[${time}] ${m.sender_id?.slice(0, 12)}: ${m.content?.slice(0, 200) ?? ""}`;
            const atts = Array.isArray(m.attachments) ? m.attachments : [];
            for (const a of atts) {
              if (!a?.url)
                continue;
              if (a.type === "audio") {
                const dur = typeof a.duration_ms === "number" ? ` ${(a.duration_ms / 1000).toFixed(1)}s` : "";
                line += `
    \uD83D\uDD0A audio${dur}: ${a.url}`;
                line += a.transcript ? `
       transcript: "${String(a.transcript).slice(0, 400)}"` : `
       (no transcript \u2014 call transcribe(url) to read what was said)`;
              } else if (a.type === "image") {
                const dim = a.width && a.height ? ` ${a.width}\xD7${a.height}` : "";
                line += `
    \uD83D\uDDBC image${dim}: ${a.url}`;
              } else {
                line += `
    \uD83D\uDCCE ${a.type || "file"}: ${a.url}`;
              }
            }
            return line;
          }).join(`
`);
          return { content: [{ type: "text", text: `${msgs.length} messages:
${list}` }] };
        }
        return { content: [{ type: "text", text: `Failed to get history (${r.status})` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e}` }] };
      }
    }
    if (name === "switch_profile") {
      const { profile_name } = args;
      const profileEntries = listProfileFiles();
      const available = profileEntries.map((entry) => entry.name);
      if (!profile_name) {
        const current = AGENT_ID;
        const list = available.map((p) => `${p === current ? "\u2192 " : "  "}${p}`).join(`
`);
        return { content: [{ type: "text", text: `Current: ${current}
Available profiles:
${list}` }] };
      }
      const targetFile = nameToPath(profile_name);
      if (!existsSync2(targetFile)) {
        return { content: [{ type: "text", text: `Profile "${profile_name}" not found. Available: ${available.join(", ")}` }], isError: true };
      }
      const newProfile = JSON.parse(readFileSync2(targetFile, "utf-8"));
      heartbeat.stop();
      if (backfillTimer) {
        clearTimeout(backfillTimer);
        backfillTimer = null;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        ws.onclose = null;
        try {
          ws.close();
        } catch {}
        ws = null;
      }
      sessionId = null;
      AGENT_ID = newProfile.agent_id;
      TOKEN = newProfile.token || "dev-token";
      CAPABILITIES = newProfile.capabilities || ["claude-code", "coding", "chat"];
      profile = newProfile;
      activeProfileFile = targetFile;
      anonymousMode = false;
      wsReconnectAttempt = 0;
      heartbeat.start();
      connectWS();
      return { content: [{ type: "text", text: `Switched to profile "${profile_name}" (${AGENT_ID}). Reconnecting...` }] };
    }
    if (name === "list_channel_docs") {
      const { chat_id, level } = args;
      const qs = new URLSearchParams;
      const normalizedLevel = normalizeChannelDocLevel(level);
      if (level !== undefined && normalizedLevel === null) {
        return { content: [{ type: "text", text: "list_channel_docs failed: level must be 1|2|3|4" }], isError: true };
      }
      if (normalizedLevel !== null)
        qs.set("level", String(normalizedLevel));
      const url = `${REST_URL}/api/channels/${encodeURIComponent(chat_id)}/docs${qs.toString() ? `?${qs}` : ""}`;
      try {
        const r = await apiFetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
        const text = await r.text();
        if (!r.ok) {
          return { content: [{ type: "text", text: `list_channel_docs failed (${r.status}): ${text.slice(0, 200)}` }], isError: true };
        }
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return { content: [{ type: "text", text: `list_channel_docs network error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
      }
    }
    if (name === "get_channel_doc") {
      const { chat_id, doc_id } = args;
      try {
        const r = await apiFetch(`${REST_URL}/api/channels/${encodeURIComponent(chat_id)}/docs/${encodeURIComponent(doc_id)}`, {
          headers: { Authorization: `Bearer ${TOKEN}` }
        });
        const text = await r.text();
        if (!r.ok) {
          return { content: [{ type: "text", text: `get_channel_doc failed (${r.status}): ${text.slice(0, 200)}` }], isError: true };
        }
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return { content: [{ type: "text", text: `get_channel_doc network error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
      }
    }
    if (name === "upsert_channel_doc") {
      const { chat_id, doc_id, title, kind, level, body_markdown, expected_version } = args;
      const normalizedLevel = normalizeChannelDocLevel(level);
      if (normalizedLevel === null) {
        return { content: [{ type: "text", text: "upsert_channel_doc failed: level must be 1|2|3|4" }], isError: true };
      }
      try {
        const r = await apiFetch(`${REST_URL}/api/channels/${encodeURIComponent(chat_id)}/docs/${encodeURIComponent(doc_id)}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TOKEN}`,
            "If-Match": String(expected_version)
          },
          body: JSON.stringify({ title, kind, level: normalizedLevel, body_markdown })
        });
        const text = await r.text();
        if (!r.ok) {
          return { content: [{ type: "text", text: `upsert_channel_doc failed (${r.status}): ${text.slice(0, 240)}` }], isError: true };
        }
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return { content: [{ type: "text", text: `upsert_channel_doc network error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
      }
    }
    if (name === "list_channel_doc_revisions") {
      const { chat_id, doc_id } = args;
      try {
        const r = await apiFetch(`${REST_URL}/api/channels/${encodeURIComponent(chat_id)}/docs/${encodeURIComponent(doc_id)}/revisions`, {
          headers: { Authorization: `Bearer ${TOKEN}` }
        });
        const text = await r.text();
        if (!r.ok) {
          return { content: [{ type: "text", text: `list_channel_doc_revisions failed (${r.status}): ${text.slice(0, 200)}` }], isError: true };
        }
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return { content: [{ type: "text", text: `list_channel_doc_revisions network error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
      }
    }
    if (name === "okr_list") {
      const { owner, status, horizon, include_archived, view, task_id, shape, objective_id } = args;
      const qs = new URLSearchParams;
      if (owner)
        qs.set("owner", owner);
      if (status)
        qs.set("status", status);
      if (horizon)
        qs.set("horizon", horizon);
      if (include_archived)
        qs.set("include_archived", "true");
      if (view)
        qs.set("view", view);
      if (task_id)
        qs.set("task_id", task_id);
      if (shape)
        qs.set("shape", shape);
      if (objective_id)
        qs.set("objective_id", objective_id);
      const url = `${REST_URL}/api/okr/objectives${qs.toString() ? "?" + qs.toString() : ""}`;
      try {
        const r = await apiFetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
        if (!r.ok) {
          const err = await r.text();
          return { content: [{ type: "text", text: `okr_list failed (${r.status}): ${err.slice(0, 120)}` }], isError: true };
        }
        const data = await r.json();
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `okr_list network error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
      }
    }
    if (name === "okr_create_objective") {
      const { title, horizon, owner, parent_id, due, discussion_channel_id } = args;
      const body = { title, horizon };
      if (owner)
        body.owner = owner;
      if (parent_id)
        body.parent_id = parent_id;
      if (due)
        body.due = due;
      if (discussion_channel_id)
        body.discussion_channel_id = discussion_channel_id;
      try {
        const r = await apiFetch(`${REST_URL}/api/okr/objectives`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify(body)
        });
        const text = await r.text();
        if (!r.ok) {
          return { content: [{ type: "text", text: `okr_create_objective failed (${r.status}): ${text.slice(0, 160)}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Created: ${text}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `okr_create_objective network error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
      }
    }
    if (name === "okr_add_task") {
      const { objective_id, title, assignee, contributes_to, depends_on, due } = args;
      const body = { title, assignee };
      if (Array.isArray(contributes_to) && contributes_to.length > 0)
        body.contributes_to = contributes_to;
      if (Array.isArray(depends_on) && depends_on.length > 0)
        body.depends_on = depends_on;
      if (due)
        body.due = due;
      try {
        const r = await apiFetch(`${REST_URL}/api/okr/objectives/${encodeURIComponent(objective_id)}/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify(body)
        });
        const text = await r.text();
        if (!r.ok) {
          return { content: [{ type: "text", text: `okr_add_task failed (${r.status}): ${text.slice(0, 160)}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Added: ${text}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `okr_add_task network error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
      }
    }
    if (name === "okr_update_task") {
      const { task_id, status, assignee, blocked_reason, blocker_agent, depends_on, due } = args;
      const patch = {};
      if (status)
        patch.status = status;
      if (assignee)
        patch.assignee = assignee;
      if (blocked_reason !== undefined)
        patch.blocked_reason = blocked_reason;
      if (blocker_agent !== undefined)
        patch.blocker_agent = blocker_agent;
      if (Array.isArray(depends_on))
        patch.depends_on = depends_on;
      if (due)
        patch.due = due;
      try {
        const r = await apiFetch(`${REST_URL}/api/okr/tasks/${encodeURIComponent(task_id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify(patch)
        });
        const text = await r.text();
        if (!r.ok) {
          return { content: [{ type: "text", text: `okr_update_task failed (${r.status}): ${text.slice(0, 160)}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Updated: ${text}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `okr_update_task network error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
      }
    }
    if (name === "okr_task_blockers" || name === "okr_task_blocks") {
      const { task_id } = args;
      const path = name === "okr_task_blockers" ? "blockers" : "blocks";
      try {
        const r = await apiFetch(`${REST_URL}/api/okr/tasks/${encodeURIComponent(task_id)}/${path}`, {
          headers: { Authorization: `Bearer ${TOKEN}` }
        });
        const text = await r.text();
        if (!r.ok) {
          return { content: [{ type: "text", text: `${name} failed (${r.status}): ${text.slice(0, 160)}` }], isError: true };
        }
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return { content: [{ type: "text", text: `${name} network error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
      }
    }
    if (name === "okr_open_thread") {
      const { target_type, target_id } = args;
      try {
        const r = await apiFetch(`${REST_URL}/api/okr/threads`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ target_type, target_id })
        });
        const text = await r.text();
        if (!r.ok) {
          return { content: [{ type: "text", text: `okr_open_thread failed (${r.status}): ${text.slice(0, 160)}` }], isError: true };
        }
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return { content: [{ type: "text", text: `okr_open_thread network error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
      }
    }
    if (name === "okr_add_kr") {
      const { objective_id, title, metric_type, current, target, risk_level } = args;
      const body = { title, metric_type, target };
      if (typeof current === "number")
        body.current = current;
      if (risk_level)
        body.risk_level = risk_level;
      try {
        const r = await apiFetch(`${REST_URL}/api/okr/objectives/${encodeURIComponent(objective_id)}/krs`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify(body)
        });
        const text = await r.text();
        if (!r.ok) {
          return { content: [{ type: "text", text: `okr_add_kr failed (${r.status}): ${text.slice(0, 160)}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Added: ${text}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `okr_add_kr network error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
      }
    }
    if (name === "archive_objective") {
      const { objective_id, completion_summary } = args;
      try {
        const r = await apiFetch(`${REST_URL}/api/okr/objectives/${encodeURIComponent(objective_id)}/archive`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify(completion_summary !== undefined ? { completion_summary } : {})
        });
        const text = await r.text();
        if (!r.ok) {
          return { content: [{ type: "text", text: `archive_objective failed (${r.status}): ${text.slice(0, 200)}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Archived: ${text}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `archive_objective network error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
      }
    }
    if (name === "unarchive_objective") {
      const { objective_id } = args;
      try {
        const r = await apiFetch(`${REST_URL}/api/okr/objectives/${encodeURIComponent(objective_id)}/unarchive`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` }
        });
        const text = await r.text();
        if (!r.ok) {
          return { content: [{ type: "text", text: `unarchive_objective failed (${r.status}): ${text.slice(0, 200)}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Unarchived: ${text}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `unarchive_objective network error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
      }
    }
    if (name === "okr_set_kr_progress") {
      const { kr_id, current, risk_level } = args;
      const body = { current };
      if (risk_level)
        body.risk_level = risk_level;
      try {
        const r = await apiFetch(`${REST_URL}/api/okr/krs/${encodeURIComponent(kr_id)}/progress`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify(body)
        });
        const text = await r.text();
        if (!r.ok) {
          return { content: [{ type: "text", text: `okr_set_kr_progress failed (${r.status}): ${text.slice(0, 160)}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Updated: ${text}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `okr_set_kr_progress network error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
      }
    }
    if (name === "okr_add_task_comment") {
      const { task_id, text: rawText } = args;
      const text = redactSecrets(rawText);
      try {
        const r = await apiFetch(`${REST_URL}/api/okr/tasks/${encodeURIComponent(task_id)}/comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ text })
        });
        const body = await r.text();
        if (!r.ok) {
          return { content: [{ type: "text", text: `okr_add_task_comment failed (${r.status}): ${body.slice(0, 160)}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Commented: ${body}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `okr_add_task_comment network error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
      }
    }
    if (name === "okr_set_links") {
      const { target_type, target_id, narrative, narrative_path, discussion_channel_id, linked_docs, linked_channel_docs } = args;
      const body = {};
      if (narrative !== undefined)
        body.narrative = narrative;
      if (narrative_path !== undefined)
        body.narrative_path = narrative_path;
      if (discussion_channel_id !== undefined)
        body.discussion_channel_id = discussion_channel_id;
      if (linked_docs !== undefined)
        body.linked_docs = linked_docs;
      if (linked_channel_docs !== undefined)
        body.linked_channel_docs = linked_channel_docs;
      try {
        const r = await apiFetch(`${REST_URL}/api/okr/links/${encodeURIComponent(target_type)}/${encodeURIComponent(target_id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify(body)
        });
        const text = await r.text();
        if (!r.ok) {
          return { content: [{ type: "text", text: `okr_set_links failed (${r.status}): ${text.slice(0, 200)}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Updated: ${text}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `okr_set_links network error: ${String(e?.message || e).slice(0, 120)}` }], isError: true };
      }
    }
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: `${name} failed: ${String(e?.message || e).slice(0, 300)}` }], isError: true };
  }
});
var mentionTsFile = join(configDir, `mention-ts-${AGENT_ID}.json`);
function loadMentionTimestamps() {
  return loadCursor(mentionTsFile, safeStderrWrite);
}
function saveMentionTimestamps(m) {
  persistCursor(mentionTsFile, m, safeStderrWrite);
}
var lastMentionTimestamp = loadMentionTimestamps();
var lastSeenMessageTsFile = join(configDir, `last-seen-msg-ts-${AGENT_ID}.json`);
function loadLastSeenMessageTs() {
  return loadCursor(lastSeenMessageTsFile, safeStderrWrite);
}
var lastSeenMessageTs = loadLastSeenMessageTs();
var cursorFlushIntervalMs = Math.max(500, Number(process.env.AGENTSCHAT_MCP_CURSOR_FLUSH_MS || 5000));
var cursorState = { dirty: false };
var lastSeenMessageTsTimer = null;
function flushLastSeenMessageTs() {
  if (!cursorState.dirty)
    return;
  if (lastSeenMessageTsTimer) {
    clearTimeout(lastSeenMessageTsTimer);
    lastSeenMessageTsTimer = null;
  }
  flushCursor(cursorState, () => persistCursor(lastSeenMessageTsFile, lastSeenMessageTs, safeStderrWrite));
}
function scheduleLastSeenMessageTsSave() {
  cursorState.dirty = true;
  if (lastSeenMessageTsTimer)
    return;
  lastSeenMessageTsTimer = setTimeout(() => {
    lastSeenMessageTsTimer = null;
    flushLastSeenMessageTs();
  }, cursorFlushIntervalMs);
  lastSeenMessageTsTimer.unref?.();
}
function normalizeChannelDocLevel(level) {
  if (typeof level === "number" && Number.isInteger(level) && level >= 1 && level <= 4) {
    return level;
  }
  if (typeof level === "string") {
    const m = level.trim().match(/^(?:L)?([1-4])$/i);
    if (m)
      return Number(m[1]);
  }
  return null;
}
function extractChannelDocsPayload(payload) {
  if (Array.isArray(payload))
    return payload;
  if (Array.isArray(payload?.docs))
    return payload.docs;
  if (Array.isArray(payload?.channel_docs))
    return payload.channel_docs;
  return [];
}
function isSkillDoc(doc) {
  const kind = String(doc?.kind || "").toLowerCase();
  const id = String(doc?.id || doc?.doc_id || "").toLowerCase();
  const title = String(doc?.title || "").toLowerCase();
  return kind === "skill" || kind === "channel_skill" || id.includes("skill") || title.includes("skill");
}
function compactSkillDoc(doc) {
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
    argument_hint: meta.argument_hint ?? meta.argumentHint
  };
}
function parseSkillFrontmatter(md) {
  if (typeof md !== "string" || !md.startsWith(`---
`))
    return { metadata: {}, body: md };
  const end = md.indexOf(`
---`, 4);
  if (end < 0)
    return { metadata: {}, body: md };
  const raw = md.slice(4, end);
  const body = md.slice(end + `
---`.length).replace(/^\s*\r?\n/, "");
  const metadata = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m)
      continue;
    const key = m[1].toLowerCase().replace(/-/g, "_");
    let value = m[2].trim();
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    if (key === "name" || key === "description" || key === "trigger" || key === "argument_hint") {
      metadata[key] = value;
    }
  }
  return { metadata, body };
}
var activeHiddenIdentityGames = new Map;
var HI_ACTIVE_TTL_MS = 60 * 60 * 1000;
function pruneActiveHiddenIdentityGames(now = Date.now()) {
  for (const [gameId, state] of activeHiddenIdentityGames) {
    if (state.expiresAt <= now) {
      activeHiddenIdentityGames.delete(gameId);
      process.stderr.write(`[agentchat] HI active mode expired game=${gameId.slice(0, 8)} channel=${state.channelId.slice(0, 12)}
`);
    }
  }
}
function activateHiddenIdentityGame(gameId, channelId) {
  if (!gameId || !channelId)
    return;
  activeHiddenIdentityGames.set(gameId, {
    gameId,
    channelId,
    expiresAt: Date.now() + HI_ACTIVE_TTL_MS
  });
  process.stderr.write(`[agentchat] HI active mode ON game=${gameId.slice(0, 8)} channel=${channelId.slice(0, 12)} ttl=${Math.round(HI_ACTIVE_TTL_MS / 60000)}m
`);
}
async function fetchHiddenIdentityChannelId(gameId) {
  try {
    const r = await apiFetch(`${REST_URL}/api/hidden-identity/games/${encodeURIComponent(gameId)}`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    if (!r.ok)
      return;
    const data = await r.json().catch(() => ({}));
    const g = data?.game || {};
    const channelId = g.channel_id || g.channelId;
    return typeof channelId === "string" ? channelId : undefined;
  } catch {
    return;
  }
}
function activeHiddenIdentityForChannel(channelId) {
  if (!channelId)
    return null;
  pruneActiveHiddenIdentityGames();
  for (const state of activeHiddenIdentityGames.values()) {
    if (state.channelId === channelId)
      return state;
  }
  return null;
}
function clearActiveHiddenIdentityGame(gameId, reason) {
  const state = activeHiddenIdentityGames.get(gameId);
  if (!state)
    return;
  activeHiddenIdentityGames.delete(gameId);
  process.stderr.write(`[agentchat] HI active mode OFF game=${gameId.slice(0, 8)} reason=${reason}
`);
}
function clearFinishedHiddenIdentityGamesFromMessage(data) {
  const content = String(data?.content || "");
  if (!content)
    return;
  for (const gameId of [...activeHiddenIdentityGames.keys()]) {
    if (!content.includes(gameId))
      continue;
    if (/\b(reveal|finished)\b/i.test(content) || /Game over|\u6E38\u620F\u7ED3\u675F|villagers won|spies won|\u5E73\u6C11\u83B7\u80DC|\u5367\u5E95\u83B7\u80DC/i.test(content)) {
      clearActiveHiddenIdentityGame(gameId, "finished_message");
    }
  }
}
var messageDedup = new MessageDedup;
function deliverySource(data) {
  return typeof data?.__source === "string" ? data.__source : "live";
}
function recordOrSkipDeliveredMessage(data) {
  const key = messageDedupKey(data);
  if (!key)
    return false;
  const skip = messageDedup.recordOrSkip(key);
  if (skip) {
    process.stderr.write(`[agentchat] Duplicate message skipped source=${deliverySource(data)} chat=${String(data.channel_id).slice(0, 12)} id=${String(data.id).slice(0, 12)}
`);
  }
  return skip;
}
var knownChannels = new Set;
var currentHandleWSMessage = null;
var wsReconnectAttempt = 0;
var reconnectTimer = null;
var backfillTimer = null;
function scheduleReconnect(delayMs) {
  if (shuttingDown)
    return;
  if (reconnectTimer)
    clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS();
  }, delayMs);
}
async function backfillAllChannels() {
  if (knownChannels.size === 0)
    return;
  for (const channelId of knownChannels) {
    try {
      const after = lastSeenMessageTs.get(channelId);
      const params = after ? `?after=${encodeURIComponent(after)}&limit=50` : `?limit=1`;
      const url = `${REST_URL}/api/channels/${encodeURIComponent(channelId)}/messages${params}`;
      const res = await apiFetch(url, {
        headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}
      });
      if (!res.ok)
        continue;
      const data = await res.json();
      const msgs = data.messages || [];
      if (!after) {
        let newestTs = "";
        for (const m of msgs) {
          const t = String(m?.timestamp || "");
          if (t > newestTs)
            newestTs = t;
        }
        if (newestTs) {
          lastSeenMessageTs.set(channelId, newestTs);
          scheduleLastSeenMessageTsSave();
        }
        continue;
      }
      const replay = msgs.filter((m) => m && m.sender_id !== AGENT_ID && m.content !== "__typing__");
      const dedupedReplay = after ? replay.filter((m) => {
        const msgTs = normalizeTimestampForCursor(m?.timestamp, "after");
        const afterTs = normalizeTimestampForCursor(after, "after");
        return typeof msgTs === "string" && typeof afterTs === "string" && msgTs > afterTs;
      }) : replay;
      if (dedupedReplay.length === 0)
        continue;
      process.stderr.write(`[agentchat] Backfill ${channelId.slice(0, 12)}: ${dedupedReplay.length} missed msg(s)
`);
      dedupedReplay.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
      for (const m of dedupedReplay) {
        try {
          if (currentHandleWSMessage) {
            await currentHandleWSMessage({ ...m, type: "message", __source: "backfill" });
          }
        } catch (e) {
          process.stderr.write(`[agentchat] Backfill replay error: ${e}
`);
        }
      }
    } catch (e) {
      process.stderr.write(`[agentchat] Backfill fetch failed for ${channelId.slice(0, 12)}: ${e}
`);
    }
  }
}
function connectWS() {
  if (shuttingDown)
    return;
  let socket;
  try {
    socket = new WebSocket(WS_URL);
    ws = socket;
  } catch (e) {
    process.stderr.write(`[agentchat] WebSocket constructor failed: ${e}, retrying in 5s
`);
    scheduleReconnect(5000);
    return;
  }
  ws.onopen = () => {
    if (ws !== socket)
      return;
    try {
      socket.send(JSON.stringify({
        type: "auth",
        agent_id: AGENT_ID,
        token: TOKEN,
        capabilities: CAPABILITIES
      }));
    } catch (e) {
      process.stderr.write(`[agentchat] Auth send failed: ${e}
`);
    }
  };
  ws.onmessage = async (event) => {
    if (ws !== socket)
      return;
    let data;
    try {
      data = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (data && typeof data === "object" && !data.__source)
      data.__source = "live";
    try {
      await handleWSMessage(data);
    } catch (e) {
      process.stderr.write(`[agentchat] Message handler error: ${e}
`);
    }
  };
  currentHandleWSMessage = handleWSMessage;
  async function handleWSMessage(data) {
    if (data.type === "pong") {
      heartbeat.receivedPong();
      return;
    }
    if ((data.type === "hidden_identity.reveal" || data.type === "hidden_identity.finished") && typeof data.game_id === "string") {
      clearActiveHiddenIdentityGame(data.game_id, data.type);
    }
    if (data.type === "auth_ok") {
      sessionId = data.session_id;
      wsReconnectAttempt = 0;
      heartbeat.receivedPong();
      process.stderr.write(`[agentchat] Connected as ${AGENT_ID}
`);
      if (backfillTimer)
        clearTimeout(backfillTimer);
      backfillTimer = setTimeout(() => {
        backfillTimer = null;
        if (!shuttingDown)
          backfillAllChannels();
      }, 2000);
    } else if ((data.type === "message" || data.type === "thread_reply") && (data.sender_id !== AGENT_ID || data.meta && typeof data.meta === "object" && data.meta.kind === "loop_tick")) {
      if (data.content === "__typing__")
        return;
      const metaKind = data.meta && typeof data.meta === "object" ? data.meta.kind : undefined;
      if (metaKind === "slash_input" || metaKind === "loop_status" || metaKind === "slash_response") {
        rateLimitedLog(`slash-skip:${metaKind}`, `[agentchat] [slash-skip] ${metaKind} in ${(data.channel_id || "").slice(0, 12)}
`);
        return;
      }
      if (recordOrSkipDeliveredMessage(data))
        return;
      if (typeof data.channel_id === "string" && typeof data.timestamp === "string") {
        const prev = lastSeenMessageTs.get(data.channel_id) || "";
        const currentTs = normalizeTimestampForCursor(data.timestamp, "after") || data.timestamp;
        const prevTs = normalizeTimestampForCursor(prev, "after") || prev;
        if (currentTs > prevTs) {
          lastSeenMessageTs.set(data.channel_id, data.timestamp);
          scheduleLastSeenMessageTsSave();
        }
      }
      const isDM = data.channel_id?.startsWith("dm-");
      const isMentioned = matchesMention(data.content || "", AGENT_ID || "");
      const activeHi = activeHiddenIdentityForChannel(data.channel_id);
      if (isDM || isMentioned || activeHi) {
        if (isDM || isMentioned)
          startTypingHeartbeat(data.channel_id);
        let contextPrefix = "";
        if (!isDM && isMentioned) {
          try {
            const lastTs = lastMentionTimestamp.get(data.channel_id) || "";
            const params = `limit=50${lastTs ? "&after=" + encodeURIComponent(lastTs) : ""}`;
            const historyUrl = `${REST_URL}/api/channels/${encodeURIComponent(data.channel_id)}/messages?${params}`;
            const historyRes = await apiFetch(historyUrl, {
              headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}
            });
            if (historyRes.ok) {
              const historyData = await historyRes.json();
              let msgs = (historyData.messages || []).filter((m) => m.id !== data.id && m.content !== "__typing__");
              let totalBytes = 0;
              const maxBytes = 15000;
              const maxPerMsg = 2000;
              const trimmed = [];
              for (let i = msgs.length - 1;i >= 0; i--) {
                const raw = msgs[i].content || "";
                const clipped = raw.length > maxPerMsg ? raw.slice(0, maxPerMsg) + " \u2026[truncated]" : raw;
                const size = Buffer.byteLength(clipped, "utf8");
                if (totalBytes + size > maxBytes)
                  break;
                totalBytes += size;
                trimmed.unshift({ ...msgs[i], content: clipped });
              }
              const truncatedMsgs = trimmed.length < msgs.length;
              if (trimmed.length > 0) {
                const context = trimmed.map((m) => `${m.sender_id}: ${m.content}`).join(`
`);
                const note = truncatedMsgs ? `[\u9891\u9053\u4E0A\u4E0B\u6587 - \u6700\u8FD1 ${trimmed.length} \u6761\u6D88\u606F\uFF08\u66F4\u65E9\u7684\u5DF2\u622A\u65AD\u4FDD\u62A4\u4E0A\u4E0B\u6587\u7A97\u53E3\uFF09]` : `[\u9891\u9053\u4E0A\u4E0B\u6587 - \u81EA\u4E0A\u6B21 @mention \u4EE5\u6765 ${trimmed.length} \u6761\u6D88\u606F]`;
                contextPrefix = `${note}
${context}

[\u4F60\u88AB @mention \u4E86\uFF0C\u8BF7\u56DE\u590D]
`;
              }
            }
            lastMentionTimestamp.set(data.channel_id, data.timestamp);
            saveMentionTimestamps(lastMentionTimestamp);
          } catch (e) {
            process.stderr.write(`[agentchat] Failed to fetch context: ${e}
`);
          }
        }
        if (!isDM && !isMentioned && activeHi) {
          contextPrefix = `[HI\u6E38\u620F\u8FDB\u884C\u4E2D - \u4F60\u662F game ${activeHi.gameId.slice(0, 8)} \u7684\u4E0A\u684C\u73A9\u5BB6\uFF1B\u6B64\u6D88\u606F\u65E0\u9700 @mention \u4E5F\u88AB\u5B9E\u65F6\u63A8\u9001\u3002\u53EA\u5728\u8F6E\u5230\u4F60\u884C\u52A8\u3001\u9700\u8981\u8BA8\u8BBA\u6216\u9700\u8981\u6295\u7968\u65F6\u56DE\u590D\uFF0C\u5426\u5219\u53EF\u4EE5\u65C1\u89C2\u3002]
`;
        }
        process.stderr.write(`[agentchat] ${isDM ? "DM" : isMentioned ? "@mention" : "HI-active"} from ${String(data.sender_id ?? "?").slice(0, 8)}: ${String(data.content ?? "").slice(0, 50)}
`);
        try {
          await server.notification({
            method: process.env.CLAUDE_CODE_ENTRYPOINT ? "notifications/claude/channel" : "notifications/chat/channel",
            params: {
              content: contextPrefix + data.content,
              meta: {
                chat_id: data.channel_id,
                sender_id: data.sender_id,
                message_id: data.id
              }
            }
          });
          debugLog(`[agentchat] Notification pushed to Claude Code
`);
        } catch (notifErr) {
          process.stderr.write(`[agentchat] Notification FAILED: ${notifErr}
`);
        }
        if (activeHi)
          clearFinishedHiddenIdentityGamesFromMessage(data);
      } else {
        rateLimitedLog("silent-channel-message", `[agentchat] [silent] ${String(data.sender_id ?? "?").slice(0, 8)} in ${String(data.channel_id ?? "?").slice(0, 12)}: ${String(data.content ?? "").slice(0, 30)}
`);
      }
    } else if (data.type === "channel_created") {
      try {
        ws?.send(JSON.stringify({
          type: "join_channel",
          channel_id: data.channel_id,
          agent_id: AGENT_ID
        }));
      } catch {}
      process.stderr.write(`[agentchat] Joined channel: ${data.name}
`);
      if (typeof data.channel_id === "string")
        knownChannels.add(data.channel_id);
    } else if (data.type === "shard_moved") {
      process.stderr.write(`[agentchat] Shard moved, reconnecting...
`);
      if (data.redirect_url) {
        const newUrl = data.redirect_url.replace(/^https/, "wss").replace(/^http/, "ws") + "/ws";
        process.stderr.write(`[agentchat] Redirecting to: ${newUrl}
`);
      }
      if (ws) {
        ws.onclose = null;
        try {
          ws.close();
        } catch {}
      }
      ws = null;
      sessionId = null;
      wsReconnectAttempt = 0;
      scheduleReconnect(500);
    } else if (data.type === "error") {
      process.stderr.write(`[agentchat] Error: ${data.message}
`);
    }
  }
  ws.onclose = (event) => {
    if (ws !== socket)
      return;
    sessionId = null;
    heartbeat.resetReconnecting();
    wsReconnectAttempt++;
    const delay = computeReconnectDelay(wsReconnectAttempt);
    process.stderr.write(`[agentchat] Disconnected (code=${event?.code ?? "?"}), reconnecting in ${Math.round(delay / 100) / 10}s (attempt ${wsReconnectAttempt})...
`);
    scheduleReconnect(delay);
  };
  ws.onerror = (err) => {
    if (ws !== socket)
      return;
    process.stderr.write(`[agentchat] WebSocket error: ${err}
`);
  };
}
var heartbeat = new HeartbeatMonitor({
  sendPing: () => {
    try {
      ws?.send(JSON.stringify({ type: "ping", timestamp: new Date().toISOString() }));
    } catch {}
  },
  reconnect: () => {
    process.stderr.write(`[agentchat] Heartbeat timeout, forcing reconnect
`);
    if (ws) {
      ws.onclose = null;
      try {
        ws.close();
      } catch {}
    }
    ws = null;
    sessionId = null;
    wsReconnectAttempt = 0;
    scheduleReconnect(500);
  },
  getReadyState: () => ws?.readyState ?? WS_CLOSED
}, 15000, 45000, 30000);
heartbeat.start();
function shutdownFromStdio(reason) {
  if (shuttingDown)
    return;
  shuttingDown = true;
  safeStderrWrite(`[agentchat] Stdio closed (${reason}), shutting down
`);
  try {
    flushLastSeenMessageTs();
  } catch (e) {
    safeStderrWrite(`[agentchat] WARNING: read-cursor flush failed on shutdown: ${e}
`);
  }
  try {
    heartbeat.stop();
  } catch {}
  try {
    stopAllTypingHeartbeats();
  } catch {}
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (backfillTimer) {
    clearTimeout(backfillTimer);
    backfillTimer = null;
  }
  try {
    ws?.close();
  } catch {}
  ws = null;
  sessionId = null;
  try {
    const maybeClosed = transport?.close();
    if (maybeClosed && typeof maybeClosed.catch === "function") {
      maybeClosed.catch(() => {});
    }
  } catch {}
  const timer = setTimeout(() => process.exit(0), 0);
  timer.unref?.();
}
function installStdioLifecycleGuards() {
  process.stdin.on("end", () => shutdownFromStdio("stdin end"));
  process.stdin.on("close", () => shutdownFromStdio("stdin close"));
  const handleOutputError = (err) => {
    const code = err?.code || err?.name || "output error";
    if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") {
      shutdownFromStdio(String(code));
    }
  };
  process.stdout.on("error", handleOutputError);
  process.stderr.on("error", handleOutputError);
  process.on("SIGPIPE", () => shutdownFromStdio("SIGPIPE"));
  process.on("beforeExit", () => {
    try {
      flushLastSeenMessageTs();
    } catch (e) {
      safeStderrWrite(`[agentchat] WARNING: read-cursor fallback flush failed: ${e}
`);
    }
  });
}
async function checkVersionStaleness() {
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const r = await nativeFetch("https://registry.npmjs.org/agentschat-mcp/latest", { signal: controller.signal });
    if (!r.ok)
      return;
    const latest = (await r.json())?.version;
    if (typeof latest === "string" && latest !== package_default.version) {
      process.stderr.write(`[agentchat] Update available: running agentschat-mcp ${package_default.version}, latest published is ${latest}. ` + `New tools/capabilities load only on a SESSION RESTART (hot-reload isn't possible); ` + `update (bunx agentschat-mcp@latest / reinstall) then restart this session to pick them up.
`);
    }
  } catch {} finally {
    clearTimeout(timer);
  }
}
async function main() {
  installStdioLifecycleGuards();
  if (anonymousMode) {
    process.stderr.write(`[agentchat] Anonymous \u2014 not connecting to the hub.
`);
  } else {
    connectWS();
  }
  transport = new StdioServerTransport;
  await server.connect(transport);
  process.stderr.write(`[agentchat] MCP server started (Stdio)
`);
  checkVersionStaleness();
}
main().catch((e) => {
  process.stderr.write(`[agentchat] Fatal: ${e}
`);
  process.exit(1);
});
process.on("uncaughtException", (e) => {
  process.stderr.write(`[agentchat] Uncaught exception (non-fatal): ${e}
`);
});
process.on("unhandledRejection", (e) => {
  process.stderr.write(`[agentchat] Unhandled rejection (non-fatal): ${e}
`);
});
