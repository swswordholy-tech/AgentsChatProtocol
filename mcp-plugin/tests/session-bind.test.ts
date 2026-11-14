import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  acquireAgentLock,
  checkAgentLock,
  detectAntigravityCallerSession,
  detectDshCallerSession,
  detectRuntimeSession,
  findBoundSessionForProfile,
  loadSessionBinds,
  parseAntigravityLsofOutput,
  parseWindowsAntigravityProbeJson,
  parseWindowsNetstatOutput,
  readAgentLock,
  releaseAgentLock,
  removeSessionBind,
  resolveLockDir,
  saveSessionBind,
} from "../src/session-bind.ts";
import { decideIdentity } from "../src/identity.ts";
import { findDefaultProfileCollision } from "../src/profile-store.ts";
import { buildWakePrompt, fireAntigravityWake, fireZcodeWake } from "../src/wake.ts";

const ENTRY = resolve(import.meta.dir, "../src/server.ts");

describe("session-bind & agent lock unit tests", () => {
  test("acquireAgentLock, checkAgentLock, and releaseAgentLock enforce single active owner", () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-lock-"));
    const lock = acquireAgentLock({
      lockDir: dir,
      agentId: "agent-alpha",
      profileName: "Alpha",
      runtime: "claude-code",
      sessionId: "sess-1",
      currentPid: process.pid,
    });
    expect(lock).not.toBeNull();
    expect(readAgentLock(dir, "agent-alpha")?.agentId).toBe("agent-alpha");

    // Same PID is allowed when sessionId is omitted or matches, but blocked when a DIFFERENT sessionId in the same process checks the lock
    expect(checkAgentLock({ lockDir: dir, agentId: "agent-alpha", currentPid: process.pid }).locked).toBe(false);
    expect(
      checkAgentLock({ lockDir: dir, agentId: "agent-alpha", currentPid: process.pid, currentSessionId: "sess-1" }).locked,
    ).toBe(false);
    expect(
      checkAgentLock({ lockDir: dir, agentId: "agent-alpha", currentPid: process.pid, currentSessionId: "sess-2" }).locked,
    ).toBe(true);
    // Different PID is blocked
    const otherCheck = checkAgentLock({ lockDir: dir, agentId: "agent-alpha", currentPid: 999999 });
    expect(otherCheck.locked).toBe(true);
    expect(otherCheck.holder?.profileName).toBe("Alpha");

    // Same sessionId or lockOwnerPid is allowed (e.g. ZCode wake or Codex AppServer child)
    expect(
      checkAgentLock({ lockDir: dir, agentId: "agent-alpha", currentPid: 999999, currentSessionId: "sess-1" }).locked,
    ).toBe(false);
    expect(
      checkAgentLock({ lockDir: dir, agentId: "agent-alpha", currentPid: 999999, lockOwnerPid: process.pid }).locked,
    ).toBe(false);

    // Release by wrong PID is ignored
    releaseAgentLock({ lockDir: dir, agentId: "agent-alpha", currentPid: 999999 });
    expect(readAgentLock(dir, "agent-alpha")).not.toBeNull();

    // Release by owning PID removes lock
    releaseAgentLock({ lockDir: dir, agentId: "agent-alpha", currentPid: process.pid });
    expect(readAgentLock(dir, "agent-alpha")).toBeNull();
  });

  test("stale lock with dead PID is automatically cleaned up", () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-stale-lock-"));
    // Write a lock for a guaranteed-dead PID
    writeFileSync(
      join(dir, "agent-dead.lock"),
      JSON.stringify({
        pid: 999998,
        agentId: "agent-dead",
        profileName: "DeadBot",
        runtime: "claude-code",
        updatedAt: new Date().toISOString(),
      }),
    );
    const check = checkAgentLock({ lockDir: dir, agentId: "agent-dead", currentPid: process.pid });
    expect(check.locked).toBe(false);
    expect(check.stale).toBe(true);
    expect(existsSync(join(dir, "agent-dead.lock"))).toBe(false);
  });

  test("session-binds CRUD persists and resolves profile bindings (1:1 per profile)", () => {
    const configDir = mkdtempSync(join(tmpdir(), "ac-binds-"));

    saveSessionBind(configDir, "sess-claude-1", "ClaudeBot");
    saveSessionBind(configDir, "sess-other-tab", "ClaudeBot");
    // Re-binding sess-claude-1 to ClaudeBot must evict sess-other-tab so ClaudeBot maps 1:1 to sess-claude-1
    saveSessionBind(configDir, "sess-claude-1", "ClaudeBot");

    const binds = loadSessionBinds(configDir);
    expect(binds["sess-claude-1"]).toBe("ClaudeBot");
    expect(binds["sess-other-tab"]).toBeUndefined();

    const found = findBoundSessionForProfile(configDir, "ClaudeBot");
    expect(found).toBe("sess-claude-1");

    removeSessionBind(configDir, "sess-claude-1");
    expect(loadSessionBinds(configDir)["sess-claude-1"]).toBeUndefined();
  });

  test("detectRuntimeSession extracts ZCode _meta, ZCODE_SESSION_ID, ANTIGRAVITY_CONVERSATION_ID, and CLAUDE_CODE_SESSION_ID", () => {
    expect(
      detectRuntimeSession(
        {},
        { session_id: "sess_zcode_meta", workspace_path: "/work/a" },
      ),
    ).toEqual({
      runtime: "zcode",
      sessionId: "sess_zcode_meta",
      workspacePath: "/work/a",
    });

    expect(
      detectRuntimeSession(
        {},
        { "com.zcode/request-context": { session_id: "sess_zcode_nested", workspace_path: "/work/b" } },
      ),
    ).toEqual({
      runtime: "zcode",
      sessionId: "sess_zcode_nested",
      workspacePath: "/work/b",
    });

    expect(detectRuntimeSession({ ZCODE_SESSION_ID: "sess_env" })).toEqual({
      runtime: "zcode",
      sessionId: "sess_env",
    });

    expect(detectRuntimeSession({ ANTIGRAVITY_CONVERSATION_ID: "agy-uuid-1" })).toEqual({
      runtime: "antigravity",
      sessionId: "agy-uuid-1",
    });

    expect(detectRuntimeSession({ CLAUDE_CODE_SESSION_ID: "claude-uuid-1" })).toEqual({
      runtime: "claude-code",
      sessionId: "claude-uuid-1",
    });
  });

  test("session-bind is treated as a declared identity in decideIdentity", () => {
    expect(
      decideIdentity({
        profileExists: true,
        source: "session-bind",
        declaredName: "BoundBot",
        profileFile: "/tmp/BoundBot.json",
        hasToken: false,
        fallbackName: "Fallback",
      }).mode,
    ).toBe("profile");

    const missing = decideIdentity({
      profileExists: false,
      source: "session-bind",
      declaredName: "MissingBoundBot",
      profileFile: "/tmp/MissingBoundBot.json",
      hasToken: false,
      fallbackName: "Fallback",
    });
    expect(missing.mode).toBe("error");
  });
});

describe("native Antigravity & ZCode wake unit tests", () => {
  test("buildWakePrompt formats DM and channel mention prompts cleanly with contextPrefix and optional get_history", () => {
    const dmPrompt = buildWakePrompt({
      channel_id: "dm-1",
      id: "m-1",
      sender_id: "alice",
      content: "hello there",
    });
    expect(dmPrompt).toContain("[AgentsChat] alice 在私聊 (dm-1)给你发了消息");
    expect(dmPrompt).toContain("hello there");
    expect(dmPrompt).toContain("message_id=m-1");
    expect(dmPrompt).toContain("仅在需要更早上下文时调用 get_history");

    const mentionPrompt = buildWakePrompt(
      {
        channel_id: "ch-general",
        id: "m-2",
        sender_id: "bob",
        content: "@bot ping",
      },
      "[频道上下文 - 自上次 @mention 以来 2 条消息]\nalice: earlier 1\ncharlie: earlier 2",
    );
    expect(mentionPrompt).toContain("[频道上下文 - 自上次 @mention 以来 2 条消息]");
    expect(mentionPrompt).toContain("alice: earlier 1");
    expect(mentionPrompt).toContain("[AgentsChat] bob 在频道 ch-general给你发了消息");
  });

  test("fireAntigravityWake posts Connect-RPC SendAgentMessage and falls back across ports", async () => {
    let receivedHeaders: Record<string, string | null> = {};
    let receivedBody: any = null;
    const mockLs = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/exa.language_server_pb.LanguageServerService/SendAgentMessage") {
          receivedHeaders = {
            csrf: req.headers.get("x-codeium-csrf-token"),
            connectVer: req.headers.get("connect-protocol-version"),
          };
          receivedBody = await req.json();
          return Response.json({ ok: true });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const ok = await fireAntigravityWake(
        {
          channel_id: "dm-abc",
          id: "msg-77",
          sender_id: "user-1",
          content: "test wake",
        },
        {
          csrfToken: "csrf-secret-123",
          ports: [1, mockLs.port!], // Port 1 fails, falls back to mockLs.port
          conversationId: "conv-uuid-999",
        },
      );
      expect(ok).toBe(true);
      expect(receivedHeaders.csrf).toBe("csrf-secret-123");
      expect(receivedHeaders.connectVer).toBe("1");
      expect(receivedBody?.recipient).toBe("conv-uuid-999");
      expect(receivedBody?.senderId).toBe("agentschat:user-1");
      expect(receivedBody?.displayTitle).toBe("AgentsChat #dm-abc");
      expect(receivedBody?.content).toContain("user-1");
      expect(receivedBody?.content).toContain("test wake");
    } finally {
      mockLs.stop(true);
    }
  });

  test("fireZcodeWake serializes wakes per session and passes --resume, AGENTSCHAT_TOOL_ONLY=1, and AGENTSCHAT_LOCK_OWNER_PID", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ac-zcode-wake-"));
    const logFile = join(tmp, "zcode-invocations.jsonl");
    const fakeBin = join(tmp, "fake-zcode.sh");
    writeFileSync(
      fakeBin,
      `#!/bin/sh
printf '{"args":%s,"tool_only":"%s","owner_pid":"%s","cwd":"%s"}\\n' "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@")" "$AGENTSCHAT_TOOL_ONLY" "$AGENTSCHAT_LOCK_OWNER_PID" "$(pwd)" >> "${logFile}"
`,
    );
    chmodSync(fakeBin, 0o755);

    const p1 = fireZcodeWake(
      {
        channel_id: "dm-1",
        id: "m-1",
        sender_id: "u1",
        content: "first message",
      },
      {
        sessionId: "sess_test_1",
        workspacePath: tmp,
        lockOwnerPid: 42424,
        zcodeBin: fakeBin,
      },
    );
    const p2 = fireZcodeWake(
      {
        channel_id: "dm-1",
        id: "m-2",
        sender_id: "u1",
        content: "second message",
      },
      {
        sessionId: "sess_test_1",
        workspacePath: tmp,
        lockOwnerPid: 42424,
        zcodeBin: fakeBin,
      },
    );
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);

    const lines = readFileSync(logFile, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.length).toBe(2);
    expect(lines[0].tool_only).toBe("1");
    expect(lines[0].owner_pid).toBe("42424");
    expect(lines[0].args).toContain("--resume");
    expect(lines[0].args).toContain("sess_test_1");
    expect(lines[0].args[1]).toContain("first message");
    expect(lines[1].args[1]).toContain("second message");
  });
});

describe("multi-window lock & connect_profile / disconnect_profile integration tests", () => {
  let hub: ReturnType<typeof Bun.serve>;
  let BASE = "";
  let regCounter = 0;

  beforeAll(() => {
    hub = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        if (req.method === "POST" && u.pathname === "/api/account/register") {
          const body = (await req.json().catch(() => ({}))) as any;
          regCounter++;
          const id = `minted-agent-${regCounter}`;
          return Response.json({
            id,
            key: `ac_key_${regCounter}`,
            claim_url: `${BASE}/chat/${id}?key=ac_key_${regCounter}`,
            name: body?.name || id,
          });
        }
        return Response.json({});
      },
    });
    BASE = `http://127.0.0.1:${hub.port}`;
  });

  afterAll(() => hub.stop(true));

  const INIT = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  };
  const INITED = { jsonrpc: "2.0", method: "notifications/initialized" };
  const callTool = (id: number, name: string, args: any = {}, meta?: Record<string, any>) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
  });

  function spawnMcpSession(
    home: string,
    args: string[] = [],
    extraEnv: Record<string, string> = {},
    url: string = BASE,
  ) {
    const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [ENTRY, "--url", url, ...args], {
      env: {
        PATH: process.env.PATH!,
        HOME: home,
        AGENTCHAT_NO_PROXY: "1",
        AGENTCHAT_REST_URL: BASE,
        AGENTCHAT_URL: "ws://127.0.0.1:1/ws",
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    const responses = new Map<number, any>();
    child.stdout.on("data", (d) => {
      out += d;
      let nl: number;
      while ((nl = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (line) {
          try {
            const m = JSON.parse(line);
            if (m.id !== undefined) responses.set(m.id, m);
          } catch {}
        }
      }
    });
    async function send(frame: any) {
      child.stdin.write(JSON.stringify(frame) + "\n");
      if (frame.id === undefined) return null;
      const deadline = Date.now() + 3000;
      while (!responses.has(frame.id) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      return responses.get(frame.id);
    }
    async function close() {
      try {
        child.kill("SIGTERM");
      } catch {}
      await new Promise((r) => setTimeout(r, 80));
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    return { child, send, close };
  }

  test("Window 2 falls back to anonymous when default profile is locked by Window 1, then connects and switches cleanly", async () => {
    const home = mkdtempSync(join(tmpdir(), "ac-multiwin-"));
    const cfgDir = join(home, ".agentschat");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, "profile.json"),
      JSON.stringify({
        agent_id: "default-bot-id",
        display_name: "DefaultBot",
        token: "ac_default_token",
        capabilities: ["coding"],
      }),
    );
    writeFileSync(
      join(cfgDir, "SecondBot.json"),
      JSON.stringify({
        agent_id: "second-bot-id",
        display_name: "SecondBot",
        token: "ac_second_token",
        capabilities: ["coding"],
      }),
    );

    const win1 = spawnMcpSession(home, [], { CLAUDE_CODE_SESSION_ID: "win-1-session" });
    try {
      await win1.send(INIT);
      await win1.send(INITED);
      const w1Who = await win1.send(callTool(2, "whoami"));
      const w1Text = w1Who.result.content[0].text as string;
      expect(w1Text).toContain("Agent ID: default-bot-id");

      // Now open Window 2 with the same HOME and no --profile while Window 1 is alive
      const win2 = spawnMcpSession(home, [], { CLAUDE_CODE_SESSION_ID: "win-2-session" });
      try {
        await win2.send(INIT);
        await win2.send(INITED);
        const w2Who = await win2.send(callTool(2, "whoami"));
        const w2Text = w2Who.result.content[0].text as string;
        // Must NOT collide with Window 1! Starts in anonymous mode:
        expect(w2Text).toContain("(none — anonymous, no profile written)");
        expect(w2Text).not.toContain("Agent ID: default-bot-id");

        // Trying to connect_profile to default profile while Window 1 holds it is refused:
        const tryDefault = await win2.send(callTool(3, "connect_profile", { profile_name: "profile" }));
        expect(tryDefault.result.isError).toBe(true);
        expect(tryDefault.result.content[0].text).toContain("currently in use");

        // Window 2 connects to SecondBot:
        const connectSecond = await win2.send(callTool(4, "connect_profile", { profile_name: "SecondBot" }));
        expect(connectSecond.result.isError).toBeUndefined();
        expect(connectSecond.result.content[0].text).toContain("second-bot-id");

        // Verify session-binds.json recorded win-2-session -> SecondBot
        const binds = loadSessionBinds(cfgDir);
        expect(binds["win-2-session"]).toBe("SecondBot");

        // Window 1 disconnects its profile:
        const disc1 = await win1.send(callTool(5, "disconnect_profile"));
        expect(disc1.result.content[0].text).toContain("Disconnected from profile");

        // Now Window 2 can switch to default profile ("profile") since Window 1 released the lock!
        const takeDefault = await win2.send(callTool(6, "connect_profile", { profile_name: "profile" }));
        expect(takeDefault.result.isError).toBeUndefined();
        expect(takeDefault.result.content[0].text).toContain("default-bot-id");

        // Window 2 can also register a brand-new profile in-session:
        const regNew = await win2.send(callTool(7, "connect_profile", { register_name: "InSessionBot" }));
        expect(regNew.result.isError).toBeUndefined();
        expect(regNew.result.content[0].text).toContain('Registered and connected profile "InSessionBot"');
        expect(existsSync(join(cfgDir, "InSessionBot.json"))).toBe(true);
      } finally {
        await win2.close();
      }
    } finally {
      await win1.close();
    }
  });

  test("ZCode _meta.session_id in tools/call dynamically binds the session and updates lock metadata", async () => {
    const home = mkdtempSync(join(tmpdir(), "ac-zcode-meta-"));
    const cfgDir = join(home, ".agentschat");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, "profile.json"),
      JSON.stringify({
        agent_id: "zcode-bot-id",
        display_name: "ZCodeBot",
        token: "ac_zcode_token",
        capabilities: ["coding"],
      }),
    );

    const zwin = spawnMcpSession(home);
    try {
      await zwin.send(INIT);
      await zwin.send(INITED);
      const who = await zwin.send(
        callTool(2, "whoami", {}, { session_id: "sess_zcode_live_99", workspace_path: "/tmp/zcode-ws" }),
      );
      const text = who.result.content[0].text as string;
      expect(text).toContain("Agent ID: zcode-bot-id");

      const binds = loadSessionBinds(cfgDir);
      expect(binds["sess_zcode_live_99"]).toBe("profile");

      const lockDir = resolveLockDir(home, { HOME: home });
      const lock = readAgentLock(lockDir, "zcode-bot-id");
      expect(lock?.sessionId).toBe("sess_zcode_live_99");
      expect(lock?.runtime).toBe("zcode");
    } finally {
      await zwin.close();
    }
  });

  test("detectAntigravityCallerSession & detectDshCallerSession identify active caller sessions", async () => {
    const brainDir = mkdtempSync(join(tmpdir(), "ac-agy-brain-"));
    const cidA = "11111111-1111-4111-8111-111111111111";
    const cidB = "22222222-2222-4222-8222-222222222222";
    const logDirA = join(brainDir, cidA, ".system_generated", "logs");
    const logDirB = join(brainDir, cidB, ".system_generated", "logs");
    mkdirSync(logDirA, { recursive: true });
    mkdirSync(logDirB, { recursive: true });

    writeFileSync(
      join(logDirA, "transcript.jsonl"),
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "call_mcp_tool",
            args: { ServerName: '"agentschat"', ToolName: '"whoami"', Arguments: "{}" },
          },
        ],
      }) + "\n",
    );
    writeFileSync(
      join(logDirB, "transcript.jsonl"),
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "call_mcp_tool",
            args: {
              ServerName: '"agentschat"',
              ToolName: '"reply"',
              Arguments: '{"chat_id":"dm-target-99","text":"hello from B"}',
            },
          },
        ],
      }) + "\n",
    );

    expect(detectAntigravityCallerSession({ brainDir, toolName: "whoami", args: {} })).toBe(cidA);
    expect(
      detectAntigravityCallerSession({
        brainDir,
        toolName: "reply",
        args: { chat_id: "dm-target-99", text: "hello from B" },
      }),
    ).toBe(cidB);

    const dshHome = mkdtempSync(join(tmpdir(), "ac-dsh-home-"));
    const sessionsDir = join(dshHome, "storages", "session_projcache", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "session-alpha.json"), "{}");
    writeFileSync(join(sessionsDir, "session-beta.json"), "{}");

    const detectedRunning = await detectDshCallerSession({
      dshHome,
      fetchImpl: (async () =>
        Response.json({
          ok: true,
          roots: [
            { id: "session-alpha", status: "idle" },
            { id: "session-beta", status: "running" },
          ],
        })) as any,
    });
    expect(detectedRunning).toBe("session-beta");
  });

  test("Single MCP process multiplexes multiple bound sessions (ZCode _meta & Antigravity transcript) with simultaneous WS connections", async () => {
    const home = mkdtempSync(join(tmpdir(), "ac-multislot-"));
    const cfgDir = join(home, ".agentschat");
    const brainDir = mkdtempSync(join(tmpdir(), "ac-agy-live-brain-"));
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, "profile.json"),
      JSON.stringify({
        agent_id: "slot-bot-1",
        display_name: "SlotBot1",
        token: "ac_slot_token_1",
        capabilities: ["coding"],
      }),
    );
    writeFileSync(
      join(cfgDir, "SecondBot.json"),
      JSON.stringify({
        agent_id: "slot-bot-2",
        display_name: "SlotBot2",
        token: "ac_slot_token_2",
        capabilities: ["coding"],
      }),
    );
    writeFileSync(
      join(cfgDir, "ThirdBot.json"),
      JSON.stringify({
        agent_id: "slot-bot-3",
        display_name: "SlotBot3",
        token: "ac_slot_token_3",
        capabilities: ["coding"],
      }),
    );

    // Local mock WS + REST hub that tracks currently authenticated agent_ids
    const onlineAgents = new Set<string>();
    const wsHub = Bun.serve<{ agentId?: string }>({
      port: 0,
      fetch(req, server) {
        const u = new URL(req.url);
        if (u.pathname === "/ws" && server.upgrade(req, { data: {} })) {
          return undefined;
        }
        return Response.json({ ok: true, build: "test" });
      },
      websocket: {
        message(ws, message) {
          try {
            const data = JSON.parse(String(message));
            if (data.type === "auth" && typeof data.agent_id === "string") {
              ws.data.agentId = data.agent_id;
              onlineAgents.add(data.agent_id);
              ws.send(JSON.stringify({ type: "auth_ok", session_id: `ws-sess-${data.agent_id}` }));
            } else if (data.type === "ping") {
              ws.send(JSON.stringify({ type: "pong" }));
            }
          } catch {}
        },
        close(ws) {
          if (ws.data?.agentId) onlineAgents.delete(ws.data.agentId);
        },
      },
    });

    const cidA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const cidB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const logDirA = join(brainDir, cidA, ".system_generated", "logs");
    const logDirB = join(brainDir, cidB, ".system_generated", "logs");
    mkdirSync(logDirA, { recursive: true });
    mkdirSync(logDirB, { recursive: true });

    const mcp = spawnMcpSession(home, [], {
      AGENTCHAT_REST_URL: `http://127.0.0.1:${wsHub.port}`,
      AGENTCHAT_URL: `ws://127.0.0.1:${wsHub.port}/ws`,
      AGENTSCHAT_AGY_BRAIN_DIR: brainDir,
    });

    try {
      await mcp.send(INIT);
      await mcp.send(INITED);

      // Wait briefly for initial slot-bot-1 WS auth
      for (let i = 0; i < 25 && !onlineAgents.has("slot-bot-1"); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(onlineAgents.has("slot-bot-1")).toBe(true);

      // 1. Conversation A (Antigravity) calls whoami -> claims unbound boot slot ("profile" / slot-bot-1)
      writeFileSync(
        join(logDirA, "transcript.jsonl"),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          tool_calls: [{ name: "call_mcp_tool", args: { ToolName: '"whoami"', Arguments: "{}" } }],
        }) + "\n",
      );
      const whoA1 = await mcp.send(callTool(10, "whoami"));
      expect(whoA1.result.content[0].text).toContain("Agent ID: slot-bot-1");
      expect(loadSessionBinds(cfgDir)[cidA]).toBe("profile");

      // 2. Conversation B (Antigravity) calls whoami -> must NOT steal slot-bot-1 from Conversation A!
      writeFileSync(
        join(logDirB, "transcript.jsonl"),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          tool_calls: [{ name: "call_mcp_tool", args: { ToolName: '"whoami"', Arguments: "{}" } }],
        }) + "\n",
      );
      const whoB1 = await mcp.send(callTool(11, "whoami"));
      expect(whoB1.result.content[0].text).toContain("(none — anonymous, no profile written)");
      expect(onlineAgents.has("slot-bot-1")).toBe(true);

      // 3. Conversation B tries to connect to "profile" -> refused because Conversation A holds it
      writeFileSync(
        join(logDirB, "transcript.jsonl"),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          tool_calls: [
            {
              name: "call_mcp_tool",
              args: { ToolName: '"connect_profile"', Arguments: '{"profile_name":"profile"}' },
            },
          ],
        }) + "\n",
      );
      const trySteal = await mcp.send(callTool(12, "connect_profile", { profile_name: "profile" }));
      expect(trySteal.result.isError).toBe(true);
      expect(trySteal.result.content[0].text).toContain("currently in use");

      // 4. Conversation B connects to "SecondBot" -> BOTH slot-bot-1 and slot-bot-2 stay online simultaneously!
      writeFileSync(
        join(logDirB, "transcript.jsonl"),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          tool_calls: [
            {
              name: "call_mcp_tool",
              args: { ToolName: '"connect_profile"', Arguments: '{"profile_name":"SecondBot"}' },
            },
          ],
        }) + "\n",
      );
      const connB = await mcp.send(callTool(13, "connect_profile", { profile_name: "SecondBot" }));
      expect(connB.result.isError).toBeUndefined();
      expect(connB.result.content[0].text).toContain("slot-bot-2");

      for (let i = 0; i < 25 && !onlineAgents.has("slot-bot-2"); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(onlineAgents.has("slot-bot-1")).toBe(true);
      expect(onlineAgents.has("slot-bot-2")).toBe(true);

      // 5. ZCode Session 3 (via _meta.session_id) connects to "ThirdBot" -> ALL THREE bots online in one process!
      const connC = await mcp.send(
        callTool(14, "connect_profile", { profile_name: "ThirdBot" }, { session_id: "sess_zcode_3" }),
      );
      expect(connC.result.isError).toBeUndefined();
      expect(connC.result.content[0].text).toContain("slot-bot-3");

      for (let i = 0; i < 25 && !onlineAgents.has("slot-bot-3"); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(onlineAgents.has("slot-bot-1")).toBe(true);
      expect(onlineAgents.has("slot-bot-2")).toBe(true);
      expect(onlineAgents.has("slot-bot-3")).toBe(true);

      // 6. Verify automatic per-call routing across all 3 sessions without manual switching!
      writeFileSync(
        join(logDirA, "transcript.jsonl"),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          tool_calls: [{ name: "call_mcp_tool", args: { ToolName: '"whoami"', Arguments: "{}" } }],
        }) + "\n",
      );
      const checkA = await mcp.send(callTool(15, "whoami"));
      expect(checkA.result.content[0].text).toContain("Agent ID: slot-bot-1");

      writeFileSync(
        join(logDirB, "transcript.jsonl"),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          tool_calls: [{ name: "call_mcp_tool", args: { ToolName: '"whoami"', Arguments: "{}" } }],
        }) + "\n",
      );
      const checkB = await mcp.send(callTool(16, "whoami"));
      expect(checkB.result.content[0].text).toContain("Agent ID: slot-bot-2");

      const checkC = await mcp.send(callTool(17, "whoami", {}, { session_id: "sess_zcode_3" }));
      expect(checkC.result.content[0].text).toContain("Agent ID: slot-bot-3");
    } finally {
      await mcp.close();
      wsHub.stop(true);
    }
  });

  test("concurrent tools/call from two bound sessions never answers as the other identity", async () => {
    const home = mkdtempSync(join(tmpdir(), "ac-concurrent-"));
    const cfgDir = join(home, ".agentschat");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, "profile.json"),
      JSON.stringify({ agent_id: "conc-bot-1", display_name: "ConcBot1", token: "ac_conc_1", capabilities: ["coding"] }),
    );
    writeFileSync(
      join(cfgDir, "SecondBot.json"),
      JSON.stringify({ agent_id: "conc-bot-2", display_name: "ConcBot2", token: "ac_conc_2", capabilities: ["coding"] }),
    );
    writeFileSync(join(cfgDir, "session-binds.json"), JSON.stringify({ sess_A: "profile", sess_B: "SecondBot" }));

    // Slow REST so the first handler is still awaiting when the second request
    // arrives: without serialization, `whoami` formats its answer from the
    // globals the *second* request just swapped.
    const slowRest = Bun.serve({
      port: 0,
      async fetch(req) {
        const auth = req.headers.get("authorization") ?? "";
        const agent = auth.includes("ac_conc_2") ? "conc-bot-2" : "conc-bot-1";
        await new Promise((r) => setTimeout(r, 80));
        return Response.json({ ok: true, build: "conc-test", agent_id: agent, claimed: true });
      },
    });

    const mcp = spawnMcpSession(
      home,
      [],
      { AGENTCHAT_URL: "ws://127.0.0.1:1/ws" },
      `http://127.0.0.1:${slowRest.port}`,
    );
    try {
      await mcp.send(INIT);
      await mcp.send(INITED);

      const a = mcp.send(callTool(20, "whoami", {}, { session_id: "sess_A" }));
      const b = mcp.send(callTool(21, "whoami", {}, { session_id: "sess_B" }));
      const [ra, rb] = await Promise.all([a, b]);

      expect(ra.result.content[0].text).toContain("Agent ID: conc-bot-1");
      expect(rb.result.content[0].text).toContain("Agent ID: conc-bot-2");
      // Both sessions kept their own bind; neither stole the other's slot.
      expect(loadSessionBinds(cfgDir)).toEqual({ sess_A: "profile", sess_B: "SecondBot" });
    } finally {
      await mcp.close();
      slowRest.stop(true);
    }
  });

  test("DSH caller detection prefers the session whose log was written last, even without /health", async () => {
    const dshHome = mkdtempSync(join(tmpdir(), "ac-dsh-logs-"));
    const writeLog = (project: string, sid: string, ageMs: number) => {
      const dir = join(dshHome, "sessions", project, sid);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "session.v4.jsonl.zstd");
      writeFileSync(file, "x");
      const when = new Date(Date.now() - ageMs);
      utimesSync(file, when, when);
    };
    writeLog("--proj--", "session-a", 20_000);
    writeLog("--proj--", "session-b", 120);

    const bothRunning = await detectDshCallerSession({
      dshHome,
      fetchImpl: (async () =>
        Response.json({
          ok: true,
          roots: [
            { id: "session-a", status: "running" },
            { id: "session-b", status: "running" },
          ],
        })) as any,
    });
    expect(bothRunning).toBe("session-b");

    // No inbound plugin: the log mtime is still enough to route.
    const noHealth = await detectDshCallerSession({
      dshHome,
      fetchImpl: (async () => {
        throw new Error("health down");
      }) as any,
    });
    expect(noHealth).toBe("session-b");

    // Nothing running: the same fallback applies.
    const allIdle = await detectDshCallerSession({
      dshHome,
      fetchImpl: (async () =>
        Response.json({
          ok: true,
          roots: [
            { id: "session-a", status: "idle" },
            { id: "session-b", status: "idle" },
          ],
        })) as any,
    });
    expect(allIdle).toBe("session-b");
  });

  test("parseAntigravityLsofOutput excludes antigravity-cli archived DBs and prefers active presence locks over cached closed DBs", () => {
    const sampleLsof = [
      "language_ 48306 user   12u  IPv4 0x0 0t0  TCP 127.0.0.1:61779 (LISTEN)",
      "language_ 48306 user   13u  IPv4 0x0 0t0  TCP 127.0.0.1:61780 (LISTEN)",
      "language_ 48306 user   21u  REG  1,13   0 1 /Users/test/.gemini/antigravity/presence/ba32c38a-052c-4291-86dd-373a68ea85a3.lock",
      "language_ 48306 user   61r  REG  1,13 100 2 /Users/test/.gemini/antigravity-cli/conversations/04037723-dc99-4708-abbb-9a74d51a9504.db",
      "language_ 48306 user 2573u  REG  1,13 100 3 /Users/test/.gemini/antigravity/conversations/ba32c38a-052c-4291-86dd-373a68ea85a3.db",
      "language_ 48306 user 2912u  REG  1,13 100 4 /Users/test/.gemini/antigravity/conversations/967a065b-8d82-494f-a11f-dc7acb86251c.db",
    ].join("\n");

    const parsed = parseAntigravityLsofOutput(sampleLsof, "antigravity");
    expect(parsed.ports).toEqual([61780, 61779]);
    // Only the active presence lock is treated as open (archived antigravity-cli DB and closed cached DB are excluded)
    expect(parsed.openConversations).toEqual(["ba32c38a-052c-4291-86dd-373a68ea85a3"]);

    // Fallback when no presence lock FD exists: non-CLI IDE DBs are returned, still excluding antigravity-cli
    const noPresence = sampleLsof
      .split("\n")
      .filter((l) => !l.includes("/presence/"))
      .join("\n");
    expect(parseAntigravityLsofOutput(noPresence, "antigravity").openConversations).toEqual([
      "ba32c38a-052c-4291-86dd-373a68ea85a3",
      "967a065b-8d82-494f-a11f-dc7acb86251c",
    ]);
  });

  test("saveSessionBind enforces 1:1 agent_id <-> sessionId across profile.json and named alias files", () => {
    const cfgDir = mkdtempSync(join(tmpdir(), "ac-alias-binds-"));
    writeFileSync(join(cfgDir, "profile.json"), JSON.stringify({ agent_id: "same-agent-1", token: "ac_1" }));
    writeFileSync(join(cfgDir, "Antigravity.json"), JSON.stringify({ agent_id: "same-agent-1", token: "ac_1" }));

    saveSessionBind(cfgDir, "cid-old", "profile");
    saveSessionBind(cfgDir, "cid-new", "Antigravity");

    const binds = loadSessionBinds(cfgDir);
    expect(binds).toEqual({ "cid-new": "Antigravity" });
  });

  test("Antigravity alias profile (profile.json + Antigravity.json sharing agent_id) opens only 1 WS and never leaks wakes to unbound sibling session", async () => {
    const home = mkdtempSync(join(tmpdir(), "ac-agy-leak-reg-"));
    const cfgDir = join(home, ".agentschat");
    const brainDir = mkdtempSync(join(tmpdir(), "ac-agy-leak-brain-"));
    mkdirSync(cfgDir, { recursive: true });

    const cidBound = "ba32c38a-052c-4291-86dd-373a68ea85a3";
    const cidUnbound = "967a065b-8d82-494f-a11f-dc7acb86251c";
    mkdirSync(join(brainDir, cidBound, ".system_generated", "logs"), { recursive: true });
    mkdirSync(join(brainDir, cidUnbound, ".system_generated", "logs"), { recursive: true });

    // Exact real-world layout produced by first-time registration:
    // both `profile.json` and `Antigravity.json` carry the same `agent_id`,
    // while `session-binds.json` maps `cidBound -> "Antigravity"`.
    const sharedIdentity = {
      agent_id: "spinning-test-tunicate",
      display_name: "Antigravity",
      token: "ac_shared_tunicate",
      capabilities: ["coding", "chat"],
    };
    writeFileSync(join(cfgDir, "profile.json"), JSON.stringify(sharedIdentity));
    writeFileSync(join(cfgDir, "Antigravity.json"), JSON.stringify(sharedIdentity));
    writeFileSync(join(cfgDir, "session-binds.json"), JSON.stringify({ [cidBound]: "Antigravity" }));

    const wokenRecipients: string[] = [];
    const mockLs = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/exa.language_server_pb.LanguageServerService/SendAgentMessage") {
          const body = (await req.json()) as any;
          if (typeof body?.recipient === "string") wokenRecipients.push(body.recipient);
          return Response.json({ ok: true });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const liveSockets = new Set<any>();
    let totalAuthCount = 0;
    const wsHub = Bun.serve<{ agentId?: string }>({
      port: 0,
      fetch(req, server) {
        const u = new URL(req.url);
        if (u.pathname === "/ws" && server.upgrade(req, { data: {} })) {
          return undefined;
        }
        return Response.json({ ok: true, build: "test", messages: [] });
      },
      websocket: {
        message(ws, message) {
          try {
            const data = JSON.parse(String(message));
            if (data.type === "auth" && typeof data.agent_id === "string") {
              totalAuthCount += 1;
              ws.data.agentId = data.agent_id;
              liveSockets.add(ws);
              ws.send(JSON.stringify({ type: "auth_ok", session_id: `ws-sess-${totalAuthCount}` }));
              // Trigger pong right away to exercise syncOpenBoundSessions()!
              ws.send(JSON.stringify({ type: "pong" }));
            } else if (data.type === "ping") {
              ws.send(JSON.stringify({ type: "pong" }));
            }
          } catch {}
        },
        close(ws) {
          liveSockets.delete(ws);
        },
      },
    });

    const mcp = spawnMcpSession(home, [], {
      AGENTCHAT_REST_URL: `http://127.0.0.1:${wsHub.port}`,
      AGENTCHAT_URL: `ws://127.0.0.1:${wsHub.port}/ws`,
      AGENTSCHAT_AGY_BRAIN_DIR: brainDir,
      ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${mockLs.port}`,
      ANTIGRAVITY_CSRF_TOKEN: "csrf-leak-test",
      ANTIGRAVITY_OPEN_CONVERSATIONS: `${cidBound},${cidUnbound}`,
    });

    try {
      await mcp.send(INIT);
      await mcp.send(INITED);

      for (let i = 0; i < 30 && liveSockets.size === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      // Give syncOpenBoundSessions() after pong plenty of time to run
      await new Promise((r) => setTimeout(r, 120));

      // 1. Must ONLY open ONE WebSocket slot for `spinning-test-tunicate`, NEVER two!
      expect(liveSockets.size).toBe(1);
      expect(totalAuthCount).toBe(1);

      // 2. Unbound sibling conversation `cidUnbound` calling `whoami` must stay anonymous
      //    and must NOT hijack the identity via the `profile.json` alias!
      writeFileSync(
        join(brainDir, cidUnbound, ".system_generated", "logs", "transcript.jsonl"),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          tool_calls: [{ name: "call_mcp_tool", args: { ToolName: '"whoami"', Arguments: "{}" } }],
        }) + "\n",
      );
      const unboundWho = await mcp.send(callTool(30, "whoami"));
      expect(unboundWho.result.content[0].text).toContain("(none — anonymous, no profile written)");
      expect(loadSessionBinds(cfgDir)).toEqual({ [cidBound]: "Antigravity" });

      // 3. Push an inbound DM across all live sockets -> must wake ONLY `cidBound`, NEVER `cidUnbound`!
      for (const sock of liveSockets) {
        sock.send(
          JSON.stringify({
            type: "message",
            id: "msg-no-leak-1",
            channel_id: "dm-boss",
            sender_id: "boss-user",
            content: "hello bound session only",
            timestamp: new Date().toISOString(),
          }),
        );
      }

      for (let i = 0; i < 30 && wokenRecipients.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 80));

      expect(wokenRecipients).toEqual([cidBound]);
    } finally {
      await mcp.close();
      wsHub.stop(true);
      mockLs.stop(true);
    }
  });

  test("Unbound agent with >1 open Antigravity conversations never guesses or leaks wakes into an unbound window", async () => {
    const home = mkdtempSync(join(tmpdir(), "ac-agy-ambig-"));
    const cfgDir = join(home, ".agentschat");
    mkdirSync(cfgDir, { recursive: true });

    const cid1 = "11111111-1111-4111-8111-111111111111";
    const cid2 = "22222222-2222-4222-8222-222222222222";
    writeFileSync(
      join(cfgDir, "profile.json"),
      JSON.stringify({
        agent_id: "unbound-boot-bot",
        display_name: "UnboundBootBot",
        token: "ac_unbound_tok",
        capabilities: ["coding"],
      }),
    );

    const wokenRecipients: string[] = [];
    const mockLs = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json().catch(() => ({}))) as any;
        if (typeof body?.recipient === "string") wokenRecipients.push(body.recipient);
        return Response.json({ ok: true });
      },
    });

    const liveSockets = new Set<any>();
    const wsHub = Bun.serve<Record<string, unknown>>({
      port: 0,
      fetch(req, server) {
        const u = new URL(req.url);
        if (u.pathname === "/ws" && server.upgrade(req, { data: {} })) return undefined;
        return Response.json({ ok: true, messages: [] });
      },
      websocket: {
        message(ws, message) {
          const data = JSON.parse(String(message));
          if (data.type === "auth") {
            liveSockets.add(ws);
            ws.send(JSON.stringify({ type: "auth_ok", session_id: "ws-ambig-1" }));
          }
        },
        close(ws) {
          liveSockets.delete(ws);
        },
      },
    });

    const mcp = spawnMcpSession(home, [], {
      AGENTCHAT_REST_URL: `http://127.0.0.1:${wsHub.port}`,
      AGENTCHAT_URL: `ws://127.0.0.1:${wsHub.port}/ws`,
      ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${mockLs.port}`,
      ANTIGRAVITY_CSRF_TOKEN: "csrf-ambig-test",
      ANTIGRAVITY_OPEN_CONVERSATIONS: `${cid1},${cid2}`,
    });

    try {
      await mcp.send(INIT);
      await mcp.send(INITED);
      for (let i = 0; i < 30 && liveSockets.size === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      for (const sock of liveSockets) {
        sock.send(
          JSON.stringify({
            type: "message",
            id: "msg-ambig-1",
            channel_id: "dm-boss",
            sender_id: "boss-user",
            content: "do not guess which window",
            timestamp: new Date().toISOString(),
          }),
        );
      }
      await new Promise((r) => setTimeout(r, 150));
      expect(wokenRecipients).toEqual([]);
    } finally {
      await mcp.close();
      wsHub.stop(true);
      mockLs.stop(true);
    }
  });

  test("profile.json is disallowed from colliding with any named profile, and named registration never writes profile.json", async () => {
    const home = mkdtempSync(join(tmpdir(), "ac-no-dup-default-"));
    const cfgDir = join(home, ".agentschat");
    mkdirSync(cfgDir, { recursive: true });

    // 1. Unit check: findDefaultProfileCollision catches both agent_id and display_name collisions
    const defPath = join(cfgDir, "profile.json");
    writeFileSync(
      join(cfgDir, "Antigravity.json"),
      JSON.stringify({ agent_id: "agy-id-1", display_name: "Antigravity", token: "ac_agy_1" }),
    );
    writeFileSync(
      defPath,
      JSON.stringify({ agent_id: "agy-id-1", display_name: "Other", token: "ac_def_1" }),
    );
    expect(findDefaultProfileCollision(cfgDir, defPath)?.collidingName).toBe("Antigravity");
    expect(findDefaultProfileCollision(cfgDir, defPath)?.reason).toBe("agent_id");

    writeFileSync(
      defPath,
      JSON.stringify({ agent_id: "distinct-id", display_name: "antigravity", token: "ac_def_2" }),
    );
    expect(findDefaultProfileCollision(cfgDir, defPath)?.collidingName).toBe("Antigravity");
    expect(findDefaultProfileCollision(cfgDir, defPath)?.reason).toBe("display_name");

    // 2. E2E check: default startup refuses to load colliding profile.json (starts anonymous),
    //    explicit connect_profile("profile") is rejected, and register_name never creates profile.json.
    const mcp = spawnMcpSession(home, [], { CLAUDE_CODE_SESSION_ID: "sess-no-dup" });
    try {
      await mcp.send(INIT);
      await mcp.send(INITED);

      const who = await mcp.send(callTool(40, "whoami"));
      expect(who.result.content[0].text).toContain("(none — anonymous, no profile written)");

      const tryDupDefault = await mcp.send(callTool(41, "connect_profile", { profile_name: "profile" }));
      expect(tryDupDefault.result.isError).toBe(true);
      expect(tryDupDefault.result.content[0].text).toContain('collides (display_name) with named profile "Antigravity"');

      // Delete colliding profile.json, then register a fresh named profile -> must NOT recreate profile.json!
      const { unlinkSync } = await import("node:fs");
      unlinkSync(defPath);

      const tryReserved = await mcp.send(callTool(42, "connect_profile", { register_name: "profile" }));
      expect(tryReserved.result.isError).toBe(true);
      expect(tryReserved.result.content[0].text).toContain("reserved");

      const tryExisting = await mcp.send(callTool(43, "connect_profile", { register_name: "Antigravity" }));
      expect(tryExisting.result.isError).toBe(true);
      expect(tryExisting.result.content[0].text).toContain("already exists");

      const regFresh = await mcp.send(callTool(44, "connect_profile", { register_name: "FreshNamedBot" }));
      expect(regFresh.result.isError).toBeUndefined();
      expect(existsSync(join(cfgDir, "FreshNamedBot.json"))).toBe(true);
      expect(existsSync(defPath)).toBe(false);
    } finally {
      await mcp.close();
    }
  });

  test("Windows Antigravity & Codex probes parse quoted --csrf_token, locked presence UUIDs, localized netstat -ano ports, and codex.exe", async () => {
    const { externalCodexPresent, parseProcesses } = await import("../codex/processes.ts");
    const cidActive = "ba32c38a-052c-4291-86dd-373a68ea85a3";
    const cidDb = "11111111-2222-4333-8444-555555555555";

    const probeJson = JSON.stringify({
      lsPid: 18420,
      lsCmd: `"C:\\Users\\Boss\\AppData\\Local\\Programs\\Antigravity\\resources\\app\\extensions\\antigravity\\bin\\language_server_windows_x64.exe" --csrf_token "win-csrf-9988" --app_data_dir "antigravity"`,
      ports: [51234, 51235],
      lockedPresence: cidActive, // PowerShell ConvertTo-Json emits scalar string for single-element arrays sometimes
      lockedDbs: [cidDb],
    });
    const parsed = parseWindowsAntigravityProbeJson(probeJson);
    expect(parsed).toEqual({
      lsPid: 18420,
      csrfToken: "win-csrf-9988",
      ports: [51235, 51234], // sorted descending so HTTP Connect-RPC port is tried before HTTPS
      openConversations: [cidActive], // active presence lock preferred over cached SQLite db
    });

    // Fallback to localized Windows netstat -ano (e.g., German ABHÖREN / Chinese / English LISTENING) when Get-NetTCPConnection is unavailable
    const netstatOut = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    127.0.0.1:60110        0.0.0.0:0              ABHÖREN         18420",
      "  TCP    [::1]:60112            [::]:0                 LISTENING       18420",
      "  TCP    127.0.0.1:60115        127.0.0.1:51234        ESTABLISHED     18420",
      "  TCP    127.0.0.1:60999        0.0.0.0:0              LISTENING       9999",
    ].join("\r\n");
    expect(parseWindowsNetstatOutput(netstatOut, 18420)).toEqual([60112, 60110]);

    const fallbackParsed = parseWindowsAntigravityProbeJson(
      JSON.stringify({
        lsPid: 18420,
        lsCmd: `language_server_windows_x64.exe --csrf_token=tok_fallback`,
        ports: [],
        lockedPresence: [],
        lockedDbs: [cidDb],
      }),
      netstatOut,
    );
    expect(fallbackParsed).toEqual({
      lsPid: 18420,
      csrfToken: "tok_fallback",
      ports: [60112, 60110],
      openConversations: [cidDb],
    });

    // Windows codex.exe process table (CRLF + .exe suffix)
    const winPsRows = parseProcesses(
      "  4000 1000 powershell.exe\r\n  5000 4000 node.exe\r\n  6000 5000 codex.exe\r\n  7000 1200 C:\\Users\\Boss\\AppData\\Roaming\\npm\\codex.exe\r\n",
    );
    expect(externalCodexPresent(winPsRows, 5000)).toBe(true);
    expect(externalCodexPresent(winPsRows.slice(0, 3), 5000)).toBe(false);
  });

  test("removeSessionBind ignores Object.prototype keys and checkAgentLock cleans stale 0-byte locks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-sb-proto-"));
    saveSessionBind(dir, "conv-123", "Antigravity");
    // "toString" and "constructor" must not match Object.prototype or rewrite session-binds.json
    expect(removeSessionBind(dir, "toString")).toBe(false);
    expect(removeSessionBind(dir, "constructor")).toBe(false);
    expect(Object.keys(loadSessionBinds(dir))).toEqual(["conv-123"]);

    // Stale (>1s) 0-byte corrupt lock file is cleaned up automatically by checkAgentLock
    const lockDir = resolveLockDir(dir);
    mkdirSync(lockDir, { recursive: true });
    const lockFile = join(lockDir, "agent-corrupt.lock");
    writeFileSync(lockFile, "");
    const past = new Date(Date.now() - 5000);
    utimesSync(lockFile, past, past);
    expect(checkAgentLock({ lockDir, agentId: "agent-corrupt", currentPid: process.pid })).toEqual({ locked: false });
    expect(existsSync(lockFile)).toBe(false);

    // detectDshCallerSession cancels non-OK response bodies cleanly
    let bodyCancelled = false;
    const sid = await detectDshCallerSession({
      dshHome: dir,
      healthUrl: "http://127.0.0.1:9999/health",
      fetchImpl: (async () => ({
        ok: false,
        status: 503,
        body: {
          cancel: async () => {
            bodyCancelled = true;
          },
        } as unknown as ReadableStream<Uint8Array>,
        json: async () => ({}),
      }) as Response) as unknown as typeof fetch,
    });
    expect(sid).toBeNull();
    expect(bodyCancelled).toBe(true);
  });
});
