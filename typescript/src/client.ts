// AgentsChat TypeScript SDK — WebSocket client

import type {
  AgentPresence,
  ChannelDocUpdatedHandler,
  ChannelDocUpdatedMessage,
  ChannelRole,
  ChatMessage,
  ClientOptions,
  ConsensusRule,
  ContentType,
  DeleteHandler,
  EditHandler,
  ErrorHandler,
  MessageDeleted,
  MessageEdited,
  MessageHandler,
  OkrThreadOpenedHandler,
  OkrThreadOpenedMessage,
  OkrUpdatedHandler,
  OkrUpdatedMessage,
  PinAction,
  PinUpdate,
  PinUpdateHandler,
  PresenceHandler,
  ProposalHandler,
  ProposalMessage,
  ReactionAction,
  ReactionHandler,
  ReactionUpdate,
  ReadReceiptHandler,
  ReadReceiptUpdate,
  ReconnectNeededHandler,
  SenderType,
  TaskAssignedHandler,
  TaskAssignedMessage,
  ThreadHandler,
  ThreadReply,
  ThreadUpdate,
  VoteDecision,
  VoteHandler,
  VoteMessage,
  VoteResult,
  VoteResultHandler,
} from "./types";

export class AgentChatClient {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  private messageHandlers: MessageHandler[] = [];
  private proposalHandlers: ProposalHandler[] = [];
  private voteHandlers: VoteHandler[] = [];
  private voteResultHandlers: VoteResultHandler[] = [];
  private presenceHandlers: PresenceHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private reactionHandlers: ReactionHandler[] = [];
  private pinUpdateHandlers: PinUpdateHandler[] = [];
  private readReceiptHandlers: ReadReceiptHandler[] = [];
  private threadHandlers: ThreadHandler[] = [];
  private editHandlers: EditHandler[] = [];
  private deleteHandlers: DeleteHandler[] = [];
  private okrUpdatedHandlers: OkrUpdatedHandler[] = [];
  private taskAssignedHandlers: TaskAssignedHandler[] = [];
  private okrThreadOpenedHandlers: OkrThreadOpenedHandler[] = [];
  private channelDocUpdatedHandlers: ChannelDocUpdatedHandler[] = [];
  private reconnectNeededHandlers: ReconnectNeededHandler[] = [];
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;
  private readonly wsFactory: (url: string) => WebSocket;

  readonly url: string;
  readonly agentId: string;
  readonly token: string;
  readonly capabilities: string[];
  readonly heartbeatInterval: number;
  readonly connectTimeoutMs: number;

  constructor(options: ClientOptions) {
    this.url = options.url;
    this.agentId = options.agentId;
    this.token = options.token ?? "dev-token";
    this.capabilities = options.capabilities ?? [];
    this.heartbeatInterval = options.heartbeatInterval ?? 30_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.wsFactory = options.wsFactory ?? ((url: string) => new WebSocket(url));
  }

  // MARK: - Connection

  connect(): Promise<void> {
    this.stopHeartbeat();
    this.stopConnectTimer();
    this.sessionId = null;
    if (this.ws) {
      const prev = this.ws;
      this.ws = null;
      try {
        prev.close();
      } catch {}
    }
    this.rejectConnect(new Error("WebSocket superseded by a new connect() call"));

    return new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      let socket: WebSocket;
      try {
        socket = this.wsFactory(this.url);
      } catch (err) {
        this.rejectConnect(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.ws = socket;
      if (this.connectTimeoutMs > 0) {
        this.connectTimer = setTimeout(() => {
          this.connectTimer = null;
          if (this.ws !== socket || this.sessionId !== null) return;
          this.ws = null;
          this.rejectConnect(new Error(`WebSocket connect timed out after ${this.connectTimeoutMs}ms`));
          try {
            socket.close();
          } catch {}
        }, this.connectTimeoutMs);
        (this.connectTimer as unknown as { unref?: () => void })?.unref?.();
      }
      socket.onopen = () => {
        if (this.ws !== socket) return;
        this.handleOpen();
      };
      socket.onmessage = (event) => {
        if (this.ws !== socket) return;
        this.handleMessage(String(event.data));
      };
      socket.onclose = () => {
        if (this.ws !== socket) return;
        this.handleClose();
      };
      socket.onerror = () => {
        if (this.ws !== socket) return;
        if (!this.sessionId) {
          this.stopHeartbeat();
          this.ws = null;
          this.rejectConnect(new Error("WebSocket error"));
          try {
            socket.close();
          } catch {}
        }
      };
    });
  }

  disconnect() {
    this.stopHeartbeat();
    this.stopConnectTimer();
    const prev = this.ws;
    this.ws = null;
    this.sessionId = null;
    this.rejectConnect(new Error("WebSocket disconnected"));
    try {
      prev?.close();
    } catch {}
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.sessionId !== null;
  }

  // MARK: - Messaging

  sendMessage(
    channelId: string,
    content: string,
    contentType: ContentType = "text",
    senderType: SenderType = "agent",
  ) {
    this.send({
      type: "message",
      id: crypto.randomUUID(),
      channel_id: channelId,
      sender_id: this.agentId,
      sender_type: senderType,
      content,
      content_type: contentType,
      timestamp: new Date().toISOString(),
    });
  }

  // MARK: - Channels

  joinChannel(channelId: string) {
    this.send({ type: "join_channel", channel_id: channelId, agent_id: this.agentId });
  }

  leaveChannel(channelId: string) {
    this.send({ type: "leave_channel", channel_id: channelId, agent_id: this.agentId });
  }

  createChannel(
    name: string,
    members?: string[],
    channelType: string = "group",
    consensusRule: ConsensusRule = "majority",
  ) {
    this.send({
      type: "create_channel",
      name,
      channel_type: channelType,
      members: members ?? [this.agentId],
      consensus_rule: consensusRule,
    });
  }

  // MARK: - Voting

  propose(
    channelId: string,
    title: string,
    content: string,
    consensusRule: ConsensusRule = "majority",
    codeDiff?: string,
  ): string {
    const proposalId = crypto.randomUUID();
    this.send({
      type: "proposal",
      id: proposalId,
      channel_id: channelId,
      sender_id: this.agentId,
      title,
      content,
      code_diff: codeDiff,
      consensus_rule: consensusRule,
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
      timestamp: new Date().toISOString(),
    });
    return proposalId;
  }

  vote(proposalId: string, decision: VoteDecision, reason?: string, senderType: SenderType = "agent") {
    this.send({
      type: "vote",
      proposal_id: proposalId,
      voter_id: this.agentId,
      voter_type: senderType,
      decision,
      reason,
    });
  }

  // MARK: - Discovery

  discover(capabilities: string[] = [], limit = 20) {
    this.send({ type: "discover", capabilities, limit });
  }

  // MARK: - Takeover

  takeover(channelId: string) {
    this.send({ type: "takeover", channel_id: channelId, agent_id: this.agentId });
  }

  handback(channelId: string) {
    this.send({ type: "handback", channel_id: channelId, agent_id: this.agentId });
  }

  // MARK: - Reactions

  react(channelId: string, messageId: string, emoji: string, action: ReactionAction = "add") {
    this.send({ type: "reaction", message_id: messageId, channel_id: channelId, sender_id: this.agentId, emoji, action, timestamp: new Date().toISOString() });
  }

  // MARK: - Pins

  pin(channelId: string, messageId: string, action: PinAction = "pin") {
    this.send({ type: "pin", message_id: messageId, channel_id: channelId, sender_id: this.agentId, action });
  }

  // MARK: - Thread Replies

  reply(channelId: string, parentId: string, content: string) {
    this.send({ type: "thread_reply", id: crypto.randomUUID(), parent_id: parentId, channel_id: channelId, sender_id: this.agentId, sender_type: "agent", content, timestamp: new Date().toISOString() });
  }

  // MARK: - Edit / Delete

  editMessage(channelId: string, messageId: string, newContent: string) {
    this.send({ type: "edit_message", message_id: messageId, channel_id: channelId, sender_id: this.agentId, new_content: newContent, timestamp: new Date().toISOString() });
  }

  deleteMessage(channelId: string, messageId: string) {
    this.send({ type: "delete_message", message_id: messageId, channel_id: channelId, sender_id: this.agentId });
  }

  // MARK: - Read Receipts

  markRead(channelId: string, lastReadId: string) {
    this.send({ type: "read_receipt", channel_id: channelId, sender_id: this.agentId, last_read_id: lastReadId, timestamp: new Date().toISOString() });
  }

  // MARK: - Roles

  setRole(channelId: string, targetId: string, role: ChannelRole) {
    this.send({ type: "set_role", channel_id: channelId, sender_id: this.agentId, target_id: targetId, role });
  }

  // MARK: - Status

  setStatus(statusText: string, statusEmoji?: string) {
    this.send({ type: "set_status", sender_id: this.agentId, status_text: statusText, status_emoji: statusEmoji });
  }

  // MARK: - Typing

  sendTyping(channelId: string) {
    this.send({ type: "typing", channel_id: channelId, sender_id: this.agentId });
  }

  // MARK: - Forward

  forward(sourceChannelId: string, targetChannelId: string, messageId: string) {
    this.send({ type: "forward", id: crypto.randomUUID(), source_channel_id: sourceChannelId, target_channel_id: targetChannelId, message_id: messageId, sender_id: this.agentId, timestamp: new Date().toISOString() });
  }

  // MARK: - Archive & Topic

  archiveChannel(channelId: string) {
    this.send({ type: "archive_channel", channel_id: channelId, sender_id: this.agentId });
  }

  setTopic(channelId: string, topic: string) {
    this.send({ type: "set_topic", channel_id: channelId, sender_id: this.agentId, topic });
  }

  // MARK: - Event Handlers

  onMessage(handler: MessageHandler) {
    this.messageHandlers.push(handler);
    return this;
  }

  onProposal(handler: ProposalHandler) {
    this.proposalHandlers.push(handler);
    return this;
  }

  onVote(handler: VoteHandler) {
    this.voteHandlers.push(handler);
    return this;
  }

  onVoteResult(handler: VoteResultHandler) {
    this.voteResultHandlers.push(handler);
    return this;
  }

  onPresence(handler: PresenceHandler) {
    this.presenceHandlers.push(handler);
    return this;
  }

  onError(handler: ErrorHandler) {
    this.errorHandlers.push(handler);
    return this;
  }

  onReaction(handler: ReactionHandler) {
    this.reactionHandlers.push(handler);
    return this;
  }

  onPinUpdate(handler: PinUpdateHandler) {
    this.pinUpdateHandlers.push(handler);
    return this;
  }

  onReadReceipt(handler: ReadReceiptHandler) {
    this.readReceiptHandlers.push(handler);
    return this;
  }

  onThread(handler: ThreadHandler) {
    this.threadHandlers.push(handler);
    return this;
  }

  onEdit(handler: EditHandler) {
    this.editHandlers.push(handler);
    return this;
  }

  onDelete(handler: DeleteHandler) {
    this.deleteHandlers.push(handler);
    return this;
  }

  onOkrUpdated(handler: OkrUpdatedHandler) {
    this.okrUpdatedHandlers.push(handler);
    return this;
  }

  onTaskAssigned(handler: TaskAssignedHandler) {
    this.taskAssignedHandlers.push(handler);
    return this;
  }

  onOkrThreadOpened(handler: OkrThreadOpenedHandler) {
    this.okrThreadOpenedHandlers.push(handler);
    return this;
  }

  onChannelDocUpdated(handler: ChannelDocUpdatedHandler) {
    this.channelDocUpdatedHandlers.push(handler);
    return this;
  }

  onReconnectNeeded(handler: ReconnectNeededHandler) {
    this.reconnectNeededHandlers.push(handler);
    return this;
  }

  // MARK: - Internal

  private handleOpen() {
    this.send({
      type: "auth",
      agent_id: this.agentId,
      token: this.token,
      capabilities: this.capabilities,
    });
  }

  private handleMessage(raw: string) {
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return;

    switch (data.type) {
      case "auth_ok":
        this.sessionId = typeof data.session_id === "string" && data.session_id ? data.session_id : "authenticated";
        this.startHeartbeat();
        this.resolveConnect();
        break;

      case "message": {
        const msg: ChatMessage = {
          type: "message",
          id: data.id,
          channel_id: data.channel_id,
          sender_id: data.sender_id,
          sender_type: data.sender_type,
          content: data.content,
          content_type: data.content_type,
          timestamp: data.timestamp,
        };
        this.invokeHandlers(this.messageHandlers, msg);
        break;
      }

      case "proposal": {
        const proposal: ProposalMessage = {
          type: "proposal",
          id: data.id,
          channel_id: data.channel_id,
          sender_id: data.sender_id,
          title: data.title ?? "",
          content: data.content ?? "",
          ...(data.code_diff !== undefined ? { code_diff: data.code_diff } : {}),
          consensus_rule: data.consensus_rule ?? "majority",
          ...(data.expires_at !== undefined ? { expires_at: data.expires_at } : {}),
          timestamp: data.timestamp ?? "",
        };
        this.invokeHandlers(this.proposalHandlers, proposal);
        break;
      }

      case "vote": {
        const vote: VoteMessage = {
          type: "vote",
          proposal_id: data.proposal_id,
          voter_id: data.voter_id,
          voter_type: data.voter_type ?? "agent",
          decision: data.decision,
          ...(data.reason !== undefined ? { reason: data.reason } : {}),
        };
        this.invokeHandlers(this.voteHandlers, vote);
        break;
      }

      case "vote_result": {
        const result: VoteResult = {
          proposal_id: data.proposal_id,
          passed: data.passed,
          approve_count: data.approve_count,
          reject_count: data.reject_count,
          abstain_count: data.abstain_count,
          total_voters: data.total_voters,
        };
        this.invokeHandlers(this.voteResultHandlers, result);
        break;
      }

      case "agent_online":
      case "agent_offline": {
        const agentIdStr = String(data.agent_id ?? "");
        const presence: AgentPresence = {
          type: data.type,
          agent_id: agentIdStr,
          display_name:
            typeof data.display_name === "string" && data.display_name
              ? data.display_name
              : agentIdStr,
          capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
        };
        this.invokeHandlers(this.presenceHandlers, presence);
        break;
      }

      case "auth_error": {
        const detail = String(data.message ?? data.reason ?? data.code ?? "unauthorized");
        const codeNum = typeof data.code === "number" ? data.code : 401;
        this.invokeHandlers(this.errorHandlers, codeNum, detail);
        this.stopHeartbeat();
        const prev = this.ws;
        this.ws = null;
        this.sessionId = null;
        this.rejectConnect(new Error(`Auth failed: ${detail}`));
        try {
          prev?.close();
        } catch {}
        break;
      }

      case "please_reconnect":
      case "shard_moved": {
        const targetUrl = typeof data.target_url === "string" && data.target_url ? data.target_url : undefined;
        this.stopHeartbeat();
        const prev = this.ws;
        this.ws = null;
        this.sessionId = null;
        this.rejectConnect(new Error(`Server requested reconnect (${data.type})`));
        this.invokeHandlers(this.reconnectNeededHandlers, {
          reason: data.type,
          ...(targetUrl ? { targetUrl } : {}),
        });
        try {
          prev?.close();
        } catch {}
        break;
      }

      case "error":
        this.invokeHandlers(this.errorHandlers, data.code, data.message);
        if (!this.sessionId) {
          const prev = this.ws;
          this.ws = null;
          this.rejectConnect(new Error(`Auth failed: ${data.message}`));
          try {
            prev?.close();
          } catch {}
        }
        break;

      case "reaction_update":
        this.invokeHandlers(this.reactionHandlers, data as ReactionUpdate);
        break;

      case "thread_reply": {
        const parentId = data.parent_id ?? data.thread_id;
        if (typeof parentId !== "string" || !parentId) break;
        this.invokeHandlers(this.threadHandlers, {
          ...(data as ThreadReply),
          parent_id: parentId,
        });
        break;
      }

      case "thread_update": {
        const parentId = data.parent_id ?? data.thread_id;
        if (typeof parentId !== "string" || !parentId) break;
        this.invokeHandlers(this.threadHandlers, {
          ...(data as ThreadUpdate),
          parent_id: parentId,
        });
        break;
      }

      case "message_edited":
        this.invokeHandlers(this.editHandlers, data as MessageEdited);
        break;

      case "message_deleted":
        this.invokeHandlers(this.deleteHandlers, data as MessageDeleted);
        break;

      case "okr_updated":
        this.invokeHandlers(this.okrUpdatedHandlers, data as OkrUpdatedMessage);
        break;

      case "task_assigned":
        this.invokeHandlers(this.taskAssignedHandlers, data as TaskAssignedMessage);
        break;

      case "okr_thread_opened":
        this.invokeHandlers(this.okrThreadOpenedHandlers, data as OkrThreadOpenedMessage);
        break;

      case "channel_doc_updated":
        this.invokeHandlers(this.channelDocUpdatedHandlers, data as ChannelDocUpdatedMessage);
        break;

      case "pin_update":
        this.invokeHandlers(this.pinUpdateHandlers, data as PinUpdate);
        break;

      case "read_receipt_update": {
        const receipts: Record<string, string> = {};
        if (data.receipts && typeof data.receipts === "object" && !Array.isArray(data.receipts)) {
          for (const [k, v] of Object.entries(data.receipts as Record<string, unknown>)) {
            if (
              typeof v === "string" &&
              k.trim() &&
              v.trim() &&
              k !== "__proto__" &&
              k !== "constructor" &&
              k !== "prototype"
            ) {
              receipts[k] = v;
            }
          }
        }
        const update: ReadReceiptUpdate = {
          type: "read_receipt_update",
          channel_id: String(data.channel_id ?? ""),
          receipts,
        };
        this.invokeHandlers(this.readReceiptHandlers, update);
        break;
      }

      case "pong":
      case "role_update":
      case "agent_status":
      case "typing":
        break; // handled by specific handlers if registered
    }
  }

  private invokeHandlers<T extends (...args: any[]) => unknown>(handlers: T[], ...args: Parameters<T>) {
    for (const h of [...handlers]) {
      try {
        const out = h(...args);
        if (out && typeof (out as Promise<unknown>).catch === "function") {
          (out as Promise<unknown>).catch(() => {});
        }
      } catch {}
    }
  }

  private stopConnectTimer() {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private resolveConnect() {
    this.stopConnectTimer();
    const resolve = this.connectResolve;
    this.connectResolve = null;
    this.connectReject = null;
    resolve?.();
  }

  private rejectConnect(err: Error) {
    this.stopConnectTimer();
    const reject = this.connectReject;
    this.connectResolve = null;
    this.connectReject = null;
    reject?.(err);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private handleClose() {
    this.stopHeartbeat();
    this.ws = null;
    const wasAuthenticated = this.sessionId !== null;
    this.sessionId = null;
    if (!wasAuthenticated) {
      this.rejectConnect(new Error("WebSocket closed before authentication"));
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "ping", timestamp: new Date().toISOString() });
    }, this.heartbeatInterval);
    (this.heartbeatTimer as unknown as { unref?: () => void })?.unref?.();
  }

  private send(data: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }
}
