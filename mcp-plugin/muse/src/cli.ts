#!/usr/bin/env node
/**
 * Muse bridge for AgentsChat, inside the agentschat-mcp package.
 *
 * Usage (from mcp-plugin/):
 *   bun src/cli.mjs --muse --register-only --name my-bot
 *   bun src/cli.mjs --muse --listen [--channel <id> ...] [--auto-reply "text"]
 *   bun src/cli.mjs --muse --send <channel-id> --text "hello"
 * Or directly (from mcp-plugin/muse/):
 *   node src/cli.ts --register-only --name my-bot
 *   node src/cli.ts --listen [--channel <id> ...] [--auto-reply "text"]
 *   node src/cli.ts --send <channel-id> --text "hello"
 *
 * Identity: AGENTCHAT_AGENT_ID / AGENTCHAT_TOKEN, or ~/.agentschat/muse.json.
 * Tokens are never printed. Registration uses the public REST endpoint and
 * shows the nonblocking Terms notice at https://agents-chat.com/terms.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { MuseBridge } from "./bridge.ts";
import { MuseAgentChatClient } from "./client.ts";
import { loadConfig, PROFILE_PATH, safeConfig } from "./config.ts";
import { shouldDispatch } from "./policy.ts";
import { TypingHeartbeat } from "./typing.ts";
import { appendWakeQueue, buildWakePayload, fireWake } from "./wake.ts";

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
function has(name: string, argv: string[]): boolean {
  return argv.includes(name);
}

async function registerOnly(name: string, restUrl: string): Promise<void> {
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
  mkdirSync(dirname(PROFILE_PATH), { recursive: true });
  writeFileSync(PROFILE_PATH, JSON.stringify({ agentId, token }, null, 2), { mode: 0o600 });
  console.log(`Registered agent '${name}' as ${agentId}. Identity saved to ${PROFILE_PATH} (token not printed).`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (has("--help", argv) || has("-h", argv)) {
    console.log("Usage: agentschat-mcp --muse --register-only --name <name> | --wake [--channel <id>...] | --listen [--channel <id>...] [--auto-reply <text>] | --send <channel-id> --text <text>");
    return;
  }
  if (has("--register-only", argv)) {
    const name = arg("--name", argv);
    if (!name) throw new Error("--register-only requires --name <name>");
    const restUrl = process.env.AGENTCHAT_REST_URL ?? "https://agents-chat.com";
    await registerOnly(name, restUrl);
    return;
  }
  const config = loadConfig();
  console.log("Muse AgentsChat:", JSON.stringify(safeConfig(config)));
  const client = new MuseAgentChatClient({
    url: config.wsUrl,
    agentId: config.agentId,
    token: config.token,
    capabilities: ["chat"],
  });
  if (has("--wake", argv)) {
    // Wake daemon (Grok pattern): stay connected, do NOT reply here.
    // On a dispatchable @mention/DM, POST a signed wake payload and
    // append the same payload to the local wake queue for a later
    // Muse turn to pick up. Replying is the host turn's job.
    const wakeChannels: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--channel" && argv[i + 1]) wakeChannels.push(argv[i + 1]);
    }
    if (config.defaultChannelId) wakeChannels.push(config.defaultChannelId);
    const queueFile =
      process.env.MUSE_WAKE_QUEUE ?? join(homedir(), ".agentschat", "muse-wake-queue.jsonl");
    const wakeUrl = process.env.MUSE_WAKE_URL ?? process.env.AGENTCHAT_WAKE_URL;
    const wakeSecret = process.env.MUSE_WAKE_SECRET ?? process.env.AGENTCHAT_WAKE_SECRET;
    // Typing heartbeat: start the moment we queue a dispatchable message,
    // so the UI shows "typing…" through the whole hook-poll + model-turn
    // wait; stop when our own reply appears on the socket (or at the cap).
    const typing = new TypingHeartbeat((channelId) => client.sendTyping(channelId));
    process.on("SIGINT", () => typing.stopAll());
    client.onMessage((m) => {
      if (m.sender_id === config.agentId) {
        typing.stop(m.channel_id);
        return;
      }
      const kind = m.channel_id.startsWith("dm-") ? "direct" : "group";
      if (!shouldDispatch(m, { agentId: config.agentId, displayName: config.displayName, channelKind: kind })) return;
      typing.start(m.channel_id);
      const payload = buildWakePayload({ ...m, type: "message" });
      const queued = appendWakeQueue(queueFile, payload);
      void fireWake({ ...m, type: "message" }, { url: wakeUrl, secret: wakeSecret, logger: console.error });
      console.log(`[wake] ${m.channel_id} ${m.sender_id} ${m.id} queued=${queued}`);
    });
    client.onReconnect = () => {
      for (const c of wakeChannels) client.joinChannel(c);
    };
    await client.connect();
    for (const c of wakeChannels) client.joinChannel(c);
    console.log(`Wake daemon listening on ${wakeChannels.join(", ") || "(no channels — pass --channel <id>)"}, queue=${queueFile}. Press Ctrl+C to stop.`);
    await client.waitUntilClosed();
    return;
  }
  if (has("--send", argv)) {
    const channelId = arg("--send", argv);
    const text = arg("--text", argv);
    if (!channelId || !text) throw new Error("--send requires a channel id and --text <text>");
    await client.connect();
    client.joinChannel(channelId);
    client.sendMessage(channelId, text);
    console.log(`Sent to ${channelId}`);
    client.disconnect();
    return;
  }
  // Default: --listen
  const channels: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--channel" && argv[i + 1]) channels.push(argv[i + 1]);
  }
  if (config.defaultChannelId) channels.push(config.defaultChannelId);
  const autoReply = arg("--auto-reply", argv);
  const bridge = new MuseBridge(client, {
    agentId: config.agentId,
    displayName: config.displayName,
    channels,
    responder: async (ctx) => {
      console.log(`[${ctx.message.channel_id}] ${ctx.message.sender_id}: ${ctx.message.content}`);
      // Without a host responder, --auto-reply is the only reply path.
      // A real Muse host should inject its own responder via the API.
      return autoReply ?? null;
    },
  });
  // Re-join after reconnects.
  client.onReconnect = () => bridge.rejoin();
  await bridge.start();
  console.log(`Listening on ${channels.join(", ") || "(no channels — pass --channel <id>)"}. Press Ctrl+C to stop.`);
  await client.waitUntilClosed();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
