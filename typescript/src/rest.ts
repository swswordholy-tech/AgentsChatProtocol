// AgentsChat REST API client — HTTP queries for history, channels, agents

import type {
  AgentCard,
  ChatMessage,
  CloudAgentAuditFeed,
  CloudAgentAuditResult,
  DiscoverableChannelSummary,
} from "./types";

export interface RESTClientOptions {
  baseUrl: string; // e.g. "http://localhost:8080"
  bearerToken?: string;
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
  private bearerToken?: string;

  constructor(options: RESTClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.bearerToken = options.bearerToken?.trim() || undefined;
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

  async discoverChannels(query?: string, limit = 20): Promise<DiscoverableChannelSummary[]> {
    const q = query ? `?q=${encodeURIComponent(query)}&limit=${limit}` : `?limit=${limit}`;
    const data = await this.get<{ channels: DiscoverableChannelSummary[] }>(`/api/channels/discover${q}`);
    return data.channels;
  }

  async myChannels(agentId: string): Promise<any[]> {
    const data = await this.get<{ channels: any[] }>(`/api/channels/mine?agent_id=${encodeURIComponent(agentId)}`);
    return data.channels;
  }

  // MARK: - Owner-Scoped Cloud Agent Forensic Security Audit

  async getCloudAgentAuditLogs(
    agentId: string,
    opts?: { limit?: number; result?: CloudAgentAuditResult; bearerToken?: string },
  ): Promise<CloudAgentAuditFeed> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(agentId) || /^ac_/i.test(agentId)) {
      throw new Error("Invalid cloud agent ID");
    }
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) {
      if (!Number.isFinite(opts.limit)) throw new Error("Invalid audit limit");
      params.set("limit", String(Math.max(1, Math.min(50, Math.trunc(opts.limit)))));
    }
    if (opts?.result !== undefined) {
      if (!["ok", "denied", "error"].includes(opts.result)) throw new Error("Invalid audit result filter");
      params.set("result", opts.result);
    }
    const qs = params.toString();
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.get<CloudAgentAuditFeed>(
      `/api/cloud-agents/${encodeURIComponent(agentId)}/audit${qs ? `?${qs}` : ""}`,
      headers,
    );
  }

  // MARK: - Room-Scoped Cloud Agent Wake-Health Diagnostics

  async getChannelWakeHealth(
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ChannelWakeHealth> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(channelId) || /^ac_/i.test(channelId)) {
      throw new Error("Invalid channel ID");
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.get<import("./types").ChannelWakeHealth>(
      `/api/channels/${encodeURIComponent(channelId)}/wake-health`,
      headers,
    );
  }

  // MARK: - Room & Caller Autonomous Loop Schedules (/api/loops)

  async getChannelLoops(
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").RoomLoopsFeed> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(channelId) || /^ac_/i.test(channelId)) {
      throw new Error("Invalid channel ID");
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.get<import("./types").RoomLoopsFeed>(
      `/api/loops?channel_id=${encodeURIComponent(channelId)}`,
      headers,
    );
  }

  async getMyLoops(opts?: { bearerToken?: string }): Promise<import("./types").RoomLoopsFeed> {
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.get<import("./types").RoomLoopsFeed>("/api/loops/mine", headers);
  }

  // MARK: - Single-RTT Room Capability & Readiness Brief (/api/channels/:id/brief)

  async getChannelBrief(
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ChannelBrief> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(channelId) || /^(?:ac_|sk-)/i.test(channelId)) {
      throw new Error("Invalid channel ID");
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.get<import("./types").ChannelBrief>(
      `/api/channels/${encodeURIComponent(channelId)}/brief`,
      headers,
    );
  }

  // MARK: - Workspace Graph (/api/workspace/graph)

  async getWorkspaceGraph(
    scope: import("./types").WorkspaceGraphScopeType,
    id: string,
    opts?: { since?: string; bearerToken?: string },
  ): Promise<import("./types").WorkspaceGraph> {
    if (!["channel", "objective", "agent"].includes(scope)) {
      throw new Error("Invalid workspace graph scope");
    }
    const trimmedId = id.trim();
    if (
      !trimmedId ||
      trimmedId.length > 160 ||
      /[/\\?#&\s\u0000-\u001F]/.test(trimmedId) ||
      trimmedId.includes("..") ||
      /^(?:ac_|sk-)/i.test(trimmedId)
    ) {
      throw new Error("Invalid workspace graph ID");
    }
    const params = new URLSearchParams({ scope, id: trimmedId });
    if (opts?.since !== undefined) {
      const since = opts.since.trim();
      if (!since || Number.isNaN(Date.parse(since))) {
        throw new Error("Invalid workspace graph since timestamp");
      }
      params.set("since", since);
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.get<import("./types").WorkspaceGraph>(
      `/api/workspace/graph?${params.toString()}`,
      headers,
    );
  }

  // MARK: - Room Consensus Proposals (/api/channels/:id/proposals)

  async listChannelProposals(
    channelId: string,
    opts?: { limit?: number; bearerToken?: string },
  ): Promise<import("./types").ChannelProposalsFeed> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(channelId) || /^(?:ac_|sk-)/i.test(channelId)) {
      throw new Error("Invalid channel ID");
    }
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) {
      if (!Number.isFinite(opts.limit)) throw new Error("Invalid proposals limit");
      params.set("limit", String(Math.max(1, Math.min(100, Math.trunc(opts.limit)))));
    }
    const qs = params.toString();
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.get<import("./types").ChannelProposalsFeed>(
      `/api/channels/${encodeURIComponent(channelId)}/proposals${qs ? `?${qs}` : ""}`,
      headers,
    );
  }

  async createChannelProposal(
    channelId: string,
    input: import("./types").CreateChannelProposalInput,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").CreateChannelProposalResponse> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(channelId) || /^(?:ac_|sk-)/i.test(channelId)) {
      throw new Error("Invalid channel ID");
    }
    const title = input?.title?.trim() ?? "";
    if (!title || title.length > 500) {
      throw new Error("Invalid proposal title");
    }
    if (input.consensus_rule && !["majority", "super_majority", "unanimous"].includes(input.consensus_rule)) {
      throw new Error("Invalid consensus rule");
    }
    if (input.expires_at !== undefined && input.expires_at !== "" && Number.isNaN(Date.parse(input.expires_at))) {
      throw new Error("Invalid proposal expires_at timestamp");
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const body: Record<string, unknown> = {
      title,
      ...(input.id !== undefined ? { id: input.id } : {}),
      ...(input.sender_id !== undefined ? { sender_id: input.sender_id } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.code_diff !== undefined ? { code_diff: input.code_diff } : {}),
      ...(input.consensus_rule !== undefined ? { consensus_rule: input.consensus_rule } : {}),
      ...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {}),
    };
    return this.post<import("./types").CreateChannelProposalResponse>(
      `/api/channels/${encodeURIComponent(channelId)}/proposals`,
      body,
      headers,
    );
  }

  async voteChannelProposal(
    channelId: string,
    proposalId: string,
    input: import("./types").VoteChannelProposalInput,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").VoteChannelProposalResponse> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(channelId) || /^(?:ac_|sk-)/i.test(channelId)) {
      throw new Error("Invalid channel ID");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(proposalId) || /^(?:ac_|sk-)/i.test(proposalId)) {
      throw new Error("Invalid proposal ID");
    }
    if (!input || !["approve", "reject", "abstain"].includes(input.decision)) {
      throw new Error("Invalid vote decision");
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const body: Record<string, unknown> = {
      decision: input.decision,
      ...(input.voter_id !== undefined ? { voter_id: input.voter_id } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    };
    return this.post<import("./types").VoteChannelProposalResponse>(
      `/api/channels/${encodeURIComponent(channelId)}/proposals/${encodeURIComponent(proposalId)}/votes`,
      body,
      headers,
    );
  }

  async getChannelPins(
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ChannelPinsResponse> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(channelId) || /^(?:ac_|sk-)/i.test(channelId)) {
      throw new Error("Invalid channel ID");
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const raw = await this.get<{ channel_id?: unknown; pinned_messages?: unknown }>(
      `/api/channels/${encodeURIComponent(channelId)}/pins`,
      headers,
    );
    const seen = new Set<string>();
    const pinnedMessages: string[] = [];
    if (Array.isArray(raw?.pinned_messages)) {
      for (const item of raw.pinned_messages) {
        if (typeof item !== "string") continue;
        const trimmed = item.trim();
        if (!trimmed || /[\x00-\x1f\x7f]/.test(trimmed) || seen.has(trimmed)) continue;
        seen.add(trimmed);
        pinnedMessages.push(trimmed);
      }
    }
    return {
      channel_id: typeof raw?.channel_id === "string" && raw.channel_id.trim() ? raw.channel_id.trim() : channelId,
      pinned_messages: pinnedMessages,
    };
  }

  // MARK: - Internal

  private async get<T = any>(path: string, headers?: Record<string, string>): Promise<T> {
    const mergedHeaders: Record<string, string> = {
      ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}),
      ...(headers ?? {}),
    };
    const res = await fetch(
      `${this.baseUrl}${path}`,
      Object.keys(mergedHeaders).length > 0 ? { headers: mergedHeaders } : undefined,
    );
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    return res.json();
  }

  private async post<T = any>(
    path: string,
    body: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<T> {
    const mergedHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}),
      ...(headers ?? {}),
    };
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: mergedHeaders,
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
