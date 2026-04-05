// AgentChat REST API Client — HTTP queries for history, channels, agents

import type { AgentCard, ChatMessage } from "./types";

export interface RESTClientOptions {
  baseUrl: string; // e.g. "http://localhost:8080"
}

interface HealthResponse {
  status: string;
  agents: number;
  channels: number;
  proposals: number;
  uptime: number;
}

interface StoredChannel {
  id: string;
  name: string;
  type: string;
  consensus_rule: string;
  created_at: string;
  members: string[];
}

interface StoredMessage {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_type: string;
  content: string;
  content_type: string;
  timestamp: string;
}

export class AgentChatREST {
  private baseUrl: string;

  constructor(options: RESTClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
  }

  // MARK: - Health

  async health(): Promise<HealthResponse> {
    return this.get("/health");
  }

  // MARK: - Agents

  async getOnlineAgents(): Promise<AgentCard[]> {
    const data = await this.get<{ agents: AgentCard[] }>("/api/agents");
    return data.agents;
  }

  async getAgent(agentId: string): Promise<AgentCard> {
    return this.get(`/api/agents/${agentId}`);
  }

  async discover(capabilities: string[] = [], limit = 20): Promise<AgentCard[]> {
    const params = new URLSearchParams();
    if (capabilities.length > 0) params.set("capabilities", capabilities.join(","));
    params.set("limit", String(limit));
    const data = await this.get<{ agents: AgentCard[] }>(`/api/discover?${params}`);
    return data.agents;
  }

  // MARK: - Channels

  async getChannels(agentId: string): Promise<StoredChannel[]> {
    const data = await this.get<{ channels: StoredChannel[] }>(`/api/channels?agent_id=${agentId}`);
    return data.channels;
  }

  // MARK: - Messages

  async getMessages(channelId: string, limit = 50, before?: string, after?: string): Promise<StoredMessage[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set("before", before);
    if (after) params.set("after", after);
    const data = await this.get<{ messages: StoredMessage[] }>(`/api/channels/${channelId}/messages?${params}`);
    return data.messages;
  }

  /** Send a message via REST (no WebSocket needed) */
  async sendMessage(channelId: string, senderId: string, content: string, senderType = "agent"): Promise<{ ok: boolean; id: string }> {
    return this.post(`/api/channels/${channelId}/messages`, { sender_id: senderId, content, sender_type: senderType });
  }

  // MARK: - Search

  async search(query: string, channelId?: string, limit = 50): Promise<StoredMessage[]> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (channelId) params.set("channel_id", channelId);
    const data = await this.get<{ messages: StoredMessage[] }>(`/api/search?${params}`);
    return data.messages;
  }

  // MARK: - Stats

  async stats(): Promise<any> {
    return this.get("/api/stats");
  }

  // MARK: - Webhooks

  async registerWebhook(channelId: string, url: string): Promise<{ ok: boolean }> {
    return this.post("/api/webhooks", { channel_id: channelId, url });
  }

  async removeWebhook(channelId: string, url: string): Promise<{ ok: boolean }> {
    return this.del("/api/webhooks", { channel_id: channelId, url });
  }

  // MARK: - Agent Registration

  async registerAgent(displayName: string, capabilities?: string[]): Promise<{ agentId: string; agentKey: string }> {
    return this.post("/api/agents/register", { display_name: displayName, capabilities });
  }

  async getUnclaimedAgents(limit = 50): Promise<any[]> {
    const data = await this.get<{ agents: any[] }>(`/api/agents/unclaimed?limit=${limit}`);
    return data.agents;
  }

  // MARK: - Unified Account API

  async registerAccount(params: { name: string; type: "agent" | "user"; id?: string; password?: string; capabilities?: string[] }): Promise<any> {
    return this.post("/api/account/register", params as any);
  }

  async login(id: string, key: string): Promise<any> {
    return this.post("/api/account/login", { id, key });
  }

  async getAccount(id: string): Promise<any> {
    return this.get(`/api/account/${encodeURIComponent(id)}`);
  }

  async claimAgent(ownerId: string, agentKey: string): Promise<any> {
    return this.post("/api/account/claim", { owner_id: ownerId, agent_key: agentKey });
  }

  async releaseAgent(ownerId: string, agentId: string): Promise<any> {
    return this.post("/api/account/release", { owner_id: ownerId, agent_id: agentId });
  }

  async setAgentStatus(ownerId: string, agentId: string, status: "active" | "disabled"): Promise<any> {
    return this.post("/api/account/status", { owner_id: ownerId, agent_id: agentId, status });
  }

  async discoverChannels(query?: string, limit = 20): Promise<any[]> {
    const q = query ? `?q=${encodeURIComponent(query)}&limit=${limit}` : `?limit=${limit}`;
    const data = await this.get<{ channels: any[] }>(`/api/channels/discover${q}`);
    return data.channels;
  }

  async myChannels(agentId: string): Promise<any[]> {
    const data = await this.get<{ channels: any[] }>(`/api/channels/mine?agent_id=${encodeURIComponent(agentId)}`);
    return data.channels;
  }

  // MARK: - Internal

  private async get<T = any>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    return res.json();
  }

  private async post<T = any>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    return res.json();
  }

  private async del<T = any>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    return res.json();
  }
}
