// AgentChat Protocol Types — matches iOS ACProtocol.swift and Server protocol.ts

export type SenderType = "agent" | "human";
export type ContentType = "text" | "code" | "proposal";
export type ChannelType = "direct" | "group" | "project";
export type ConsensusRule = "majority" | "super_majority" | "unanimous";
export type VoteDecision = "approve" | "reject" | "abstain";
export type AgentStatus = "online" | "offline" | "busy";
export type ChannelRole = "admin" | "moderator" | "member";
export type ReactionAction = "add" | "remove";
export type PinAction = "pin" | "unpin";

export interface ChatMessage {
  type: "message";
  id: string;
  channel_id: string;
  sender_id: string;
  sender_type: SenderType;
  content: string;
  content_type: ContentType;
  timestamp: string;
}

export interface AgentCard {
  agent_id: string;
  display_name: string;
  description?: string;
  capabilities: string[];
  reputation: number;
  status: AgentStatus;
}

export interface VoteResult {
  proposal_id: string;
  passed: boolean;
  approve_count: number;
  reject_count: number;
  abstain_count: number;
  total_voters: number;
}

export interface AgentPresence {
  type: "agent_online" | "agent_offline";
  agent_id: string;
  display_name: string;
  capabilities: string[];
}

export interface ClientOptions {
  url: string;
  agentId: string;
  token?: string;
  capabilities?: string[];
  heartbeatInterval?: number;
}

// New feature types

export interface ReactionUpdate {
  message_id: string;
  channel_id: string;
  reactions: Record<string, string[]>; // emoji → sender_ids
}

export interface PinUpdate {
  channel_id: string;
  pinned_messages: string[];
}

export interface ThreadReply {
  id: string;
  parent_id: string;
  channel_id: string;
  sender_id: string;
  sender_type: SenderType;
  content: string;
  timestamp: string;
}

export interface ThreadUpdate {
  parent_id: string;
  channel_id: string;
  reply_count: number;
  last_reply_at: string;
}

export interface MessageEdited {
  message_id: string;
  channel_id: string;
  new_content: string;
  edited_at: string;
}

export interface MessageDeleted {
  message_id: string;
  channel_id: string;
}

export interface ReadReceiptUpdate {
  channel_id: string;
  receipts: Record<string, string>; // agent_id → last_read_message_id
}

export interface RoleUpdate {
  channel_id: string;
  target_id: string;
  role: ChannelRole;
}

export interface AgentStatusUpdate {
  agent_id: string;
  status_text: string;
  status_emoji?: string;
}

// ============================================================
// Full Protocol Messages — matches Server protocol.ts & iOS ACProtocol.swift
// 48 message types total
// ============================================================

// Client → Server

export interface AuthMessage {
  type: "auth";
  agent_id: string;
  token: string;
  capabilities: string[];
}

export interface JoinChannelMessage {
  type: "join_channel";
  channel_id: string;
  agent_id: string;
}

export interface LeaveChannelMessage {
  type: "leave_channel";
  channel_id: string;
  agent_id: string;
}

export interface CreateChannelMessage {
  type: "create_channel";
  name: string;
  channel_type: ChannelType;
  members: string[];
  consensus_rule: ConsensusRule;
}

export interface ProposalMessage {
  type: "proposal";
  id: string;
  channel_id: string;
  sender_id: string;
  title: string;
  content: string;
  code_diff?: string;
  consensus_rule: ConsensusRule;
  expires_at: string;
  timestamp: string;
}

export interface VoteMessage {
  type: "vote";
  proposal_id: string;
  voter_id: string;
  voter_type: SenderType;
  decision: VoteDecision;
  reason?: string;
}

export interface TakeoverMessage {
  type: "takeover";
  channel_id: string;
  agent_id: string;
}

export interface HandbackMessage {
  type: "handback";
  channel_id: string;
  agent_id: string;
}

export interface DiscoverMessage {
  type: "discover";
  capabilities: string[];
  limit: number;
}

export interface PingMessage {
  type: "ping";
  timestamp: string;
}

export interface ReactionMessage {
  type: "reaction";
  message_id: string;
  channel_id: string;
  sender_id: string;
  emoji: string;
  action: ReactionAction;
  timestamp: string;
}

export interface PinMessage {
  type: "pin";
  message_id: string;
  channel_id: string;
  sender_id: string;
  action: PinAction;
}

export interface ThreadMessage {
  type: "thread_reply";
  id: string;
  parent_id: string;
  channel_id: string;
  sender_id: string;
  sender_type: SenderType;
  content: string;
  timestamp: string;
}

export interface EditMessageCmd {
  type: "edit_message";
  message_id: string;
  channel_id: string;
  sender_id: string;
  new_content: string;
  timestamp: string;
}

export interface DeleteMessageCmd {
  type: "delete_message";
  message_id: string;
  channel_id: string;
  sender_id: string;
}

export interface ReadReceiptMessage {
  type: "read_receipt";
  channel_id: string;
  sender_id: string;
  last_read_id: string;
  timestamp: string;
}

export interface SetRoleMessage {
  type: "set_role";
  channel_id: string;
  sender_id: string;
  target_id: string;
  role: ChannelRole;
}

export interface SetStatusMessage {
  type: "set_status";
  sender_id: string;
  status_text: string;
  status_emoji?: string;
}

export interface TypingMessage {
  type: "typing";
  channel_id: string;
  sender_id: string;
}

export interface ForwardMessage {
  type: "forward";
  id: string;
  source_channel_id: string;
  target_channel_id: string;
  message_id: string;
  sender_id: string;
  timestamp: string;
}

export interface ArchiveChannelMessage {
  type: "archive_channel";
  channel_id: string;
  sender_id: string;
}

export interface SetTopicMessage {
  type: "set_topic";
  channel_id: string;
  sender_id: string;
  topic: string;
}

// Server → Client

export interface AuthOKMessage {
  type: "auth_ok";
  agent_id: string;
  session_id: string;
}

export interface ChannelCreatedMessage {
  type: "channel_created";
  channel_id: string;
  name: string;
  channel_type: ChannelType;
}

export interface VoteResultMessage {
  type: "vote_result";
  proposal_id: string;
  passed: boolean;
  approve_count: number;
  reject_count: number;
  abstain_count: number;
  total_voters: number;
}

export interface DiscoverResultMessage {
  type: "discover_result";
  agents: AgentCard[];
}

export interface ErrorMessage {
  type: "error";
  code: number;
  message: string;
}

export interface PongMessage {
  type: "pong";
  timestamp: string;
}

export interface MessageAck {
  type: "message_ack";
  message_id: string;
  channel_id: string;
  delivered_to: number;
  timestamp: string;
}

export interface TopicUpdateMessage {
  type: "topic_update";
  channel_id: string;
  topic: string;
  set_by: string;
}

export interface ChannelArchivedMessage {
  type: "channel_archived";
  channel_id: string;
}

// V2: Raft Leader Election + DAG Task Collaboration

export type TaskStatus = "pending" | "assigned" | "in_progress" | "completed" | "failed";

export interface RequestVoteMessage {
  type: "request_vote";
  channel_id: string;
  candidate_id: string;
  term: number;
  timestamp: string;
}

export interface VoteGrantedMessage {
  type: "vote_granted";
  channel_id: string;
  voter_id: string;
  candidate_id: string;
  term: number;
}

export interface LeaderElectedMessage {
  type: "leader_elected";
  channel_id: string;
  leader_id: string;
  term: number;
}

export interface TaskNode {
  id: string;
  title: string;
  description: string;
  assigned_to?: string;
  depends_on: string[];
  status: TaskStatus;
  result?: string;
}

export interface CreateDAGMessage {
  type: "create_dag";
  channel_id: string;
  leader_id: string;
  goal: string;
  tasks: TaskNode[];
  timestamp: string;
}

export interface AssignTaskMessage {
  type: "assign_task";
  channel_id: string;
  leader_id: string;
  task_id: string;
  agent_id: string;
}

export interface TaskUpdateMessage {
  type: "task_update";
  channel_id: string;
  task_id: string;
  agent_id: string;
  status: TaskStatus;
  result?: string;
}

export interface TaskVerifiedMessage {
  type: "task_verified";
  channel_id: string;
  leader_id: string;
  task_id: string;
  accepted: boolean;
  feedback?: string;
}

/** Server → Client broadcast for agent_status (response to set_status) */
export interface AgentStatusBroadcast {
  type: "agent_status";
  agent_id: string;
  status_text: string;
  status_emoji?: string;
}

/** Union of all 48 protocol message types */
export type ACMessage =
  // Client → Server
  | AuthMessage
  | ChatMessage
  | JoinChannelMessage
  | LeaveChannelMessage
  | CreateChannelMessage
  | ProposalMessage
  | VoteMessage
  | TakeoverMessage
  | HandbackMessage
  | DiscoverMessage
  | PingMessage
  | ReactionMessage
  | PinMessage
  | ThreadMessage
  | EditMessageCmd
  | DeleteMessageCmd
  | ReadReceiptMessage
  | SetRoleMessage
  | SetStatusMessage
  | TypingMessage
  | ForwardMessage
  | ArchiveChannelMessage
  | SetTopicMessage
  // Server → Client
  | AuthOKMessage
  | ChannelCreatedMessage
  | VoteResultMessage
  | AgentPresence // agent_online + agent_offline
  | DiscoverResultMessage
  | ErrorMessage
  | PongMessage
  | MessageAck
  | ReactionUpdate
  | PinUpdate
  | ThreadUpdate
  | MessageEdited
  | MessageDeleted
  | ReadReceiptUpdate
  | RoleUpdate
  | AgentStatusBroadcast
  | TopicUpdateMessage
  | ChannelArchivedMessage
  // V2: Raft + DAG
  | RequestVoteMessage
  | VoteGrantedMessage
  | LeaderElectedMessage
  | CreateDAGMessage
  | AssignTaskMessage
  | TaskUpdateMessage
  | TaskVerifiedMessage;

// Handler types
export type MessageHandler = (msg: ChatMessage) => void | Promise<void>;
export type VoteResultHandler = (result: VoteResult) => void | Promise<void>;
export type PresenceHandler = (presence: AgentPresence) => void | Promise<void>;
export type ErrorHandler = (code: number, message: string) => void;
export type ReactionHandler = (update: ReactionUpdate) => void | Promise<void>;
export type ThreadHandler = (data: ThreadReply | ThreadUpdate) => void | Promise<void>;
export type EditHandler = (data: MessageEdited) => void | Promise<void>;
export type DeleteHandler = (data: MessageDeleted) => void | Promise<void>;
