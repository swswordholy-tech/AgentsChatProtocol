import { expect, test } from "bun:test";
import { AgentChatClient } from "../src/client";
import { AgentChatREST } from "../src/rest";

class Socket {
  readyState = WebSocket.OPEN;
  closed = false;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = WebSocket.CLOSED; }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

function setup(extra = {}) {
  const sockets: Socket[] = [];
  const client = new AgentChatClient({
    url: "wss://localhost/ws", agentId: "bot", token: "private.token+value",
    heartbeatInterval: 10, heartbeatTimeoutMs: 25,
    wsFactory: () => {
      const socket = new Socket();
      sockets.push(socket);
      queueMicrotask(() => {
        socket.onopen?.();
        socket.emit({ type: "auth_ok", session_id: "s" });
      });
      return socket as unknown as WebSocket;
    }, ...extra,
  });
  return { client, sockets };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([promise, Bun.sleep(250).then(() => { throw new Error("operation hung"); })]);
}

test("typing sentinel is filtered without changing ordinary message content", async () => {
  const { client, sockets } = setup();
  const seen: string[] = [];
  client.onMessage(m => seen.push(m.content));
  await client.connect();
  sockets[0].emit({ type: "message", content: "__typing__" });
  sockets[0].emit({ type: "message", content: "__typing__ ordinary text" });
  client.disconnect();
  expect(seen).toEqual(["__typing__ ordinary text"]);
});

test("missing pong closes half-open connection once and stops heartbeat", async () => {
  const { client, sockets } = setup();
  const errors: number[] = [];
  client.onError(code => errors.push(code));
  await client.connect();
  await Bun.sleep(100);
  expect(client.isConnected).toBe(false);
  expect(sockets[0].closed).toBe(true);
  expect(errors).toEqual([408]);
  const count = sockets[0].sent.length;
  await Bun.sleep(30);
  expect(sockets[0].sent.length).toBe(count);
  client.disconnect();
});

test("pong acknowledgments keep connection alive and send failure closes it", async () => {
  const { client, sockets } = setup();
  await client.connect();
  const timer = setInterval(() => sockets[0].emit({ type: "pong" }), 5);
  try {
    await Bun.sleep(90);
    expect(client.isConnected).toBe(true);
    sockets[0].send = () => { throw new Error("transport failure"); };
    await Bun.sleep(25);
    expect(sockets[0].closed).toBe(true);
    expect(client.isConnected).toBe(false);
  } finally {
    clearInterval(timer);
    client.disconnect();
  }
});

test("auth_error cleanup precedes user callback that reconnects", async () => {
  const { client, sockets } = setup();
  const seen: string[] = [];
  let next: Promise<void> | undefined;
  client.onError((_code, message) => { seen.push(message); next = client.connect(); });
  await client.connect();
  sockets[0].emit({ type: "auth_error", message: "private.token+value ac_other_key Bearer secret-value" });
  await next;
  expect(sockets[0].closed).toBe(true);
  expect(sockets[1].closed).toBe(false);
  expect(client.isConnected).toBe(true);
  expect(seen.join()).not.toContain("private.token+value");
  expect(seen.join()).not.toContain("ac_other_key");
  expect(seen.join()).not.toContain("secret-value");
  client.disconnect();
});

test("nonfinite and nonpositive WS timing options are rejected", () => {
  for (const field of ["heartbeatInterval", "heartbeatTimeoutMs", "connectTimeoutMs"]) {
    for (const value of [0, -1, NaN, Infinity]) {
      expect(() => setup({ [field]: value })).toThrow(field);
    }
  }
});

test("REST and SSE errors scrub configured override and other credentials", async () => {
  const rest = new AgentChatREST({ baseUrl: "http://localhost", bearerToken: "private.token+value",
    fetchImpl: (async () => Response.json({ message: "private.token+value ac_other_key Bearer secret-value" }, { status: 403 })) as typeof fetch });
  for (const request of [() => rest.health(), () => rest.iterateChannelEvents("room").next()]) {
    try { await request(); throw new Error("expected rejection"); } catch (error) {
      expect(String(error)).toContain("HTTP 403");
      for (const key of ["private.token+value", "ac_other_key", "secret-value"]) expect(String(error)).not.toContain(key);
    }
  }
  const override = new AgentChatREST({ baseUrl: "http://localhost",
    fetchImpl: (async () => Response.json({ message: "override+token" }, { status: 403 })) as typeof fetch });
  await expect(override.iterateChannelEvents("room", { bearerToken: "override+token" }).next()).rejects.toThrow("[REDACTED]");
});

test("SSE abort and early return complete even if underlying cancellation never settles", async () => {
  for (const abort of [true, false]) {
    let cancellations = 0;
    const signal = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { if (!abort) controller.enqueue(new TextEncoder().encode('data: {"type":"message"}\n\n')); },
      cancel() { cancellations++; return new Promise<void>(() => {}); },
    });
    const rest = new AgentChatREST({ baseUrl: "http://localhost", fetchImpl: (async () => new Response(stream)) as typeof fetch });
    const events = rest.iterateChannelEvents("room", { signal: signal.signal });
    const first = events.next();
    if (abort) {
      await Bun.sleep(5);
      signal.abort();
      expect((await within(first)).done).toBe(true);
    } else {
      expect((await first).value).toEqual({ type: "message" });
      expect((await within(events.return())).done).toBe(true);
    }
    expect(cancellations).toBe(1);
    expect(stream.locked).toBe(false);
  }
});

test("failed SSE handshake error body remains inside HTTP deadline", async () => {
  let cancelled = false;
  const rest = new AgentChatREST({ baseUrl: "http://localhost", timeoutMs: 20,
    fetchImpl: (async (_url, init) => {
      const stream = new ReadableStream({ start(controller) {
        init?.signal?.addEventListener("abort", () => { cancelled = true; controller.error(init.signal?.reason); });
      } });
      return new Response(stream, { status: 503 });
    }) as typeof fetch });
  await expect(within(rest.iterateChannelEvents("room").next())).rejects.toThrow("timed out after 20ms");
  expect(cancelled).toBe(true);
});
