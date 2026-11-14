/**
 * Wake-webhook — fire an outbound HTTP POST when an @mention/DM arrives, so hosts
 * WITHOUT an MCP channel-notification surface (Grok Bot, generic MCP clients) can
 * be woken by "a POST hit my URL" instead of needing to recognize a host-specific
 * notification method.
 *
 * The plugin already receives @/DM over its agentschat WebSocket and pushes an MCP
 * notification (server.ts). Claude Code acts on that notification; other hosts drop
 * it. This module adds a parallel, host-agnostic wake: POST the event to a URL the
 * operator configures. It is OUTBOUND (the plugin POSTs out), so no public inbound
 * URL is needed on the plugin side.
 *
 * Security: the agentschat token is NEVER put in the callback body. Auth to the
 * receiver is an HMAC-SHA256 signature over the raw body, keyed by
 * AGENTCHAT_WAKE_SECRET (header `x-agentschat-signature`), so the receiver can tell
 * a real wake from a forged POST. The channel-owning agent's ac_ key stays local.
 */
import { describe, expect, test } from "bun:test";
import { buildWakePayload, fireWake, fireZcodeWake, grokPortFromGatewayConfig, resolveEnvWakeId, resolveWindowsCliSpawn, sanitizeWakeLogUrl, signWakeBody, verifyWakeSignature, WAKE_ID_HEADER, WAKE_SIG_HEADER } from "../src/wake.ts";

const MSG = {
  type: "message",
  id: "m-123",
  channel_id: "welcome",
  sender_id: "human-9",
  content: "@grok-bot 看下这个",
  mentioned_ids: ["grok-bot"],
  timestamp: "2026-08-28T10:00:00.000Z",
};

describe("buildWakePayload — what the receiver needs, nothing more", () => {
  test("carries chat_id + message_id + a content excerpt so the receiver can skip a fetch round", () => {
    const p = buildWakePayload(MSG);
    expect(p.channel_id).toBe("welcome");
    expect(p.message_id).toBe("m-123");
    expect(p.sender_id).toBe("human-9");
    expect(p.content).toContain("@grok-bot");
    expect(p.mentioned_ids).toEqual(["grok-bot"]);
    expect(p.type).toBe("message");
    expect(p.timestamp).toBe("2026-08-28T10:00:00.000Z");
  });

  test("NEVER carries the agentschat token (the ac_ key stays local)", () => {
    const p = buildWakePayload({ ...MSG, token: "ac_secret", agent_key: "ac_secret" });
    const body = JSON.stringify(p);
    expect(body).not.toContain("ac_secret");
    expect(body).not.toContain("token");
    expect(body).not.toContain("agent_key");
  });

  test("a long message is excerpted, not sent whole", () => {
    const long = { ...MSG, content: "x".repeat(5000) };
    const p = buildWakePayload(long);
    expect(p.content).toBeDefined();
    expect(p.content!.length).toBeLessThanOrEqual(500);
  });

  test("missing fields degrade to undefined, not a crash", () => {
    const p = buildWakePayload({ type: "message" });
    expect(p.type).toBe("message");
    expect(p.channel_id).toBeUndefined();
  });

  test("a credential pasted INTO the message body is redacted, not relayed", () => {
    // Same rule as every other outbound path (reply/edit/caption/status all call
    // redactSecrets): if someone pastes an ac_ key or JWT into a message, the wake
    // body must not carry it to the receiver.
    const p = buildWakePayload({ ...MSG, content: "key: ac_abcdefghijklmnopqrstuvwxyz and jwt eyJabcdefghijklmnopqrstuv.abc.def" });
    expect(p.content).toContain("ac_***REDACTED***");
    expect(p.content).toContain("***JWT_REDACTED***");
    expect(p.content).not.toContain("ac_abcdefghij");
    expect(p.content).not.toContain("eyJabcdefghij");
  });
});

describe("signWakeBody / verifyWakeSignature — HMAC over the raw body", () => {
  test("sign produces a hex HMAC-SHA256 of the body", () => {
    const sig = signWakeBody('{"a":1}', "secret-1");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  test("verify accepts a valid signature, rejects a wrong secret", () => {
    const body = '{"type":"message","channel_id":"welcome"}';
    const sig = signWakeBody(body, "secret-1");
    expect(verifyWakeSignature(body, sig, ["secret-1"])).toBe(true);
    expect(verifyWakeSignature(body, sig, ["wrong"])).toBe(false);
  });

  test("rotation window: any secret in the list authenticates", () => {
    const body = "x";
    const sig = signWakeBody(body, "old");
    expect(verifyWakeSignature(body, sig, ["new", "old"])).toBe(true);
  });

  test("empty secret list never authenticates (control)", () => {
    const body = "x";
    const sig = signWakeBody(body, "s");
    expect(verifyWakeSignature(body, sig, [])).toBe(false);
  });

  test("tampered body fails (signature is over the exact bytes)", () => {
    const sig = signWakeBody('{"a":1}', "s");
    expect(verifyWakeSignature('{"a":2}', sig, ["s"])).toBe(false);
  });

  test("rejects malleable non-hex suffixes, prefixes, and wrong-length signatures", () => {
    const body = '{"a":1}';
    const sig = signWakeBody(body, "s");
    expect(verifyWakeSignature(body, `${sig}_extra`, ["s"])).toBe(false);
    expect(verifyWakeSignature(body, `sha256=${sig}`, ["s"])).toBe(false);
    expect(verifyWakeSignature(body, sig.slice(0, 62), ["s"])).toBe(false);
    expect(verifyWakeSignature(body, "", ["s"])).toBe(false);
  });

  test("grokPortFromGatewayConfig, sanitizeWakeLogUrl, fireWake body drain & fireZcodeWake stderr redaction", async () => {
    expect(grokPortFromGatewayConfig({ port: 1340 })).toBe(1340);
    expect(grokPortFromGatewayConfig({ port: Infinity })).toBe(1340);
    expect(grokPortFromGatewayConfig({ port: NaN })).toBe(1340);
    expect(grokPortFromGatewayConfig({ port: 0 })).toBe(1340);
    expect(grokPortFromGatewayConfig({ port: 70000 })).toBe(1340);
    expect(grokPortFromGatewayConfig({ port: 1340.5 })).toBe(1340);

    expect(sanitizeWakeLogUrl("https://user:pass@hook.example.com/wake?token=secret123#frag")).toBe(
      "https://hook.example.com/wake?[REDACTED]",
    );

    let canceled = 0;
    const wakeLogs: string[] = [];
    await fireWake(MSG, {
      url: "https://user:pass@hook.example.com/wake?secret=my_hook_token",
      fetchImpl: (async () => ({
        ok: false,
        status: 502,
        body: { cancel: async () => { canceled++; } },
      })) as any,
      logger: (m) => wakeLogs.push(m),
    });
    expect(canceled).toBe(1);
    expect(wakeLogs.join("\n")).not.toContain("my_hook_token");
    expect(wakeLogs.join("\n")).not.toContain("pass");

    const zLogs: string[] = [];
    await fireZcodeWake(MSG, {
      sessionId: "sess_redact_stderr",
      runCommandImpl: async () => ({ code: 1, stderr: "fatal auth error with ac_supersecrettoken123456" }),
      logger: (m) => zLogs.push(m),
    });
    expect(zLogs.join("\n")).not.toContain("ac_supersecrettoken123456");
    expect(zLogs.join("\n")).toContain("ac_***REDACTED***");
  });

  test("the signature header name is the contract", () => {
    expect(WAKE_SIG_HEADER).toBe("x-agentschat-signature");
  });
});

describe("buildWakePayload — session routing", () => {
  test("carries target_session_id when the bridge knows the bound session", () => {
    const payload = buildWakePayload(
      { id: "m1", channel_id: "dm-x", sender_id: "user" },
      { targetSessionId: "session-1" },
    );
    expect(payload.target_session_id).toBe("session-1");
  });

  test("omits target_session_id entirely when unbound (receivers keep their fallback)", () => {
    const payload = buildWakePayload({ id: "m1", channel_id: "dm-x", sender_id: "user" });
    expect("target_session_id" in payload).toBe(false);
  });

  test("an empty target is treated as unbound, not as an empty session id", () => {
    const payload = buildWakePayload({ id: "m1", channel_id: "dm-x" }, { targetSessionId: "" });
    expect("target_session_id" in payload).toBe(false);
  });
});

describe("resolveEnvWakeId — explicit stdio REST wake attribution", () => {
  test("forwards safe bounded AGENTSCHAT_WAKE_ID and preserves header name contract", () => {
    expect(WAKE_ID_HEADER).toBe("X-AgentsChat-Wake-Id");
    expect(resolveEnvWakeId({ AGENTSCHAT_WAKE_ID: "wake_msg_9f81-ab02" })).toBe("wake_msg_9f81-ab02");
  });

  test("rejects missing, malformed, overlong, or credential-shaped values fail-closed", () => {
    expect(resolveEnvWakeId({})).toBeUndefined();
    expect(resolveEnvWakeId({ AGENTSCHAT_WAKE_ID: "" })).toBeUndefined();
    expect(resolveEnvWakeId({ AGENTSCHAT_WAKE_ID: "bad header\r\ninject" })).toBeUndefined();
    expect(resolveEnvWakeId({ AGENTSCHAT_WAKE_ID: "a".repeat(129) })).toBeUndefined();
    expect(resolveEnvWakeId({ AGENTSCHAT_WAKE_ID: "ac_live_secret_token_value" })).toBeUndefined();
    expect(resolveEnvWakeId({ AGENTSCHAT_WAKE_ID: "sk-proj-secret" })).toBeUndefined();
  });

  test("fireZcodeWake escalates SIGTERM to SIGKILL when a child process ignores SIGTERM so session queue never deadlocks", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "zcode-sigkill-"));
    const script = join(dir, "stubborn-zcode.cjs");
    writeFileSync(
      script,
      `process.on("SIGTERM", () => {}); setInterval(() => {}, 60000);\n`,
      "utf8",
    );
    try {
      const t0 = Date.now();
      const ok = await fireZcodeWake(MSG, {
        sessionId: "sess_sigkill_test",
        zcodeBin: script,
        timeoutMs: 30,
        killGraceMs: 30,
        logger: () => {},
      });
      expect(ok).toBe(false);
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveWindowsCliSpawn — safe shell:false Windows .exe/.cmd resolution", () => {
  test("passes commands unchanged on non-win32 except explicit .js/.cjs/.mjs entrypoints", () => {
    expect(resolveWindowsCliSpawn("codex", ["app-server"], { platform: "darwin" })).toEqual({
      cmd: "codex",
      args: ["app-server"],
    });
    expect(
      resolveWindowsCliSpawn("/opt/zcode/zcode.cjs", ["-p", "hi"], {
        platform: "linux",
        execPath: "/usr/bin/node",
      }),
    ).toEqual({
      cmd: "/usr/bin/node",
      args: ["/opt/zcode/zcode.cjs", "-p", "hi"],
    });
  });

  test("unwraps npm .cmd shim to node.exe + resolved JS script with zero cmd.exe metacharacter exposure, and prefers .exe when present", () => {
    const npmDir = "C:\\Users\\Boss\\AppData\\Roaming\\npm";
    const codexCmd = `${npmDir}\\codex.cmd`;
    const codexJs = `${npmDir}\\node_modules\\@openai\\codex\\bin\\codex.js`;
    const zcodeExe = "C:\\Program Files\\ZCode\\zcode.exe";
    const files = new Map<string, string>([
      [
        codexCmd,
        `@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`,
      ],
      [codexJs, "// codex cli"],
      [zcodeExe, "MZ"],
    ]);
    const promptWithMetachars = `100% safe & calc.exe | "%APPDATA%" ^ !PATH!`;

    const resolvedCmd = resolveWindowsCliSpawn("codex", ["app-server", "--listen", "stdio://"], {
      platform: "win32",
      env: { Path: `C:\\Windows\\System32;${npmDir}` },
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      existsImpl: (p) => files.has(p),
      readTextImpl: (p) => files.get(p) || "",
    });
    expect(resolvedCmd).toEqual({
      cmd: "C:\\Program Files\\nodejs\\node.exe",
      args: [codexJs, "app-server", "--listen", "stdio://"],
    });

    const resolvedExe = resolveWindowsCliSpawn("zcode", ["-p", promptWithMetachars, "--resume", "sess_1"], {
      platform: "win32",
      env: { PATH: `C:\\Program Files\\ZCode;${npmDir}` },
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      existsImpl: (p) => files.has(p),
      readTextImpl: (p) => files.get(p) || "",
    });
    expect(resolvedExe).toEqual({
      cmd: zcodeExe,
      args: ["-p", promptWithMetachars, "--resume", "sess_1"],
    });
  });
});
