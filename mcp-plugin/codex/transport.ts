import WebSocket from "ws";
import type { BridgeConfig } from "./config.ts";
import { HeartbeatMonitor } from "../src/heartbeat.ts";

export class AgentsChatTransport {
  private socket?: WebSocket;
  private heartbeat?: HeartbeatMonitor;
  private retry?: ReturnType<typeof setTimeout>;
  private closed = false;
  private delay = 1000;
  constructor(private config: BridgeConfig, private receive: (m: unknown) => void, private log: (s: string) => void = console.error) {}
  async api(path: string, body?: unknown) {
    let response: Response;
    try {
      response = await fetch(this.config.apiUrl + path, { method: body ? "POST" : "GET", redirect: "error",
        headers: { Authorization: `Bearer ${this.config.token}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
    } catch { throw new Error("AgentsChat request failed or timed out"); }
    if (!response.ok) throw new Error(`AgentsChat HTTP ${response.status}`);
    try { return await response.json(); } catch { throw new Error("Invalid AgentsChat response"); }
  }
  async send(channel: string, text: string) {
    await this.api(`/api/channels/${encodeURIComponent(channel)}/messages`, {
      sender_id: this.config.agentId, content_type: "text", content: text,
    });
  }
  start() {
    if (this.closed) return;
    const socket = new WebSocket(this.config.wsUrl, { maxPayload: 1_048_576, handshakeTimeout: 15_000 });
    this.socket = socket;
    const current = () => !this.closed && this.socket === socket;
    const send = (value: unknown) => { if (current() && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
    const join = (channel: string) => {
      if (!this.config.channels.length || this.config.channels.includes(channel)) send({ type: "join_channel", channel_id: channel, agent_id: this.config.agentId });
    };
    this.heartbeat = new HeartbeatMonitor({ getReadyState: () => socket.readyState,
      sendPing: () => send({ type: "ping" }), reconnect: () => socket.terminate() }, 15_000, 45_000, 30_000);
    this.heartbeat.start();
    socket.on("open", () => send({ type: "auth", agent_id: this.config.agentId, token: this.config.token, capabilities: ["chat", "codex"] }));
    socket.on("message", raw => {
      if (!current()) return;
      let data: any; try { data = JSON.parse(String(raw)); } catch { return; }
      this.heartbeat?.receivedPong();
      if (data.type === "auth_ok") {
        this.delay = 1000; this.log(`AgentsChat connected as ${this.config.agentId}`);
        void this.api("/api/channels/mine").then((body: any) => {
          if (!current()) return;
          const channels = Array.isArray(body) ? body : body.channels;
          if (!Array.isArray(channels)) throw new Error("Invalid membership response");
          for (const c of channels) if (typeof (c.id ?? c.channel_id) === "string") join(c.id ?? c.channel_id);
        }).catch(() => { if (current()) { this.log("Membership sync failed; reconnecting"); socket.terminate(); } });
      } else if (data.type === "channel_created" && typeof data.channel_id === "string") join(data.channel_id);
      else if (["message", "thread_reply"].includes(data.type)) this.receive(data);
      else if (data.type === "shard_moved") socket.terminate();
      else if (data.type === "auth_error" || data.type === "error") this.log("AgentsChat returned an error; check account and channel permissions");
    });
    socket.on("error", () => this.log("AgentsChat socket error"));
    socket.on("close", () => {
      if (!current()) return;
      this.heartbeat?.stop(); this.log("AgentsChat disconnected; reconnecting (offline messages are not replayed)");
      this.retry = setTimeout(() => this.start(), this.delay); this.delay = Math.min(this.delay * 2, 30_000);
    });
  }
  stop() { this.closed = true; clearTimeout(this.retry); this.heartbeat?.stop(); this.socket?.terminate(); }
}
