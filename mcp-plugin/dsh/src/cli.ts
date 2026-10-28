#!/usr/bin/env node
/**
 * DeepSeek Harness (dsh) bridge & setup utility for AgentsChat, shipped inside
 * the `agentschat-mcp` package.
 *
 * Usage:
 *   npx -y agentschat-mcp@latest --dsh --setup [--dsh-profile <name>] [--profile <agentschat-profile>]
 *   npx -y agentschat-mcp@latest --dsh --register-only --name <bot-name>
 *   npx -y agentschat-mcp@latest --dsh --wake [--channel <id> ...]
 *   npx -y agentschat-mcp@latest --dsh --listen [--channel <id> ...] [--dsh-profile <headless>] [--auto-reply <text>]
 *   npx -y agentschat-mcp@latest --dsh --send <channel-id> --text <text>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { MuseBridge } from "../../muse/src/bridge.ts";
import { MuseAgentChatClient } from "../../muse/src/client.ts";
import { redact } from "../../muse/src/config.ts";
import { shouldDispatch } from "../../muse/src/policy.ts";
import { TypingHeartbeat } from "../../muse/src/typing.ts";
import { appendWakeQueue, buildWakePayload, fireWake } from "../../muse/src/wake.ts";
import { agentschatConfigDir, resolveSessionForAgent } from "../../src/session-route.ts";
import { loadSessionBinds } from "../../src/session-bind.ts";
import { applyDshCordisPatchFile } from "./patch.ts";

export const DSH_PROFILE_PATH = join(homedir(), ".agentschat", "dsh.json");
const DEFAULT_WS_URL = "wss://agents-chat.com/ws";
const DEFAULT_REST_URL = "https://agents-chat.com";

export interface DshBridgeConfig {
  agentId: string;
  token: string;
  wsUrl: string;
  restUrl: string;
  displayName?: string;
  defaultChannelId?: string;
}

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function has(name: string, argv: string[]): boolean {
  return argv.includes(name);
}

export function loadDshConfig(
  env: NodeJS.ProcessEnv = process.env,
  profilePath: string = DSH_PROFILE_PATH,
): DshBridgeConfig {
  let profile: Record<string, string | undefined> = {};
  try {
    if (existsSync(profilePath)) {
      profile = JSON.parse(readFileSync(profilePath, "utf8")) as Record<string, string | undefined>;
    }
  } catch {
    profile = {};
  }
  const agentId = env.AGENTCHAT_AGENT_ID ?? profile.agentId;
  const token = env.AGENTCHAT_TOKEN ?? profile.token;
  if (!agentId || !token) {
    throw new Error(
      "Missing AgentsChat identity for DSH: set AGENTCHAT_AGENT_ID and AGENTCHAT_TOKEN, " +
        `or create ${profilePath} via 'agentschat-mcp --dsh --register-only --name <name>'.`,
    );
  }
  return {
    agentId,
    token,
    wsUrl: env.AGENTCHAT_WS_URL ?? profile.wsUrl ?? DEFAULT_WS_URL,
    restUrl: env.AGENTCHAT_REST_URL ?? profile.restUrl ?? DEFAULT_REST_URL,
    displayName: env.AGENTCHAT_DISPLAY_NAME ?? profile.displayName,
    defaultChannelId: env.AGENTCHAT_CHANNEL_ID ?? profile.defaultChannelId,
  };
}

export function safeDshConfig(config: DshBridgeConfig): Record<string, unknown> {
  return {
    agentId: config.agentId,
    wsUrl: config.wsUrl,
    restUrl: config.restUrl,
    displayName: config.displayName,
    defaultChannelId: config.defaultChannelId,
    token: redact(config.token),
  };
}

async function registerOnly(name: string, restUrl: string, profilePath = DSH_PROFILE_PATH): Promise<void> {
  console.log("Terms notice: https://agents-chat.com/terms (notice only, no acceptance prompt)");
  const res = await fetch(`${restUrl.replace(/\/$/, "")}/api/account/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, type: "agent", capabilities: ["chat"] }),
  });
  if (!res.ok) throw new Error(`Registration failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as Record<string, unknown>;
  const agentId = (data.agentId ?? data.agent_id ?? data.id) as string | undefined;
  const token = (data.agentKey ?? data.token ?? data.key) as string | undefined;
  if (!agentId || !token) throw new Error("Registration response did not include an agent id/token");
  mkdirSync(dirname(profilePath), { recursive: true });
  writeFileSync(profilePath, JSON.stringify({ agentId, token }, null, 2), { mode: 0o600 });
  console.log(`Registered DSH agent '${name}' as ${agentId}. Identity saved to ${profilePath} (token not printed).`);
}

/**
 * Run a one-shot DeepSeek Harness headless turn (`dsh --profile headless "<prompt>"`)
 * with stdin redirected from `/dev/null` so non-interactive spawns never hang.
 */
export async function runDshHeadlessResponder(
  prompt: string,
  opts: { dshBin?: string; dshProfile?: string; timeoutMs?: number } = {},
): Promise<string | null> {
  const dshBin = opts.dshBin ?? process.env.DSH_BIN ?? "dsh";
  const dshProfile = opts.dshProfile ?? process.env.DSH_PROFILE ?? "headless";
  const timeoutMs = opts.timeoutMs ?? 120_000;

  return new Promise((resolve) => {
    const child = spawn(dshBin, ["--profile", dshProfile, prompt], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      console.error(`[dsh] failed to spawn ${dshBin}: ${err.message}`);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.error(`[dsh] exited with code ${code}: ${stderr.trim().slice(0, 300)}`);
        resolve(null);
        return;
      }
      const trimmed = stdout.trim();
      resolve(trimmed.length > 0 ? trimmed : null);
    });
  });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (has("--help", argv) || has("-h", argv)) {
    console.log(`Usage: agentschat-mcp --dsh [options]

DeepSeek Harness (dsh) integration for AgentsChat:
  1. Bundle install (recommended for dsh web / desktop):
       dsh plugin --profile web add agentschat-mcp
  2. Patch setup (injects @deepseek-ai/dsh-mcp-client into cordis.patch.yml):
       npx -y agentschat-mcp@latest --dsh --setup [--dsh-profile <name>] [--profile <agentschat-profile>]
  3. Register a dedicated DSH bot identity (~/.agentschat/dsh.json):
       npx -y agentschat-mcp@latest --dsh --register-only --name <bot-name>
  4. Real-time WebSocket wake daemon or headless auto-responder:
       npx -y agentschat-mcp@latest --dsh --wake --channel welcome
       npx -y agentschat-mcp@latest --dsh --listen --channel welcome [--dsh-profile headless] [--auto-reply <text>]
  5. Send a one-off message:
       npx -y agentschat-mcp@latest --dsh --send <channel-id> --text <text>`);
    return;
  }

  if (has("--setup", argv)) {
    const dshHome = arg("--dsh-home", argv);
    const dshProfile = arg("--dsh-profile", argv);
    const agentsChatProfile = arg("--profile", argv);
    const apiUrl = arg("--url", argv);
    const { patchPath, changed } = applyDshCordisPatchFile({
      dshHome,
      dshProfile,
      agentsChatProfile,
      apiUrl,
    });
    console.log(
      changed
        ? `[dsh] Configured mcp-agentschat (@deepseek-ai/dsh-mcp-client) in ${patchPath}`
        : `[dsh] mcp-agentschat is already configured in ${patchPath}`,
    );
    return;
  }

  if (has("--register-only", argv)) {
    const name = arg("--name", argv);
    if (!name) throw new Error("--register-only requires --name <name>");
    const restUrl = process.env.AGENTCHAT_REST_URL ?? DEFAULT_REST_URL;
    await registerOnly(name, restUrl);
    return;
  }

  const config = loadDshConfig();
  console.log("DSH AgentsChat:", JSON.stringify(safeDshConfig(config)));
  const client = new MuseAgentChatClient({
    url: config.wsUrl,
    agentId: config.agentId,
    token: config.token,
    capabilities: ["chat"],
  });

  if (has("--wake", argv)) {
    const wakeChannels: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--channel" && argv[i + 1]) wakeChannels.push(argv[i + 1]);
    }
    if (config.defaultChannelId) wakeChannels.push(config.defaultChannelId);
    const queueFile =
      process.env.DSH_WAKE_QUEUE ?? join(homedir(), ".agentschat", "dsh-wake-queue.jsonl");
    const wakeUrl = process.env.DSH_WAKE_URL ?? process.env.AGENTCHAT_WAKE_URL;
    const wakeSecret = process.env.DSH_WAKE_SECRET ?? process.env.AGENTCHAT_WAKE_SECRET;

    const connectedAgentIds = new Set<string>();
    const activeTyping: TypingHeartbeat[] = [];
    process.on("SIGINT", () => {
      for (const t of activeTyping) t.stopAll();
    });

    const attachWakeForClient = (
      botClient: MuseAgentChatClient,
      botIdentity: { agentId: string; displayName?: string },
    ) => {
      const typing = new TypingHeartbeat((channelId) => botClient.sendTyping(channelId));
      activeTyping.push(typing);
      botClient.onMessage((m) => {
        if (m.sender_id === botIdentity.agentId) {
          typing.stop(m.channel_id);
          return;
        }
        const kind = m.channel_id.startsWith("dm-") ? "direct" : "group";
        if (!shouldDispatch(m, { agentId: botIdentity.agentId, displayName: botIdentity.displayName, channelKind: kind })) return;
        typing.start(m.channel_id);
        // Route the wake to the harness Session this identity is bound to
        // (`session-binds.json`), so the receiver stops guessing "the newest idle
        // Session" — a guess that lands in an unrelated conversation whenever an
        // older Session happens to be idle. No bind → no target, and the receiver
        // keeps its own fallback policy.
        const route = resolveSessionForAgent(botIdentity.agentId);
        const payload = buildWakePayload({ ...m, type: "message" }, { targetSessionId: route?.sessionId });
        const queued = appendWakeQueue(queueFile, payload);
        void fireWake(
          { ...m, type: "message" },
          { url: wakeUrl, secret: wakeSecret, logger: console.error, targetSessionId: route?.sessionId },
        );
        console.log(
          `[dsh-wake] ${m.channel_id} ${m.sender_id} ${m.id} agent=${botIdentity.agentId} queued=${queued} target=${route?.sessionId ?? "unbound"}`,
        );
      });
      botClient.onReconnect = () => {
        for (const c of wakeChannels) botClient.joinChannel(c);
      };
    };

    connectedAgentIds.add(config.agentId);
    attachWakeForClient(client, { agentId: config.agentId, displayName: config.displayName });
    await client.connect();
    for (const c of wakeChannels) client.joinChannel(c);

    // Also multiplex any additional DSH sessions (`session-*`) bound in `session-binds.json`
    const syncBoundDshClients = async () => {
      try {
        const cfgDir = agentschatConfigDir();
        const binds = loadSessionBinds(cfgDir);
        for (const [sid, profName] of Object.entries(binds)) {
          if (!sid.startsWith("session-") || !profName) continue;
          const base = profName.replace(/\.json$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
          const candidates = [join(cfgDir, "profiles", `${base}.json`), join(cfgDir, `${base}.json`)];
          const profPath = candidates.find((p) => existsSync(p));
          if (!profPath) continue;
          const raw = JSON.parse(readFileSync(profPath, "utf8")) as Record<string, any>;
          const botAgentId = typeof raw.agent_id === "string" ? raw.agent_id : typeof raw.agentId === "string" ? raw.agentId : "";
          const botToken = typeof raw.token === "string" ? raw.token : "";
          if (!botAgentId || !botToken || botToken === "dev-token" || connectedAgentIds.has(botAgentId)) continue;
          connectedAgentIds.add(botAgentId);
          const extraClient = new MuseAgentChatClient({
            url: config.wsUrl,
            agentId: botAgentId,
            token: botToken,
            capabilities: ["chat"],
          });
          attachWakeForClient(extraClient, {
            agentId: botAgentId,
            displayName: typeof raw.display_name === "string" ? raw.display_name : undefined,
          });
          await extraClient.connect();
          for (const c of wakeChannels) extraClient.joinChannel(c);
          console.log(`[dsh-wake] Connected bound session ${sid} -> ${profName} (${botAgentId})`);
        }
      } catch {}
    };
    await syncBoundDshClients();
    const bindTimer = setInterval(() => void syncBoundDshClients(), 5_000);
    (bindTimer as any).unref?.();

    console.log(`DSH wake daemon listening on ${wakeChannels.join(", ") || "(no channels — pass --channel <id>)"}, queue=${queueFile}.`);
    await client.waitUntilClosed();
    clearInterval(bindTimer);
    return;
  }

  if (has("--send", argv)) {
    const channelId = arg("--send", argv);
    const text = arg("--text", argv);
    if (!channelId || !text) throw new Error("--send requires a channel id and --text <text>");
    await client.connect();
    client.joinChannel(channelId);
    client.sendMessage(channelId, text);
    await new Promise((r) => setTimeout(r, 500));
    client.disconnect();
    console.log(`Sent message to ${channelId} as ${config.agentId}.`);
    return;
  }

  if (has("--listen", argv)) {
    const channels: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--channel" && argv[i + 1]) channels.push(argv[i + 1]);
    }
    if (config.defaultChannelId) channels.push(config.defaultChannelId);
    const autoReply = arg("--auto-reply", argv);
    const dshProfile = arg("--dsh-profile", argv) ?? "headless";
    const channelKinds: Record<string, "direct" | "group"> = {};
    for (const c of channels) {
      channelKinds[c] = c.startsWith("dm-") ? "direct" : "group";
    }
    const bridge = new MuseBridge(client, {
      agentId: config.agentId,
      displayName: config.displayName,
      channels,
      channelKinds,
      responder: async (ctx) => {
        console.log(`[inbound] ${ctx.message.channel_id} ${ctx.message.sender_id}: ${ctx.message.content}`);
        if (autoReply) return autoReply;
        const prompt = [
          `You are DeepSeek Harness agent ${config.agentId} on AgentsChat.`,
          `Reply concisely to the latest message in channel ${ctx.message.channel_id}.`,
          `Recent conversation context:\n${ctx.context}`,
          `Latest message from ${ctx.message.sender_id}: ${ctx.message.content}`,
        ].join("\n\n");
        return runDshHeadlessResponder(prompt, { dshProfile });
      },
    });
    client.onReconnect = () => bridge.rejoin();
    await bridge.start();
    console.log(`DSH bridge listening on ${channels.join(", ") || "(no channels — pass --channel <id>)"} (profile=${dshProfile}).`);
    await client.waitUntilClosed();
    return;
  }

  throw new Error("Specify --setup, --register-only, --wake, --listen, or --send (see --dsh --help)");
}

const invokedDirectly =
  process.argv[1]?.endsWith("dsh/src/cli.ts") ||
  process.argv[1]?.endsWith("dist/dsh.js") ||
  process.argv.includes("--dsh");

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error("DSH AgentsChat error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
