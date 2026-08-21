/**
 * Pins the relay wire framing: every frame the connector sends MUST end with a
 * newline, because the gateway's transport (gateway/relay/ws_transport.py) is
 * newline-delimited — its read loop splits the stream on "\n" and only dispatches
 * complete lines to _handle_frame. A frame without the terminator never reaches
 * the gateway's handshake handler: it sits in the reader's buffer forever.
 *
 * This was a real bug: the connector sent JSON without "\n", and the real
 * ws_transport.py stalled at handshake (descriptor received at the WS layer but
 * never split into a frame). Caught only by running the genuine upstream
 * transport, not by the TS-side tests (whose WS client parses each message as a
 * complete frame regardless of a trailing newline).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import WebSocket from "ws";
import { makeUpgradeToken } from "../../connector/auth.ts";
import { startConnector, type ConnectorConfig } from "../../connector/server.ts";

const SECRET = "frame-secret-0123456789abcdef";
const GWID = "gw-framing";

let server: ReturnType<typeof startConnector>;
let url = "";

beforeAll(() => {
  server = startConnector({
    port: 0,
    secrets: { [GWID]: [SECRET] },
    agentschat: {
      async sendMessage() { return { id: "m1" }; },
      async getChatInfo() { return { name: "#x", type: "group" }; },
    },
  });
  url = `ws://127.0.0.1:${server.port}/relay`;
});
afterAll(() => server.stop());

/** Collect RAW WS messages (not parsed) so we can assert on framing. */
function collectRaw(ws: WebSocket, n: number, ms = 3000): Promise<string[]> {
  return new Promise((resolve) => {
    const out: string[] = [];
    const timer = setTimeout(() => resolve(out), ms);
    ws.on("message", (d) => {
      out.push(d.toString());
      if (out.length >= n) { clearTimeout(timer); resolve(out); }
    });
  });
}

describe("wire framing is newline-delimited (matches gateway ws_transport)", () => {
  test("the descriptor frame ends with a newline", async () => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${makeUpgradeToken(GWID, SECRET, 0)}` } });
    await new Promise((r) => ws.on("open", r));
    const raw = collectRaw(ws, 1);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "ac-bot" }) + "\n");
    const frames = await raw;
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0].endsWith("\n")).toBe(true);
    // And it's exactly one frame per message (newline is a terminator, not embedded).
    expect(frames[0].trim().startsWith("{")).toBe(true);
    ws.close();
  });

  test("every outbound_result frame also ends with a newline", async () => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${makeUpgradeToken(GWID, SECRET, 0)}` } });
    await new Promise((r) => ws.on("open", r));
    const raw = collectRaw(ws, 2); // descriptor + outbound_result
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "ac-bot" }) + "\n");
    ws.send(JSON.stringify({ type: "outbound", requestId: "r1", action: { op: "send", chat_id: "welcome", content: "x" } }) + "\n");
    const frames = await raw;
    expect(frames.length).toBe(2);
    for (const f of frames) expect(f.endsWith("\n")).toBe(true);
    ws.close();
  });

  test("a strict newline-delimited reader CAN split our frames (the actual failure mode)", async () => {
    // Simulate the gateway's read loop: accumulate bytes, split on "\n".
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${makeUpgradeToken(GWID, SECRET, 0)}` } });
    await new Promise((r) => ws.on("open", r));
    let buf = "";
    const parsed: any[] = [];
    const done = new Promise<void>((resolve) => {
      ws.on("message", (d) => {
        buf += d.toString();
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const line of parts) {
          if (line.trim()) parsed.push(JSON.parse(line));
          if (parsed.length >= 1) resolve();
        }
      });
    });
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "ac-bot" }) + "\n");
    await done;
    // Without the trailing newline this would be 0 — the descriptor would sit in buf.
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0].type).toBe("descriptor");
    ws.close();
  });
});
