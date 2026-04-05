// AgentChat TypeScript SDK — WebSocket client

import type {
  AgentPresence,
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
  PinAction,
  PresenceHandler,
  ReactionAction,
  ReactionHandler,
  ReactionUpdate,
  SenderType,
  ThreadHandler,
  ThreadReply,
  ThreadUpdate,
  VoteDecision,
  VoteResult,
  VoteResultHandler,
} from "./types";

export class AgentChatClient {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private messageHandlers: MessageHandler[] = [];
  private voteResultHandlers: VoteResultHandler[] = [];
  private presenceHandlers: PresenceHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private reactionHandlers: ReactionHandler[] = [];
  private threadHandlers: ThreadHandler[] = [];
  private editHandlers: EditHandler[] = [];
  private deleteHandlers: DeleteHandler[] = [];
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;

  readonly url: string;
  readonly agentId: string;
  readonly token: string;
  readonly capabilities: string[];
  readonly heartbeatInterval: number;

  constructor(options: ClientOptions) {
    this.url = options.url;
    this.agentId = options.agentId;
    this.token = options.token ?? "dev-token";
    this.capabilities = options.capabilities ?? [];
    this.heartbeatInterval = options.heartbeatInterval ?? 30_000;
  }

  // MARK: - Connection

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => this.handleOpen();
      this.ws.onmessage = (event) => this.handleMessage(String(event.data));
      this.ws.onclose = () => this.handleClose();
      this.ws.onerror = (event) => reject(new Error("WebSocket error"));
    });
  }

  disconnect() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.sessionId = null;
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
    const data = JSON.parse(raw);

    switch (data.type) {
      case "auth_ok":
        this.sessionId = data.session_id;
        this.startHeartbeat();
        this.connectResolve?.();
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
        for (const h of this.messageHandlers) h(msg);
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
        for (const h of this.voteResultHandlers) h(result);
        break;
      }

      case "agent_online":
      case "agent_offline": {
        const presence: AgentPresence = {
          type: data.type,
          agent_id: data.agent_id,
          display_name: data.display_name,
          capabilities: data.capabilities,
        };
        for (const h of this.presenceHandlers) h(presence);
        break;
      }

      case "error":
        for (const h of this.errorHandlers) h(data.code, data.message);
        if (this.connectReject && !this.sessionId) {
          this.connectReject(new Error(`Auth failed: ${data.message}`));
        }
        break;

      case "reaction_update":
        for (const h of this.reactionHandlers) h(data as ReactionUpdate);
        break;

      case "thread_reply":
        for (const h of this.threadHandlers) h(data as ThreadReply);
        break;

      case "thread_update":
        for (const h of this.threadHandlers) h(data as ThreadUpdate);
        break;

      case "message_edited":
        for (const h of this.editHandlers) h(data as MessageEdited);
        break;

      case "message_deleted":
        for (const h of this.deleteHandlers) h(data as MessageDeleted);
        break;

      case "pong":
      case "pin_update":
      case "read_receipt_update":
      case "role_update":
      case "agent_status":
      case "typing":
        break; // handled by specific handlers if registered
    }
  }

  private handleClose() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "ping", timestamp: new Date().toISOString() });
    }, this.heartbeatInterval);
  }

  private send(data: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }
}
