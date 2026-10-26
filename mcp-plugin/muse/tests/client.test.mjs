import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { MuseAgentChatClient } from "../src/client.ts";

/**
 * Minimal dependency-free WebSocket server: just enough of RFC 6455 to
 * prove the client handshake (auth -> auth_ok), join, message send/receive
 * and reconnect. Client frames are masked; server frames are not.
 */
class MockServer {
  constructor() {
    this.received = [];
    this.connections = 0;
    this.sockets = [];
    this.onMessage = null;
    this.server = createServer();
    this.server.on("upgrade", (req, socket) => {
      const key = req.headers["sec-websocket-key"];
      const accept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      this.connections += 1;
      this.sockets.push(socket);
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) break;
          const opcode = buf[0] & 0x0f;
          const masked = buf[1] & 0x80;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) break;
            len = buf.readUInt16BE(2);
            off = 4;
          } else if (len === 127) {
            if (buf.length < 10) break;
            len = Number(buf.readBigUInt64BE(2));
            off = 10;
          }
          const maskLen = masked ? 4 : 0;
          if (buf.length < off + maskLen + len) break;
          const mask = buf.subarray(off, off + maskLen);
          const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
          if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
          buf = buf.subarray(off + maskLen + len);
          if (opcode === 8) {
            socket.end();
            return;
          }
          if (opcode === 1) {
            const parsed = JSON.parse(payload.toString());
            this.received.push(parsed);
            this.onMessage?.(parsed, socket);
          }
        }
      });
    });
  }

  send(socket, obj) {
    const payload = Buffer.from(JSON.stringify(obj));
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, payload.length]);
    } else {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    }
    socket.write(Buffer.concat([header, payload]));
  }

  async listen() {
    await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
    return this.server.address().port;
  }

  async close() {
    for (const s of this.sockets) s.destroy();
    await new Promise((r) => this.server.close(r));
  }
}

function waitFor(pred, label, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("client auth, join, send and receive work end to end", async () => {
  const server = new MockServer();
  const port = await server.listen();
  const inbound = [];
  server.onMessage = (msg, socket) => {
    if (msg.type === "auth") server.send(socket, { type: "auth_ok", agent_id: msg.agent_id, session_id: "sess-1" });
  };
  const client = new MuseAgentChatClient({
    url: `ws://127.0.0.1:${port}`,
    agentId: "muse-bot",
    token: "secret-token",
    heartbeatIntervalMs: 60_000,
    reconnect: false,
  });
  client.onMessage((m) => inbound.push(m));
  try {
    await client.connect();
    assert.equal(client.isConnected, true);
    assert.equal(client.session, "sess-1");
    await waitFor(() => server.received.some((m) => m.type === "auth"), "auth");
    const auth = server.received.find((m) => m.type === "auth");
    assert.equal(auth.agent_id, "muse-bot");
    assert.equal(auth.token, "secret-token");

    client.joinChannel("general");
    await waitFor(() => server.received.some((m) => m.type === "join_channel"), "join");
    // Server echoes a message back into the channel.
    server.send(server.sockets[0], {
      type: "message",
      id: "m1",
      channel_id: "general",
      sender_id: "alice",
      sender_type: "agent",
      content: "hello @muse-bot",
      content_type: "text",
      timestamp: new Date().toISOString(),
    });
    await waitFor(() => inbound.length > 0, "inbound message");
    assert.equal(inbound[0].content, "hello @muse-bot");

    client.sendMessage("general", "pong");
    await waitFor(() => server.received.some((m) => m.type === "message" && m.content === "pong"), "sent message");
  } finally {
    client.disconnect();
    await server.close();
  }
});

test("client reconnects after a transient drop and re-authenticates", async () => {
  const server = new MockServer();
  const port = await server.listen();
  server.onMessage = (msg, socket) => {
    if (msg.type === "auth") server.send(socket, { type: "auth_ok", agent_id: msg.agent_id, session_id: `sess-${server.connections}` });
  };
  const client = new MuseAgentChatClient({
    url: `ws://127.0.0.1:${port}`,
    agentId: "muse-bot",
    token: "t",
    heartbeatIntervalMs: 60_000,
    initialReconnectDelayMs: 50,
    maxReconnectDelayMs: 200,
  });
  try {
    await client.connect();
    assert.equal(server.connections, 1);
    // Kill the socket from the server side; client must come back on its own.
    server.sockets[0].destroy();
    await waitFor(() => server.connections >= 2, "reconnect", 5000);
    await waitFor(() => client.isConnected, "re-authenticated", 5000);
  } finally {
    client.disconnect();
    await server.close();
  }
});
