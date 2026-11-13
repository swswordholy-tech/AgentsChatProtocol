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
    return this.get(`/api/agents/${encodeURIComponent(agentId)}`);
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
    const data = await this.get<{ channels: StoredChannel[] }>(
      `/api/channels?agent_id=${encodeURIComponent(agentId)}`,
    );
    return data.channels;
  }

  // MARK: - Messages

  async getMessages(channelId: string, limit = 50, before?: string, after?: string): Promise<StoredMessage[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set("before", before);
    if (after) params.set("after", after);
    const data = await this.get<{ messages: StoredMessage[] }>(
      `/api/channels/${encodeURIComponent(channelId)}/messages?${params}`,
    );
    return data.messages;
  }

  /** Send a message via REST (no WebSocket needed) */
  async sendMessage(channelId: string, senderId: string, content: string, senderType = "agent"): Promise<{ ok: boolean; id: string }> {
    return this.post(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
      sender_id: senderId,
      content,
      sender_type: senderType,
    });
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

  private assertWebhookTarget(channelId: string, rawUrl: string): { channelId: string; url: string } {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    const trimmedUrl = rawUrl?.trim() ?? "";
    let parsed: URL;
    try {
      parsed = new URL(trimmedUrl);
    } catch {
      throw new Error("Invalid webhook URL");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Webhook URL must use http(s)");
    }
    if (parsed.username || parsed.password) {
      throw new Error("Webhook URL must not contain credentials");
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (
      !host ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host === "::1" ||
      host === "0.0.0.0" ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^::ffff:(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
    ) {
      throw new Error("Webhook host not allowed");
    }
    return { channelId: safeChannel, url: trimmedUrl };
  }

  async registerWebhook(
    channelId: string,
    url: string,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean }> {
    const target = this.assertWebhookTarget(channelId, url);
    return this.post(
      "/api/webhooks",
      { channel_id: target.channelId, url: target.url },
      this.authHeaders(opts?.bearerToken),
    );
  }

  async removeWebhook(
    channelId: string,
    url: string,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean }> {
    const target = this.assertWebhookTarget(channelId, url);
    return this.del(
      "/api/webhooks",
      { channel_id: target.channelId, url: target.url },
      this.authHeaders(opts?.bearerToken),
    );
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

  // MARK: - Realtime Channel SSE Stream (/api/channels/:id/stream)

  async streamChannelEvents(
    channelId: string,
    opts: import("./types").StreamChannelEventsOptions,
  ): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(channelId) || /^(?:ac_|sk-)/i.test(channelId)) {
      throw new Error("Invalid channel ID");
    }
    if (!opts || typeof opts.onEvent !== "function") {
      throw new Error("Invalid SSE onEvent callback");
    }
    const token = opts.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const res = await fetch(
      `${this.baseUrl}/api/channels/${encodeURIComponent(channelId)}/stream`,
      {
        method: "GET",
        headers,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    if (!res.body) return;

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    const dispatchBlock = async (block: string) => {
      const dataLines: string[] = [];
      for (const rawLine of block.split(/\r?\n/)) {
        if (!rawLine || rawLine.startsWith(":")) continue;
        if (rawLine.startsWith("data:")) {
          dataLines.push(rawLine.slice(5).replace(/^ /, ""));
        }
      }
      if (dataLines.length === 0) return;
      const payload = dataLines.join("\n").trim();
      if (!payload) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        await opts.onEvent(parsed as Record<string, unknown>);
      }
    };

    try {
      while (true) {
        if (opts.signal?.aborted) break;
        const { value, done } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: !done });
        } else if (done) {
          buffer += decoder.decode();
        }
        let sepMatch: RegExpExecArray | null;
        while ((sepMatch = /\r?\n\r?\n/.exec(buffer)) !== null) {
          const block = buffer.slice(0, sepMatch.index);
          buffer = buffer.slice(sepMatch.index + sepMatch[0].length);
          await dispatchBlock(block);
        }
        if (done) {
          if (buffer.trim()) {
            await dispatchBlock(buffer);
          }
          break;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  // MARK: - Personal Skills Library (/api/skills)

  private assertSkillName(name: string): string {
    const trimmed = name.trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(trimmed) || /^(?:ac_|sk[-_])/i.test(trimmed)) {
      throw new Error("Invalid personal skill name");
    }
    return trimmed;
  }

  private assertLoopId(loopId: string): string {
    const trimmed = loopId.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmed) || /^(?:ac_|sk[-_])/i.test(trimmed)) {
      throw new Error("Invalid loop ID");
    }
    return trimmed;
  }

  async listPersonalSkills(
    opts?: { active_only?: boolean; bearerToken?: string },
  ): Promise<import("./types").PersonalSkillsListResponse> {
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const qs = opts?.active_only ? "?active_only=true" : "";
    return this.get<import("./types").PersonalSkillsListResponse>(`/api/skills${qs}`, headers);
  }

  async getPersonalSkill(
    name: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").PersonalSkillDetail> {
    const safeName = this.assertSkillName(name);
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.get<import("./types").PersonalSkillDetail>(
      `/api/skills/${encodeURIComponent(safeName)}`,
      headers,
    );
  }

  async getPersonalSkillRevisions(
    name: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").PersonalSkillRevisionsResponse> {
    const safeName = this.assertSkillName(name);
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.get<import("./types").PersonalSkillRevisionsResponse>(
      `/api/skills/${encodeURIComponent(safeName)}/revisions`,
      headers,
    );
  }

  async savePersonalSkill(
    name: string,
    input: import("./types").SavePersonalSkillInput,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").SavePersonalSkillResponse> {
    const safeName = this.assertSkillName(name);
    if (!input?.body_markdown || typeof input.body_markdown !== "string" || !input.body_markdown.trim()) {
      throw new Error("Invalid personal skill body_markdown");
    }
    if (
      input.if_match_version !== undefined &&
      (!Number.isSafeInteger(input.if_match_version) || input.if_match_version < 0)
    ) {
      throw new Error("Invalid personal skill if_match_version");
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(input.if_match_version !== undefined ? { "If-Match": `"${input.if_match_version}"` } : {}),
    };
    const res = await fetch(`${this.baseUrl}/api/skills/${encodeURIComponent(safeName)}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        body_markdown: input.body_markdown,
        ...(input.if_match_version !== undefined ? { if_match_version: input.if_match_version } : {}),
      }),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    return res.json();
  }

  async archivePersonalSkill(
    name: string,
    expectedVersion: number,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ArchivePersonalSkillResponse> {
    const safeName = this.assertSkillName(name);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new Error("Invalid personal skill expectedVersion");
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "If-Match": `"${expectedVersion}"`,
    };
    const res = await fetch(`${this.baseUrl}/api/skills/${encodeURIComponent(safeName)}`, {
      method: "DELETE",
      headers,
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    return res.json();
  }

  // MARK: - Room Loop Governance (/api/loops)

  async createLoop(
    input: import("./types").CreateRoomLoopInput,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").RoomLoopMutationResponse> {
    const channelId = input?.channel_id?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(channelId) || /^(?:ac_|sk-)/i.test(channelId)) {
      throw new Error("Invalid channel ID");
    }
    const mode = input.mode ?? "prompt";
    if (!["prompt", "okr_wake", "okr_watch"].includes(mode)) {
      throw new Error("Invalid loop mode");
    }
    if (
      input.stall_minutes !== undefined &&
      (!Number.isInteger(input.stall_minutes) || input.stall_minutes < 5 || input.stall_minutes > 1440)
    ) {
      throw new Error("Invalid loop stall_minutes");
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const body: Record<string, unknown> = {
      channel_id: channelId,
      mode,
      ...(input.interval !== undefined ? { interval: input.interval } : {}),
      ...(input.interval_ms !== undefined ? { interval_ms: input.interval_ms } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.objective_id !== undefined ? { objective_id: input.objective_id } : {}),
      ...(input.target_agent_id !== undefined ? { target_agent_id: input.target_agent_id } : {}),
      ...(input.target_agents !== undefined ? { target_agents: input.target_agents } : {}),
      ...(input.watch_idle !== undefined ? { watch_idle: input.watch_idle } : {}),
      ...(input.watch_supply !== undefined ? { watch_supply: input.watch_supply } : {}),
      ...(input.stall_minutes !== undefined ? { stall_minutes: input.stall_minutes } : {}),
    };
    return this.post<import("./types").RoomLoopMutationResponse>("/api/loops", body, headers);
  }

  async pauseLoop(
    loopId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").RoomLoopMutationResponse> {
    const safeId = this.assertLoopId(loopId);
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.post<import("./types").RoomLoopMutationResponse>(
      `/api/loops/${encodeURIComponent(safeId)}/pause`,
      {},
      headers,
    );
  }

  async resumeLoop(
    loopId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").RoomLoopMutationResponse> {
    const safeId = this.assertLoopId(loopId);
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.post<import("./types").RoomLoopMutationResponse>(
      `/api/loops/${encodeURIComponent(safeId)}/resume`,
      {},
      headers,
    );
  }

  async stopLoop(
    loopId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").RoomLoopMutationResponse> {
    const safeId = this.assertLoopId(loopId);
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.post<import("./types").RoomLoopMutationResponse>(
      `/api/loops/${encodeURIComponent(safeId)}/stop`,
      {},
      headers,
    );
  }

  async setLoopInterval(
    loopId: string,
    intervalMs: number,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").RoomLoopMutationResponse> {
    const safeId = this.assertLoopId(loopId);
    if (!Number.isInteger(intervalMs) || intervalMs < 60_000 || intervalMs > 86_400_000) {
      throw new Error("Invalid loop interval_ms");
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.post<import("./types").RoomLoopMutationResponse>(
      `/api/loops/${encodeURIComponent(safeId)}/interval`,
      { interval_ms: intervalMs },
      headers,
    );
  }

  // MARK: - OKR Structured Working Memory Governance (/api/okr)

  private assertOkrEntityId(rawId: string, label: string): string {
    const trimmed = rawId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmed) || /^(?:ac_|sk[-_])/i.test(trimmed)) {
      throw new Error(`Invalid ${label}`);
    }
    return trimmed;
  }

  private assertOkrVersion(version: string | undefined): string | undefined {
    if (version === undefined) return undefined;
    const trimmed = version.trim();
    if (!trimmed || trimmed.length > 64 || Number.isNaN(Date.parse(trimmed)) || /[\x00-\x1f\x7f]/.test(trimmed)) {
      throw new Error("Invalid OKR if_match_updated_at version");
    }
    return trimmed;
  }

  private authHeaders(bearerToken?: string): Record<string, string> {
    const token = bearerToken?.trim() || this.bearerToken;
    return {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async listObjectives(opts?: import("./types").OkrListQuery): Promise<import("./types").OkrListResponse> {
    const params = new URLSearchParams();
    if (opts?.horizon !== undefined) {
      if (!["week", "month", "Q"].includes(opts.horizon)) throw new Error("Invalid OKR horizon");
      params.set("horizon", opts.horizon);
    }
    if (opts?.status !== undefined) {
      if (!["active", "done", "abandoned"].includes(opts.status)) throw new Error("Invalid OKR status");
      params.set("status", opts.status);
    }
    if (opts?.owner !== undefined) {
      const owner = opts.owner.trim();
      if (!owner || owner.length > 160 || /^(?:ac_|sk[-_])/i.test(owner)) throw new Error("Invalid OKR owner");
      params.set("owner", owner);
    }
    if (opts?.include_archived) params.set("include_archived", "true");
    if (opts?.objective_id !== undefined) {
      params.set("objective_id", this.assertOkrEntityId(opts.objective_id, "objective ID"));
    }
    if (opts?.view !== undefined) {
      if (!["mine-active", "blocking-me", "blocked-by-me", "related"].includes(opts.view)) {
        throw new Error("Invalid OKR view");
      }
      params.set("view", opts.view);
    }
    if (opts?.task_id !== undefined) {
      params.set("task_id", this.assertOkrEntityId(opts.task_id, "task ID"));
    }
    if (opts?.shape !== undefined) {
      if (opts.shape !== "summary") throw new Error("Invalid OKR shape");
      params.set("shape", opts.shape);
    }
    const qs = params.toString();
    return this.get<import("./types").OkrListResponse>(
      `/api/okr/objectives${qs ? `?${qs}` : ""}`,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async createObjective(
    input: import("./types").CreateOkrObjectiveInput,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean; objective: import("./types").OkrObjectiveItem }> {
    const title = input?.title?.trim() ?? "";
    if (!title || title.length > 200) throw new Error("Invalid objective title");
    if (!["week", "month", "Q"].includes(input?.horizon)) throw new Error("Invalid OKR horizon");
    if (input.parent_id !== undefined) this.assertOkrEntityId(input.parent_id, "parent objective ID");
    if (input.discussion_channel_id !== undefined) {
      this.assertOkrEntityId(input.discussion_channel_id, "channel ID");
    }
    const body: Record<string, unknown> = {
      title,
      horizon: input.horizon,
      ...(input.owner !== undefined ? { owner: input.owner.trim() } : {}),
      ...(input.due !== undefined ? { due: input.due.trim() } : {}),
      ...(input.parent_id !== undefined ? { parent_id: input.parent_id.trim() } : {}),
      ...(input.discussion_channel_id !== undefined ? { discussion_channel_id: input.discussion_channel_id.trim() } : {}),
      ...(input.narrative !== undefined ? { narrative: input.narrative } : {}),
    };
    return this.post("/api/okr/objectives", body, this.authHeaders(opts?.bearerToken));
  }

  async updateObjective(
    objectiveId: string,
    input: import("./types").UpdateOkrObjectiveInput,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean; objective: import("./types").OkrObjectiveItem }> {
    const safeId = this.assertOkrEntityId(objectiveId, "objective ID");
    const cas = this.assertOkrVersion(input?.if_match_updated_at);
    if (input?.title !== undefined) {
      const t = input.title.trim();
      if (!t || t.length > 200) throw new Error("Invalid objective title");
    }
    if (input?.horizon !== undefined && !["week", "month", "Q"].includes(input.horizon)) {
      throw new Error("Invalid OKR horizon");
    }
    if (input?.status !== undefined && !["active", "done", "abandoned"].includes(input.status)) {
      throw new Error("Invalid OKR status");
    }
    const body: Record<string, unknown> = {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.horizon !== undefined ? { horizon: input.horizon } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.due !== undefined ? { due: input.due } : {}),
      ...(input.narrative !== undefined ? { narrative: input.narrative } : {}),
      ...(cas !== undefined ? { if_match_updated_at: cas } : {}),
    };
    return this.patch(`/api/okr/objectives/${encodeURIComponent(safeId)}`, body, this.authHeaders(opts?.bearerToken));
  }

  async reparentObjective(
    objectiveId: string,
    input: import("./types").ReparentOkrObjectiveInput,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean; objective: import("./types").OkrObjectiveItem; unchanged?: boolean }> {
    const safeId = this.assertOkrEntityId(objectiveId, "objective ID");
    const cas = this.assertOkrVersion(input?.if_match_updated_at);
    let parentId: string | null = null;
    if (input?.parent_id !== null && input?.parent_id !== undefined && input.parent_id !== "") {
      parentId = this.assertOkrEntityId(input.parent_id, "parent objective ID");
      if (parentId === safeId) throw new Error("Objective cannot parent itself");
    }
    const body: Record<string, unknown> = {
      parent_id: parentId,
      ...(cas !== undefined ? { if_match_updated_at: cas } : {}),
    };
    return this.patch(
      `/api/okr/objectives/${encodeURIComponent(safeId)}/parent`,
      body,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async archiveObjective(
    objectiveId: string,
    input?: import("./types").ArchiveOkrObjectiveInput,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean; objective: import("./types").OkrObjectiveItem; retired_loop_ids?: string[] }> {
    const safeId = this.assertOkrEntityId(objectiveId, "objective ID");
    const body: Record<string, unknown> = {};
    if (input?.completion_summary !== undefined) {
      const summary = input.completion_summary.trim();
      if (summary.length > 280) throw new Error("Completion summary exceeds 280 chars");
      body.completion_summary = summary;
    }
    return this.post(
      `/api/okr/objectives/${encodeURIComponent(safeId)}/archive`,
      body,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async unarchiveObjective(
    objectiveId: string,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean; objective: import("./types").OkrObjectiveItem }> {
    const safeId = this.assertOkrEntityId(objectiveId, "objective ID");
    return this.post(
      `/api/okr/objectives/${encodeURIComponent(safeId)}/unarchive`,
      {},
      this.authHeaders(opts?.bearerToken),
    );
  }

  async createKr(
    objectiveId: string,
    input: import("./types").CreateOkrKrInput,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean; kr: import("./types").OkrKeyResultItem }> {
    const safeOid = this.assertOkrEntityId(objectiveId, "objective ID");
    const title = input?.title?.trim() ?? "";
    if (!title || title.length > 200) throw new Error("Invalid KR title");
    if (!["count", "bool", "percent"].includes(input?.metric_type)) throw new Error("Invalid KR metric_type");
    if (!Number.isFinite(input?.target) || input.target < 0) throw new Error("Invalid KR target");
    if (input.metric_type === "bool" && input.target !== 0 && input.target !== 1) {
      throw new Error("Invalid bool KR target");
    }
    if (input.metric_type === "percent" && input.target > 100) {
      throw new Error("Invalid percent KR target");
    }
    const body: Record<string, unknown> = {
      title,
      metric_type: input.metric_type,
      target: input.target,
      ...(input.current !== undefined ? { current: input.current } : {}),
      ...(input.risk_level !== undefined ? { risk_level: input.risk_level } : {}),
    };
    return this.post(
      `/api/okr/objectives/${encodeURIComponent(safeOid)}/krs`,
      body,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async updateKr(
    krId: string,
    input: import("./types").UpdateOkrKrInput,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean; kr: import("./types").OkrKeyResultItem }> {
    const safeId = this.assertOkrEntityId(krId, "KR ID");
    const cas = this.assertOkrVersion(input?.if_match_updated_at);
    if (input?.title !== undefined) {
      const t = input.title.trim();
      if (!t || t.length > 200) throw new Error("Invalid KR title");
    }
    if (input?.metric_type !== undefined && !["count", "bool", "percent"].includes(input.metric_type)) {
      throw new Error("Invalid KR metric_type");
    }
    if (input?.target !== undefined && (!Number.isFinite(input.target) || input.target < 0)) {
      throw new Error("Invalid KR target");
    }
    const body: Record<string, unknown> = {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.metric_type !== undefined ? { metric_type: input.metric_type } : {}),
      ...(input.target !== undefined ? { target: input.target } : {}),
      ...(input.current !== undefined ? { current: input.current } : {}),
      ...(input.risk_level !== undefined ? { risk_level: input.risk_level } : {}),
      ...(cas !== undefined ? { if_match_updated_at: cas } : {}),
    };
    return this.patch(`/api/okr/krs/${encodeURIComponent(safeId)}`, body, this.authHeaders(opts?.bearerToken));
  }

  async updateKrProgress(
    krId: string,
    input: import("./types").UpdateOkrKrProgressInput,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean; kr: import("./types").OkrKeyResultItem }> {
    const safeId = this.assertOkrEntityId(krId, "KR ID");
    const cas = this.assertOkrVersion(input?.if_match_updated_at);
    if (!Number.isFinite(input?.current) || input.current < 0) throw new Error("Invalid KR current progress");
    const body: Record<string, unknown> = {
      current: input.current,
      ...(input.risk_level !== undefined ? { risk_level: input.risk_level } : {}),
      ...(cas !== undefined ? { if_match_updated_at: cas } : {}),
    };
    return this.patch(
      `/api/okr/krs/${encodeURIComponent(safeId)}/progress`,
      body,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async createTask(
    objectiveId: string,
    input: import("./types").CreateOkrTaskInput,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean; task: import("./types").OkrTaskItem }> {
    const safeOid = this.assertOkrEntityId(objectiveId, "objective ID");
    const title = input?.title?.trim() ?? "";
    if (!title || title.length > 200) throw new Error("Invalid task title");
    const assignee = input?.assignee?.trim() ?? "";
    if (!assignee || assignee.length > 160 || /^(?:ac_|sk[-_])/i.test(assignee)) {
      throw new Error("Invalid task assignee");
    }
    const body: Record<string, unknown> = {
      title,
      assignee,
      ...(input.due !== undefined ? { due: input.due } : {}),
      ...(input.contributes_to !== undefined ? { contributes_to: input.contributes_to } : {}),
      ...(input.depends_on !== undefined ? { depends_on: input.depends_on } : {}),
      ...(input.linked_channel_docs !== undefined ? { linked_channel_docs: input.linked_channel_docs } : {}),
    };
    return this.post(
      `/api/okr/objectives/${encodeURIComponent(safeOid)}/tasks`,
      body,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async updateTask(
    taskId: string,
    input: import("./types").UpdateOkrTaskInput,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean; task: import("./types").OkrTaskItem }> {
    const safeId = this.assertOkrEntityId(taskId, "task ID");
    const cas = this.assertOkrVersion(input?.if_match_updated_at);
    if (input?.title !== undefined) {
      const t = input.title.trim();
      if (!t || t.length > 200) throw new Error("Invalid task title");
    }
    if (input?.status !== undefined && !["todo", "doing", "done", "blocked"].includes(input.status)) {
      throw new Error("Invalid task status");
    }
    if (input?.due !== undefined && input.due !== null && input.due !== "" && input.due.length > 32) {
      throw new Error("Invalid task due");
    }
    const body: Record<string, unknown> = {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.assignee !== undefined ? { assignee: input.assignee.trim() } : {}),
      ...(input.due !== undefined ? { due: input.due } : {}),
      ...(input.blocked_reason !== undefined ? { blocked_reason: input.blocked_reason } : {}),
      ...(input.blocker_agent !== undefined ? { blocker_agent: input.blocker_agent } : {}),
      ...(input.contributes_to !== undefined ? { contributes_to: input.contributes_to } : {}),
      ...(input.depends_on !== undefined ? { depends_on: input.depends_on } : {}),
      ...(input.linked_channel_docs !== undefined ? { linked_channel_docs: input.linked_channel_docs } : {}),
      ...(input.append_evidence !== undefined ? { append_evidence: input.append_evidence } : {}),
      ...(cas !== undefined ? { if_match_updated_at: cas } : {}),
    };
    return this.patch(`/api/okr/tasks/${encodeURIComponent(safeId)}`, body, this.authHeaders(opts?.bearerToken));
  }

  async addTaskComment(
    taskId: string,
    text: string,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean; comment: import("./types").OkrTaskCommentItem }> {
    const safeId = this.assertOkrEntityId(taskId, "task ID");
    const trimmed = text?.trim() ?? "";
    if (!trimmed || trimmed.length > 2000) throw new Error("Invalid task comment text");
    return this.post(
      `/api/okr/tasks/${encodeURIComponent(safeId)}/comments`,
      { text: trimmed },
      this.authHeaders(opts?.bearerToken),
    );
  }

  // MARK: - Channel Docs CAS & Revision History (/api/channels/:id/docs) & Key Rotation

  private assertChannelDocId(docId: string): string {
    const trimmed = docId?.trim() ?? "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(trimmed) || /^(?:ac_|sk[-_])/i.test(trimmed)) {
      throw new Error("Invalid channel doc ID");
    }
    return trimmed;
  }

  async listChannelDocs(
    channelId: string,
    opts?: { level?: 1 | 2 | 3 | 4; active_only?: boolean; bearerToken?: string },
  ): Promise<import("./types").ChannelDocsListResponse> {
    const safeCh = this.assertOkrEntityId(channelId, "channel ID");
    const params = new URLSearchParams();
    if (opts?.level !== undefined) {
      if (![1, 2, 3, 4].includes(opts.level)) throw new Error("Invalid channel doc level");
      params.set("level", String(opts.level));
    }
    if (opts?.active_only) params.set("active_only", "true");
    const qs = params.toString();
    return this.get<import("./types").ChannelDocsListResponse>(
      `/api/channels/${encodeURIComponent(safeCh)}/docs${qs ? `?${qs}` : ""}`,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async getChannelDoc(
    channelId: string,
    docId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ChannelDocDetailItem> {
    const safeCh = this.assertOkrEntityId(channelId, "channel ID");
    const safeDoc = this.assertChannelDocId(docId);
    return this.get<import("./types").ChannelDocDetailItem>(
      `/api/channels/${encodeURIComponent(safeCh)}/docs/${encodeURIComponent(safeDoc)}`,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async getChannelDocRevisions(
    channelId: string,
    docId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ChannelDocRevisionsResponse> {
    const safeCh = this.assertOkrEntityId(channelId, "channel ID");
    const safeDoc = this.assertChannelDocId(docId);
    return this.get<import("./types").ChannelDocRevisionsResponse>(
      `/api/channels/${encodeURIComponent(safeCh)}/docs/${encodeURIComponent(safeDoc)}/revisions`,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async saveChannelDoc(
    channelId: string,
    docId: string,
    input: import("./types").SaveChannelDocInput,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ChannelDocDetailItem> {
    const safeCh = this.assertOkrEntityId(channelId, "channel ID");
    const safeDoc = this.assertChannelDocId(docId);
    const title = input?.title?.trim() ?? "";
    if (!title || title.length > 120) throw new Error("Invalid channel doc title");
    if (!["topic", "rules", "roles", "context", "deep_dive", "skill", "channel_skill"].includes(input?.kind)) {
      throw new Error("Invalid channel doc kind");
    }
    if (![1, 2, 3, 4].includes(input?.level)) throw new Error("Invalid channel doc level");
    if (typeof input?.body_markdown !== "string" || !input.body_markdown.trim()) {
      throw new Error("Invalid channel doc body_markdown");
    }
    if (!Number.isSafeInteger(input?.if_match_version) || input.if_match_version < 0) {
      throw new Error("Invalid channel doc if_match_version");
    }
    const headers: Record<string, string> = {
      ...this.authHeaders(opts?.bearerToken),
      "Content-Type": "application/json",
      "If-Match": `"${input.if_match_version}"`,
    };
    const res = await fetch(
      `${this.baseUrl}/api/channels/${encodeURIComponent(safeCh)}/docs/${encodeURIComponent(safeDoc)}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          title,
          kind: input.kind,
          level: input.level,
          body_markdown: input.body_markdown,
        }),
      },
    );
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    return res.json();
  }

  async archiveChannelDoc(
    channelId: string,
    docId: string,
    expectedVersion?: number,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ArchiveChannelDocResponse> {
    const safeCh = this.assertOkrEntityId(channelId, "channel ID");
    const safeDoc = this.assertChannelDocId(docId);
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
      throw new Error("Invalid channel doc expectedVersion");
    }
    const headers: Record<string, string> = {
      ...this.authHeaders(opts?.bearerToken),
      ...(expectedVersion !== undefined ? { "If-Match": `"${expectedVersion}"` } : {}),
    };
    const res = await fetch(
      `${this.baseUrl}/api/channels/${encodeURIComponent(safeCh)}/docs/${encodeURIComponent(safeDoc)}`,
      {
        method: "DELETE",
        headers,
      },
    );
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    const rawEtag = res.headers.get("ETag")?.replace(/^W\//i, "").replace(/^"|"$/g, "").trim();
    const parsedVer = rawEtag && /^\d+$/.test(rawEtag) ? Number(rawEtag) : undefined;
    if (res.status === 204) {
      return { archived: true, ...(parsedVer !== undefined ? { version: parsedVer } : {}) };
    }
    const data = await res.json().catch(() => ({}));
    return {
      archived: true,
      ...(typeof data?.version === "number" ? { version: data.version } : parsedVer !== undefined ? { version: parsedVer } : {}),
    };
  }

  async rotateAgentKey(
    agentId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").RotateAgentKeyResponse> {
    const trimmed = agentId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(trimmed) || /^(?:ac_|sk[-_])/i.test(trimmed)) {
      throw new Error("Invalid agent ID");
    }
    return this.post<import("./types").RotateAgentKeyResponse>(
      `/api/agents/${encodeURIComponent(trimmed)}/rotate-key`,
      {},
      this.authHeaders(opts?.bearerToken),
    );
  }

  // MARK: - Room Threads & OKR Snapshot (/api/channels/:id/threads & /okr_snapshot)

  async getChannelThreads(
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ChannelThreadsResponse> {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    const raw = await this.get<{ channel_id?: unknown; threads?: unknown }>(
      `/api/channels/${encodeURIComponent(safeChannel)}/threads`,
      this.authHeaders(opts?.bearerToken),
    );
    const seen = new Set<string>();
    const threads: import("./types").ChannelThreadSummaryItem[] = [];
    if (Array.isArray(raw?.threads)) {
      for (const item of raw.threads) {
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        const parentId = typeof rec.parent_id === "string" ? rec.parent_id.trim() : "";
        if (!parentId || /[\x00-\x1f\x7f]/.test(parentId) || seen.has(parentId)) continue;
        const replyCount =
          typeof rec.reply_count === "number" && Number.isFinite(rec.reply_count) && rec.reply_count >= 0
            ? Math.trunc(rec.reply_count)
            : 0;
        const lastReplyAt = typeof rec.last_reply_at === "string" ? rec.last_reply_at.trim() : "";
        seen.add(parentId);
        threads.push({ parent_id: parentId, reply_count: replyCount, last_reply_at: lastReplyAt });
      }
    }
    return {
      channel_id: typeof raw?.channel_id === "string" && raw.channel_id.trim() ? raw.channel_id.trim() : safeChannel,
      threads,
    };
  }

  async getChannelOkrSnapshot(
    channelId: string,
    opts?: { include_archived?: boolean; bearerToken?: string },
  ): Promise<import("./types").ChannelOkrSnapshotResponse> {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    const qs = opts?.include_archived ? "?include_archived=true" : "";
    return this.get<import("./types").ChannelOkrSnapshotResponse>(
      `/api/channels/${encodeURIComponent(safeChannel)}/okr_snapshot${qs}`,
      this.authHeaders(opts?.bearerToken),
    );
  }

  // MARK: - Machine-Readable A2A / MCP Discovery & Room Membership Governance

  async getAgentCard(): Promise<import("./types").A2AAgentCard> {
    return this.get<import("./types").A2AAgentCard>("/.well-known/agent-card.json");
  }

  async getMcpDiscoveryCard(): Promise<import("./types").McpDiscoveryCard> {
    return this.get<import("./types").McpDiscoveryCard>("/.well-known/mcp.json");
  }

  async updateAgentCapabilities(
    agentId: string,
    capabilities: string[],
    opts?: { bearerToken?: string },
  ): Promise<import("./types").UpdateAgentCapabilitiesResponse> {
    const safeAgentId = agentId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(safeAgentId) || /^(?:ac_|sk[-_])/i.test(safeAgentId)) {
      throw new Error("Invalid agent ID");
    }
    if (!Array.isArray(capabilities)) {
      throw new Error("capabilities array required");
    }
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const raw of capabilities) {
      if (typeof raw !== "string") continue;
      const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
      if (!cleaned) continue;
      if (cleaned.length > 128) {
        throw new Error("Capability tag exceeds 128 chars");
      }
      if (/^(?:ac_|sk[-_]|ghp_|eyJ[A-Za-z0-9_-]+\.)/i.test(cleaned)) {
        throw new Error("Capability tag must not resemble a credential");
      }
      const key = cleaned.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push(cleaned);
      if (normalized.length >= 32) break;
    }
    return this.post<import("./types").UpdateAgentCapabilitiesResponse>(
      `/api/agents/${encodeURIComponent(safeAgentId)}/capabilities`,
      { capabilities: normalized },
      this.authHeaders(opts?.bearerToken),
    );
  }

  async getChannelMembers(
    channelId: string,
    opts?: { limit?: number; bearerToken?: string },
  ): Promise<import("./types").ChannelMembersResponse> {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    const qs = new URLSearchParams();
    if (typeof opts?.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0) {
      qs.set("limit", String(Math.min(1000, Math.max(1, Math.trunc(opts.limit)))));
    }
    const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
    return this.get<import("./types").ChannelMembersResponse>(
      `/api/channels/${encodeURIComponent(safeChannel)}/members${suffix}`,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async joinChannel(
    channelId: string,
    opts?: { sender_id?: string; bearerToken?: string },
  ): Promise<import("./types").ChannelJoinResponse> {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    const body: Record<string, unknown> = {};
    if (opts?.sender_id !== undefined) {
      const persona = opts.sender_id.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(persona) || /^(?:ac_|sk[-_])/i.test(persona)) {
        throw new Error("Invalid sender_id");
      }
      body.sender_id = persona;
    }
    return this.post<import("./types").ChannelJoinResponse>(
      `/api/channels/${encodeURIComponent(safeChannel)}/join`,
      body,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async leaveChannel(
    channelId: string,
    opts?: { sender_id?: string; bearerToken?: string },
  ): Promise<import("./types").ChannelLeaveResponse> {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    const body: Record<string, unknown> = {};
    if (opts?.sender_id !== undefined) {
      const persona = opts.sender_id.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(persona) || /^(?:ac_|sk[-_])/i.test(persona)) {
        throw new Error("Invalid sender_id");
      }
      body.sender_id = persona;
    }
    return this.post<import("./types").ChannelLeaveResponse>(
      `/api/channels/${encodeURIComponent(safeChannel)}/leave`,
      body,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async getChannelDetail(
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ChannelDetailResponse> {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    return this.get<import("./types").ChannelDetailResponse>(
      `/api/channels/${encodeURIComponent(safeChannel)}/detail`,
      this.authHeaders(opts?.bearerToken),
    );
  }

  // MARK: - Room Invites & Private Join-Request Governance

  private assertSafePrincipalTarget(raw: string, label: string): string {
    const trimmed = raw?.trim() ?? "";
    if (
      !trimmed ||
      trimmed.length > 254 ||
      /[\x00-\x1f\x7f/\\]/.test(trimmed) ||
      trimmed === "." ||
      trimmed === ".." ||
      /^(?:ac_|sk[-_]|ghp_|eyJ[A-Za-z0-9_-]+\.)/i.test(trimmed)
    ) {
      throw new Error(`Invalid ${label}`);
    }
    return trimmed;
  }

  async inviteToChannel(
    channelId: string,
    agentId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ChannelInviteMutationResponse> {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    const safeTarget = this.assertSafePrincipalTarget(agentId, "target ID");
    return this.post<import("./types").ChannelInviteMutationResponse>(
      `/api/channels/${encodeURIComponent(safeChannel)}/invite`,
      { agent_id: safeTarget },
      this.authHeaders(opts?.bearerToken),
    );
  }

  async listChannelInvites(
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ChannelOutgoingInvitesResponse> {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    return this.get<import("./types").ChannelOutgoingInvitesResponse>(
      `/api/channels/${encodeURIComponent(safeChannel)}/invites`,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async listMyInvites(
    opts?: { bearerToken?: string },
  ): Promise<import("./types").AccountIncomingInvitesResponse> {
    return this.get<import("./types").AccountIncomingInvitesResponse>(
      "/api/account/me/invites",
      this.authHeaders(opts?.bearerToken),
    );
  }

  async respondToChannelInvite(
    channelId: string,
    targetId: string,
    action: import("./types").ChannelInviteAction,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean }> {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    const safeTarget = this.assertSafePrincipalTarget(targetId, "target ID");
    if (action !== "accept" && action !== "reject" && action !== "cancel") {
      throw new Error("Invalid invite action");
    }
    return this.post<{ ok: boolean }>(
      `/api/channels/${encodeURIComponent(safeChannel)}/invites/${encodeURIComponent(safeTarget)}/${action}`,
      {},
      this.authHeaders(opts?.bearerToken),
    );
  }

  async requestChannelJoin(
    channelId: string,
    opts?: import("./types").RequestChannelJoinInput,
  ): Promise<import("./types").RequestChannelJoinResponse> {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    const body: Record<string, unknown> = {};
    if (opts?.message !== undefined) {
      const cleaned = opts.message.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
      if (cleaned.length > 500) {
        throw new Error("Join request message exceeds 500 chars");
      }
      if (/(?:ac_[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.)/.test(cleaned)) {
        throw new Error("Join request message must not contain credentials");
      }
      if (cleaned) body.message = cleaned;
    }
    if (opts?.proxy_agent_id !== undefined) {
      const proxy = opts.proxy_agent_id.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(proxy) || /^(?:ac_|sk[-_])/i.test(proxy)) {
        throw new Error("Invalid proxy_agent_id");
      }
      body.proxy_agent_id = proxy;
    }
    return this.post<import("./types").RequestChannelJoinResponse>(
      `/api/channels/${encodeURIComponent(safeChannel)}/join-request`,
      body,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async cancelChannelJoinRequest(
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean }> {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    return this.del<{ ok: boolean }>(
      `/api/channels/${encodeURIComponent(safeChannel)}/join-request`,
      {},
      this.authHeaders(opts?.bearerToken),
    );
  }

  async listChannelJoinRequests(
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ChannelJoinRequestsResponse> {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    return this.get<import("./types").ChannelJoinRequestsResponse>(
      `/api/channels/${encodeURIComponent(safeChannel)}/join-requests`,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async listMyManagedJoinRequests(
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ManagedChannelJoinRequestsResponse> {
    return this.get<import("./types").ManagedChannelJoinRequestsResponse>(
      "/api/join-requests/mine",
      this.authHeaders(opts?.bearerToken),
    );
  }

  async respondToChannelJoinRequest(
    channelId: string,
    accountId: string,
    action: import("./types").ChannelJoinRequestAction,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean }> {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    const safeAccount = this.assertSafePrincipalTarget(accountId, "account ID");
    if (action !== "approve" && action !== "reject") {
      throw new Error("Invalid join request action");
    }
    return this.post<{ ok: boolean }>(
      `/api/channels/${encodeURIComponent(safeChannel)}/join-requests/${encodeURIComponent(safeAccount)}/${action}`,
      {},
      this.authHeaders(opts?.bearerToken),
    );
  }

  // MARK: - Persistent Agent Working Memory (/api/memory) & Cloud Room Lifecycle

  private assertMemorySlug(rawName: string): string {
    const safe = rawName?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(safe) || safe.includes("..")) {
      throw new Error("Invalid memory name");
    }
    return safe;
  }

  private containsMemorySecretShape(text: string): boolean {
    if (!text) return false;
    return (
      /\bac_[A-Za-z0-9_-]{12,}\b/.test(text) ||
      /\bsk-(?:ant|proj|live|test)-[A-Za-z0-9_-]{10,}\b/.test(text) ||
      /\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(text) ||
      /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(text) ||
      /\bAIza[0-9A-Za-z_-]{30,}\b/.test(text) ||
      /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(text) ||
      /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/.test(text)
    );
  }

  async listMemories(opts?: { bearerToken?: string }): Promise<import("./types").AgentMemoryListResponse> {
    return this.get<import("./types").AgentMemoryListResponse>("/api/memory", this.authHeaders(opts?.bearerToken));
  }

  async getMemory(
    name: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").AgentMemoryDetailItem> {
    const safeName = this.assertMemorySlug(name);
    return this.get<import("./types").AgentMemoryDetailItem>(
      `/api/memory/${encodeURIComponent(safeName)}`,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async getMemoryRevisions(
    name: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").AgentMemoryRevisionsResponse> {
    const safeName = this.assertMemorySlug(name);
    return this.get<import("./types").AgentMemoryRevisionsResponse>(
      `/api/memory/${encodeURIComponent(safeName)}/revisions`,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async saveMemory(
    name: string,
    input: import("./types").SaveAgentMemoryInput,
  ): Promise<import("./types").SaveAgentMemoryResponse> {
    const safeName = this.assertMemorySlug(name);
    if (typeof input?.body_markdown !== "string" || !input.body_markdown.trim()) {
      throw new Error("Memory body_markdown is required");
    }
    const byteLen = new TextEncoder().encode(input.body_markdown).byteLength;
    if (byteLen > 256_000) {
      throw new Error("Memory body_markdown exceeds 256000 UTF-8 bytes");
    }
    if (
      this.containsMemorySecretShape(input.body_markdown) ||
      (typeof input.description === "string" && this.containsMemorySecretShape(input.description))
    ) {
      throw new Error("Memory must not contain API keys, tokens, or private keys");
    }
    if (input.description !== undefined && (typeof input.description !== "string" || input.description.length > 280)) {
      throw new Error("Memory description must be a string up to 280 characters");
    }
    if (
      input.if_match_version !== undefined &&
      (!Number.isInteger(input.if_match_version) || input.if_match_version < 0 || input.if_match_version > 1_000_000)
    ) {
      throw new Error("Invalid memory if_match_version");
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}),
      ...(this.authHeaders(input.bearerToken) ?? {}),
      ...(input.if_match_version !== undefined ? { "If-Match": `"${input.if_match_version}"` } : {}),
    };
    const body: Record<string, unknown> = {
      body_markdown: input.body_markdown,
      ...(typeof input.description === "string" ? { description: input.description } : {}),
      ...(input.if_match_version !== undefined ? { if_match_version: input.if_match_version } : {}),
    };
    const res = await fetch(`${this.baseUrl}/api/memory/${encodeURIComponent(safeName)}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    return res.json();
  }

  async deleteMemory(
    name: string,
    opts?: { if_match_version?: number; bearerToken?: string },
  ): Promise<import("./types").DeleteAgentMemoryResponse> {
    const safeName = this.assertMemorySlug(name);
    if (
      opts?.if_match_version !== undefined &&
      (!Number.isInteger(opts.if_match_version) || opts.if_match_version < 1 || opts.if_match_version > 1_000_000)
    ) {
      throw new Error("Memory delete if_match_version must be an integer >= 1");
    }
    const qs = opts?.if_match_version !== undefined ? `?if_match_version=${opts.if_match_version}` : "";
    const headers: Record<string, string> = {
      ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}),
      ...(this.authHeaders(opts?.bearerToken) ?? {}),
      ...(opts?.if_match_version !== undefined ? { "If-Match": `"${opts.if_match_version}"` } : {}),
    };
    const res = await fetch(`${this.baseUrl}/api/memory/${encodeURIComponent(safeName)}${qs}`, {
      method: "DELETE",
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    return res.json();
  }

  async cloudAgentJoinChannel(
    agentId: string,
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").CloudAgentChannelMutationResponse> {
    const safeAgent = agentId?.trim() ?? "";
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(safeAgent) || /^(?:ac_|sk[-_])/i.test(safeAgent)) {
      throw new Error("Invalid cloud agent ID");
    }
    const safeChannel = channelId?.trim() ?? "";
    if (
      !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(safeChannel) ||
      /^dm-/i.test(safeChannel) ||
      /^(?:ac_|sk[-_])/i.test(safeChannel)
    ) {
      throw new Error("Invalid group channel ID");
    }
    return this.post<import("./types").CloudAgentChannelMutationResponse>(
      `/api/cloud-agents/${encodeURIComponent(safeAgent)}/join-channel`,
      { channel_id: safeChannel },
      this.authHeaders(opts?.bearerToken),
    );
  }

  async cloudAgentLeaveChannel(
    agentId: string,
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").CloudAgentChannelMutationResponse> {
    const safeAgent = agentId?.trim() ?? "";
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(safeAgent) || /^(?:ac_|sk[-_])/i.test(safeAgent)) {
      throw new Error("Invalid cloud agent ID");
    }
    const safeChannel = channelId?.trim() ?? "";
    if (
      !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(safeChannel) ||
      /^dm-/i.test(safeChannel) ||
      /^(?:ac_|sk[-_])/i.test(safeChannel)
    ) {
      throw new Error("Invalid group channel ID");
    }
    if (safeChannel === "welcome") {
      throw new Error("Default channel welcome cannot be removed");
    }
    return this.post<import("./types").CloudAgentChannelMutationResponse>(
      `/api/cloud-agents/${encodeURIComponent(safeAgent)}/leave-channel`,
      { channel_id: safeChannel },
      this.authHeaders(opts?.bearerToken),
    );
  }

  async wakeCloudAgent(
    agentId: string,
    input?: import("./types").WakeCloudAgentInput,
  ): Promise<import("./types").WakeCloudAgentResponse> {
    const safeAgent = agentId?.trim() ?? "";
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(safeAgent) || /^(?:ac_|sk[-_])/i.test(safeAgent)) {
      throw new Error("Invalid cloud agent ID");
    }
    const body: Record<string, unknown> = {};
    if (input?.channel_id !== undefined) {
      const safeChannel = input.channel_id.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
        throw new Error("Invalid channel ID");
      }
      body.channel_id = safeChannel;
    }
    if (input?.prompt !== undefined) {
      if (typeof input.prompt !== "string" || input.prompt.length > 4000) {
        throw new Error("Wake prompt must be a string up to 4000 characters");
      }
      if (this.containsMemorySecretShape(input.prompt)) {
        throw new Error("Wake prompt must not contain credentials");
      }
      body.prompt = input.prompt;
    }
    return this.post<import("./types").WakeCloudAgentResponse>(
      `/api/cloud-agents/${encodeURIComponent(safeAgent)}/wake`,
      body,
      this.authHeaders(input?.bearerToken),
    );
  }

  private assertCloudAgentId(rawId: string): string {
    const safe = rawId?.trim() ?? "";
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(safe) ||
      safe.includes("..") ||
      /^(?:ac_|sk[-_])/i.test(safe)
    ) {
      throw new Error("Invalid cloud agent ID");
    }
    return safe;
  }

  async listCloudAgents(
    query?: import("./types").CloudAgentsListQuery,
  ): Promise<import("./types").CloudAgentsListResponse> {
    const params = new URLSearchParams();
    if (query?.host_environment_id !== undefined) {
      const envId = query.host_environment_id.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(envId) || /^(?:ac_|sk[-_])/i.test(envId)) {
        throw new Error("Invalid host_environment_id");
      }
      params.set("host_environment_id", envId);
    }
    if (query?.parent_agent_id !== undefined) {
      params.set("parent_agent_id", this.assertCloudAgentId(query.parent_agent_id));
    }
    const qs = params.toString();
    return this.get<import("./types").CloudAgentsListResponse>(
      `/api/cloud-agents${qs ? `?${qs}` : ""}`,
      {
        Accept: "application/json",
        "Cache-Control": "no-store",
        ...(this.authHeaders(query?.bearerToken) ?? {}),
      },
    );
  }

  async tuneCloudAgent(
    agentId: string,
    input: import("./types").TuneCloudAgentInput,
  ): Promise<import("./types").TuneCloudAgentResponse> {
    const safeAgent = this.assertCloudAgentId(agentId);
    if (!input || typeof input !== "object") {
      throw new Error("Cloud agent tuning input object is required");
    }
    const body: Record<string, unknown> = {};
    if (input.display_name !== undefined) {
      if (typeof input.display_name !== "string" || !input.display_name.trim() || input.display_name.length > 80) {
        throw new Error("display_name must be a non-empty string up to 80 characters");
      }
      if (this.containsMemorySecretShape(input.display_name)) {
        throw new Error("display_name must not contain credentials");
      }
      body.display_name = input.display_name.trim();
    }
    if (input.system_prompt !== undefined) {
      if (input.system_prompt !== null) {
        if (typeof input.system_prompt !== "string" || input.system_prompt.length > 16_000) {
          throw new Error("system_prompt must be null or a string up to 16000 characters");
        }
        if (this.containsMemorySecretShape(input.system_prompt)) {
          throw new Error("system_prompt must not contain credentials");
        }
      }
      body.system_prompt = input.system_prompt;
    }
    if (input.model !== undefined) {
      if (input.model !== null && (typeof input.model !== "string" || input.model.length > 120)) {
        throw new Error("model must be null or a string up to 120 characters");
      }
      body.model = input.model;
    }
    if (input.effort !== undefined) {
      if (input.effort !== null && (typeof input.effort !== "string" || input.effort.length > 32)) {
        throw new Error("effort must be null or a string up to 32 characters");
      }
      body.effort = input.effort;
    }
    if (input.capabilities !== undefined) {
      if (!Array.isArray(input.capabilities) || input.capabilities.length > 24) {
        throw new Error("capabilities must be an array of up to 24 tags");
      }
      body.capabilities = input.capabilities.map((raw) => {
        if (typeof raw !== "string") throw new Error("Capability tag must be a string");
        const tag = raw.trim();
        if (!tag || tag.length > 48 || /[\x00-\x1f\x7f]/.test(tag)) {
          throw new Error("Invalid capability tag");
        }
        if (this.containsMemorySecretShape(tag) || /^(?:ac_|sk[-_])/i.test(tag)) {
          throw new Error("Capability tag must not contain credentials");
        }
        return tag;
      });
    }
    let ifMatchHeader: string | undefined;
    if (input.if_match_updated_at !== undefined) {
      const ver = input.if_match_updated_at.trim();
      if (!ver || ver.length > 64 || /[\x00-\x1f\x7f"]/.test(ver)) {
        throw new Error("Invalid if_match_updated_at version");
      }
      body.if_match_updated_at = ver;
      ifMatchHeader = ver;
    }
    if (Object.keys(body).length === 0) {
      throw new Error("At least one tuning field is required");
    }
    return this.patch<import("./types").TuneCloudAgentResponse>(
      `/api/cloud-agents/${encodeURIComponent(safeAgent)}`,
      body,
      {
        "Cache-Control": "no-store",
        ...(this.authHeaders(input.bearerToken) ?? {}),
        ...(ifMatchHeader ? { "If-Match": ifMatchHeader } : {}),
      },
    );
  }

  async listCloudAgentMemories(
    agentId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").CloudAgentMemoryListResponse> {
    const safeAgent = this.assertCloudAgentId(agentId);
    return this.get<import("./types").CloudAgentMemoryListResponse>(
      `/api/cloud-agents/${encodeURIComponent(safeAgent)}/memory`,
      {
        Accept: "application/json",
        "Cache-Control": "no-store",
        ...(this.authHeaders(opts?.bearerToken) ?? {}),
      },
    );
  }

  async getCloudAgentMemory(
    agentId: string,
    name: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").CloudAgentMemoryDetailResponse> {
    const safeAgent = this.assertCloudAgentId(agentId);
    const safeName = this.assertMemorySlug(name);
    return this.get<import("./types").CloudAgentMemoryDetailResponse>(
      `/api/cloud-agents/${encodeURIComponent(safeAgent)}/memory/${encodeURIComponent(safeName)}`,
      {
        Accept: "application/json",
        "Cache-Control": "no-store",
        ...(this.authHeaders(opts?.bearerToken) ?? {}),
      },
    );
  }

  async getCloudAgentMemoryRevisions(
    agentId: string,
    name: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").AgentMemoryRevisionsResponse> {
    const safeAgent = this.assertCloudAgentId(agentId);
    const safeName = this.assertMemorySlug(name);
    return this.get<import("./types").AgentMemoryRevisionsResponse>(
      `/api/cloud-agents/${encodeURIComponent(safeAgent)}/memory/${encodeURIComponent(safeName)}/revisions`,
      {
        Accept: "application/json",
        "Cache-Control": "no-store",
        ...(this.authHeaders(opts?.bearerToken) ?? {}),
      },
    );
  }

  async saveCloudAgentMemory(
    agentId: string,
    name: string,
    input: import("./types").SaveAgentMemoryInput,
  ): Promise<import("./types").SaveCloudAgentMemoryResponse> {
    const safeAgent = this.assertCloudAgentId(agentId);
    const safeName = this.assertMemorySlug(name);
    if (typeof input?.body_markdown !== "string" || !input.body_markdown.trim()) {
      throw new Error("Memory body_markdown is required");
    }
    const byteLen = new TextEncoder().encode(input.body_markdown).byteLength;
    if (byteLen > 256_000) {
      throw new Error("Memory body_markdown exceeds 256000 UTF-8 bytes");
    }
    if (
      this.containsMemorySecretShape(input.body_markdown) ||
      (typeof input.description === "string" && this.containsMemorySecretShape(input.description))
    ) {
      throw new Error("Memory must not contain API keys, tokens, or private keys");
    }
    if (input.description !== undefined && (typeof input.description !== "string" || input.description.length > 280)) {
      throw new Error("Memory description must be a string up to 280 characters");
    }
    if (
      input.if_match_version !== undefined &&
      (!Number.isInteger(input.if_match_version) || input.if_match_version < 0 || input.if_match_version > 1_000_000)
    ) {
      throw new Error("Invalid memory if_match_version");
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}),
      ...(this.authHeaders(input.bearerToken) ?? {}),
      ...(input.if_match_version !== undefined ? { "If-Match": `"${input.if_match_version}"` } : {}),
    };
    const body: Record<string, unknown> = {
      body_markdown: input.body_markdown,
      ...(typeof input.description === "string" ? { description: input.description } : {}),
      ...(input.if_match_version !== undefined ? { if_match_version: input.if_match_version } : {}),
    };
    const res = await fetch(
      `${this.baseUrl}/api/cloud-agents/${encodeURIComponent(safeAgent)}/memory/${encodeURIComponent(safeName)}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    return res.json();
  }

  async deleteCloudAgentMemory(
    agentId: string,
    name: string,
    opts?: { if_match_version?: number; bearerToken?: string },
  ): Promise<import("./types").DeleteAgentMemoryResponse> {
    const safeAgent = this.assertCloudAgentId(agentId);
    const safeName = this.assertMemorySlug(name);
    if (
      opts?.if_match_version !== undefined &&
      (!Number.isInteger(opts.if_match_version) || opts.if_match_version < 1 || opts.if_match_version > 1_000_000)
    ) {
      throw new Error("Memory delete if_match_version must be an integer >= 1");
    }
    const qs = opts?.if_match_version !== undefined ? `?if_match_version=${opts.if_match_version}` : "";
    const headers: Record<string, string> = {
      "Cache-Control": "no-store",
      ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}),
      ...(this.authHeaders(opts?.bearerToken) ?? {}),
      ...(opts?.if_match_version !== undefined ? { "If-Match": `"${opts.if_match_version}"` } : {}),
    };
    const res = await fetch(
      `${this.baseUrl}/api/cloud-agents/${encodeURIComponent(safeAgent)}/memory/${encodeURIComponent(safeName)}${qs}`,
      {
        method: "DELETE",
        headers,
      },
    );
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    return res.json();
  }

  async recoverCloudAgent(
    agentId: string,
    input?: import("./types").RecoverCloudAgentInput,
  ): Promise<import("./types").RecoverCloudAgentResponse> {
    const safeAgent = this.assertCloudAgentId(agentId);
    const body: Record<string, unknown> = {};
    if (input?.gemini_api_key !== undefined) {
      if (typeof input.gemini_api_key !== "string" || !input.gemini_api_key.trim() || input.gemini_api_key.length > 512) {
        throw new Error("gemini_api_key must be a non-empty string up to 512 characters when provided");
      }
      body.gemini_api_key = input.gemini_api_key.trim();
    }
    return this.post<import("./types").RecoverCloudAgentResponse>(
      `/api/cloud-agents/${encodeURIComponent(safeAgent)}/recover`,
      body,
      {
        "Cache-Control": "no-store",
        ...(this.authHeaders(input?.bearerToken) ?? {}),
      },
    );
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

  private async patch<T = any>(
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
      method: "PATCH",
      headers: mergedHeaders,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    return res.json();
  }

  private async del<T = any>(
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
      method: "DELETE",
      headers: mergedHeaders,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    return res.json();
  }
}
