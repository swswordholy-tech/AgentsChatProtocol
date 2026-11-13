// AgentsChat Protocol types — matches iOS ACProtocol.swift and Server protocol.ts

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
  type?: "pin_update";
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
  type?: "read_receipt_update";
  channel_id: string;
  receipts: Record<string, string>; // principal_or_redacted_id → last_read_message_id
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
  expires_at?: string;
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

export type ChannelDocKind =
  | "topic"
  | "rules"
  | "roles"
  | "context"
  | "deep_dive"
  | "skill"
  | "channel_skill"
  | "rule"
  | "plan"
  | "decision";
export type ChannelDocLevel = 1 | 2 | 3 | 4;

export interface OkrUpdatedMessage {
  type: "okr_updated";
  kind: string;
  objective_id: string;
  channel_id?: string;
  discussion_channel_id?: string;
  task_id?: string;
  kr_id?: string;
  updated_kr_ids?: string[];
  title?: string;
  status?: string;
  owner?: string;
  actor_id?: string;
  from?: string;
  to?: string;
  parent_id?: string | null;
  auto?: boolean;
}

export interface TaskAssignedMessage {
  type: "task_assigned";
  task_id: string;
  objective_id: string;
  title: string;
  assignee: string;
  channel_id?: string;
  discussion_channel_id?: string;
}

export interface ChannelDocUpdatedMessage {
  type: "channel_doc_updated";
  channel_id: string;
  doc_id: string;
  title: string;
  kind: ChannelDocKind;
  level: 1 | 2 | 3 | 4;
  version: number;
  archived: boolean;
  updated_at: string;
  updated_by: string;
}

/** Union of all protocol message types */
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
  // V2: Raft + DAG + Realtime Collaboration
  | RequestVoteMessage
  | VoteGrantedMessage
  | LeaderElectedMessage
  | CreateDAGMessage
  | AssignTaskMessage
  | TaskUpdateMessage
  | TaskVerifiedMessage
  | OkrUpdatedMessage
  | TaskAssignedMessage
  | ChannelDocUpdatedMessage;

// Handler types
export type MessageHandler = (msg: ChatMessage) => void | Promise<void>;
export type ProposalHandler = (proposal: ProposalMessage) => void | Promise<void>;
export type VoteHandler = (vote: VoteMessage) => void | Promise<void>;
export type VoteResultHandler = (result: VoteResult) => void | Promise<void>;
export type PresenceHandler = (presence: AgentPresence) => void | Promise<void>;
export type ErrorHandler = (code: number, message: string) => void;
export type ReactionHandler = (update: ReactionUpdate) => void | Promise<void>;
export type PinUpdateHandler = (update: PinUpdate) => void | Promise<void>;
export type ReadReceiptHandler = (update: ReadReceiptUpdate) => void | Promise<void>;
export type ThreadHandler = (data: ThreadReply | ThreadUpdate) => void | Promise<void>;
export type EditHandler = (data: MessageEdited) => void | Promise<void>;
export type DeleteHandler = (data: MessageDeleted) => void | Promise<void>;
export type OkrUpdatedHandler = (data: OkrUpdatedMessage) => void | Promise<void>;
export type TaskAssignedHandler = (data: TaskAssignedMessage) => void | Promise<void>;
export type ChannelDocUpdatedHandler = (data: ChannelDocUpdatedMessage) => void | Promise<void>;

export interface StreamChannelEventsOptions {
  signal?: AbortSignal;
  bearerToken?: string;
  onEvent: (event: Record<string, unknown>) => void | Promise<void>;
}

// MARK: - Owner-Scoped Forensic Security Audit Types

export type CloudAgentAuditResult = "ok" | "denied" | "error";
export type CloudAgentCredentialKind = "oauth_delegate" | "agent_key" | "unknown";

export interface CloudAgentAuditEntry {
  id: string;
  ts: string;
  actor: string;
  target: string;
  channel: string;
  method: string;
  path: string;
  status: number;
  result: CloudAgentAuditResult;
  action?: string;
  tool?: string;
  credential_kind?: CloudAgentCredentialKind;
  reason?: string;
}

export interface CloudAgentAuditFeed {
  agent_id: string;
  observation_only: true;
  entries: CloudAgentAuditEntry[];
}

// MARK: - Room-Scoped Cloud Agent Wake-Health Observation Types

export type CloudCliWakeStatus = "ok" | "auth_required" | "timeout" | "error";

export interface ChannelWakeHealthCounts {
  total_cloud_agents: number;
  ok: number;
  auth_required: number;
  timeout: number;
  error: number;
  unobserved: number;
}

export interface ChannelWakeHealthAgent {
  agent_id: string;
  name?: string;
  runtime: string;
  cloud_status: string;
  last_wake_status?: CloudCliWakeStatus;
  last_wake_at?: string;
  last_duration_ms?: number;
}

export interface ChannelWakeHealth {
  channel_id: string;
  observation_only: true;
  counts: ChannelWakeHealthCounts;
  agents: ChannelWakeHealthAgent[];
}

// MARK: - Room & Caller Autonomous Loop Schedule Types

export type RoomLoopMode = "prompt" | "okr_wake" | "okr_watch";
export type RoomLoopStatus = "active" | "paused";

export interface RoomLoopScheduleItem {
  loop_id: string;
  agent_id?: string;
  channel_id?: string;
  can_manage?: boolean;
  prompt: string;
  interval_ms: number;
  next_tick_ms: number;
  last_tick_at: number | null;
  created_at: number;
  expires_at?: number | null;
  status: RoomLoopStatus;
  mode?: RoomLoopMode;
  objective_id?: string | null;
  target_agents?: string[];
  watch_idle?: boolean;
  watch_supply?: boolean;
  stall_minutes?: number;
}

export interface RoomLoopsFeed {
  loops: RoomLoopScheduleItem[];
  total: number;
}

// MARK: - Single-RTT Room Capability & Readiness Brief (/api/channels/:id/brief)

export interface ChannelWakeHealthSummary {
  observation_only: true;
  counts: ChannelWakeHealthCounts;
  attention_agents: ChannelWakeHealthAgent[];
}

export interface ChannelBriefPeer {
  id: string;
  name?: string;
  capabilities?: string[];
  online?: boolean;
}

export interface ChannelBriefDocItem {
  id: string;
  title: string;
  kind: string;
  level: number;
  body_summary?: string;
  version?: number;
  updated_at?: string;
  updated_by?: string;
  archived?: boolean;
  skill_meta?: {
    name?: string;
    description?: string;
    trigger?: string;
    argument_hint?: string;
  };
}

export interface ChannelBriefSkillsSummary {
  channel_skills: Array<{
    doc_id: string;
    skill_meta: NonNullable<ChannelBriefDocItem["skill_meta"]>;
    version?: number;
    load_hint: string;
  }>;
  personal_skills: Array<{
    name: string;
    skill_meta: NonNullable<ChannelBriefDocItem["skill_meta"]>;
    version?: number;
    load_hint: string;
  }>;
}

export interface ChannelBriefOkrSummary {
  active_objective_count: number;
  total_task_count: number;
  ready_for_me_count: number;
  doing_for_me_count?: number;
  blocked_for_me_count?: number;
  ready_task_count?: number;
  doing_task_count?: number;
  blocked_task_count?: number;
}

export interface ChannelBriefLoopSummary {
  active_loop_count: number;
  my_active_loop_count: number;
  okr_wake_objective_ids: string[];
  okr_watch_objective_ids: string[];
  unarmed_objective_ids: string[];
}

export interface ChannelBrief {
  channel_id: string;
  channel: {
    id: string;
    name?: string;
    type?: string;
    topic?: string;
    consensus_rule?: string;
    archived?: boolean;
    member_count?: number;
  } | null;
  agents: ChannelBriefPeer[];
  docs_summary?: ChannelBriefDocItem[];
  skills_summary?: ChannelBriefSkillsSummary;
  personal_skills_unavailable?: boolean;
  okr_summary?: ChannelBriefOkrSummary;
  loop_summary?: ChannelBriefLoopSummary | null;
  wake_health_summary?: ChannelWakeHealthSummary | null;
}

// MARK: - Workspace Graph (/api/workspace/graph)

export type WorkspaceGraphScopeType = "channel" | "objective" | "agent";

export type WorkspaceGraphNodeType =
  | "channel"
  | "objective"
  | "key_result"
  | "task"
  | "channel_doc"
  | "agent";

export type WorkspaceGraphEdgeType =
  | "contains"
  | "depends_on"
  | "references"
  | "implements"
  | "evidence_for"
  | "decision_for"
  | "source_of"
  | "supersedes"
  | "anchored_to"
  | "owned_by";

export interface WorkspaceGraphNode {
  type: WorkspaceGraphNodeType;
  id: string;
  title?: string;
  status?: string;
  level?: number;
  kind?: string;
  owner?: string;
  parent_id?: string;
  ready?: boolean;
  evidence_count?: number;
}

export interface WorkspaceGraphEdge {
  from: [WorkspaceGraphNodeType, string];
  to: [WorkspaceGraphNodeType, string];
  type: WorkspaceGraphEdgeType;
}

export interface WorkspaceGraphSection {
  id: "okr" | "docs" | "dag" | (string & {});
  title: string;
  summary: Record<string, number>;
  node_keys?: Array<[WorkspaceGraphNodeType, string]>;
  edge_types?: WorkspaceGraphEdgeType[];
}

export interface WorkspaceGraph {
  scope: { type: WorkspaceGraphScopeType; id: string };
  nodes: WorkspaceGraphNode[];
  edges: WorkspaceGraphEdge[];
  sections: WorkspaceGraphSection[];
  as_of?: string;
  since?: string;
  referenced_unchanged_ids?: string[];
  note?: string;
}

// MARK: - Room Consensus Proposals (/api/channels/:id/proposals)

export type ChannelProposalStatus = "pending" | "passed" | "rejected" | "expired";

export interface ChannelProposalVoteItem {
  voter_id: string;
  voter_type?: SenderType;
  decision: VoteDecision;
  reason?: string;
  created_at?: string;
}

export interface ChannelProposalVoteSummary {
  passed: boolean;
  is_complete?: boolean;
  approve_count: number;
  reject_count: number;
  abstain_count: number;
  total_voters: number;
}

export interface ChannelProposalItem {
  id: string;
  channel_id: string;
  sender_id: string;
  title: string;
  content: string;
  code_diff?: string;
  consensus_rule: ConsensusRule;
  expires_at?: string;
  timestamp: string;
  status: ChannelProposalStatus;
  total_voters: number;
  votes: ChannelProposalVoteItem[];
  vote_result: ChannelProposalVoteSummary;
}

export interface ChannelProposalsFeed {
  channel_id: string;
  proposals: ChannelProposalItem[];
}

export interface CreateChannelProposalInput {
  id?: string;
  sender_id?: string;
  title: string;
  content?: string;
  code_diff?: string;
  consensus_rule?: ConsensusRule;
  expires_at?: string;
}

export interface CreateChannelProposalResponse {
  ok?: boolean;
  proposal: ChannelProposalItem;
}

export interface VoteChannelProposalInput {
  voter_id?: string;
  decision: VoteDecision;
  reason?: string;
}

export interface VoteChannelProposalResponse {
  ok?: boolean;
  proposal_id: string;
  status?: ChannelProposalStatus;
  vote_result: ChannelProposalVoteSummary;
}

export interface DiscoverableChannelSummary {
  id: string;
  name?: string;
  type?: ChannelType;
  member_count?: number;
  online_agent_count?: number;
  capabilities?: string[];
  topic?: string;
  created_at?: string | number;
}

export interface ChannelPinsResponse {
  channel_id: string;
  pinned_messages: string[];
}

// MARK: - Personal Skills Library (/api/skills) & Room Loop Governance (/api/loops)

export interface PersonalSkillMeta {
  name: string;
  description: string;
  trigger?: string;
}

export interface PersonalSkillSummary {
  name: string;
  title?: string;
  description?: string;
  skill_meta?: PersonalSkillMeta;
  version: number;
  archived?: boolean;
  updated_at?: string;
}

export interface PersonalSkillDetail extends PersonalSkillSummary {
  body_markdown: string;
}

export interface PersonalSkillsListResponse {
  skills: PersonalSkillSummary[];
}

export interface PersonalSkillRevision {
  version: number;
  title?: string;
  description?: string;
  body_markdown: string;
  updated_at?: string;
}

export interface PersonalSkillRevisionsResponse {
  name?: string;
  revisions: PersonalSkillRevision[];
}

export interface SavePersonalSkillInput {
  body_markdown: string;
  if_match_version?: number;
}

export interface SavePersonalSkillResponse {
  ok?: boolean;
  name: string;
  version: number;
  archived?: boolean;
}

export interface ArchivePersonalSkillResponse {
  ok?: boolean;
  name?: string;
  version: number;
  archived: true;
}

export interface CreateRoomLoopInput {
  channel_id: string;
  mode?: RoomLoopMode;
  interval?: string;
  interval_ms?: number;
  prompt?: string;
  objective_id?: string;
  target_agent_id?: string;
  target_agents?: string[];
  watch_idle?: boolean;
  watch_supply?: boolean;
  stall_minutes?: number;
}

export interface RoomLoopMutationResponse {
  ok?: boolean;
  loop?: RoomLoopScheduleItem;
  loop_id?: string;
  status?: RoomLoopStatus | "stopped";
}

// MARK: - OKR Structured Working Memory Governance (/api/okr)

export type OkrHorizon = "week" | "month" | "Q";
export type OkrObjectiveStatus = "active" | "done" | "abandoned";
export type OkrMetricType = "count" | "bool" | "percent";
export type OkrRiskLevel = "green" | "yellow" | "red";
export type OkrTaskStatus = "todo" | "doing" | "done" | "blocked";
export type OkrListView = "mine-active" | "blocking-me" | "blocked-by-me" | "related";

export interface OkrChannelDocRef {
  channel_id: string;
  doc_id: string;
}

export interface OkrTaskCommentItem {
  id: string;
  author: string;
  text: string;
  at: string;
}

export interface OkrTaskItem {
  id: string;
  objective_id: string;
  title: string;
  assignee: string;
  status: OkrTaskStatus;
  due?: string | null;
  blocked_reason?: string | null;
  blocker_agent?: string | null;
  contributes_to?: string[] | null;
  depends_on?: string[] | null;
  linked_docs?: string[];
  linked_channel_docs?: OkrChannelDocRef[];
  evidence?: string[];
  comments?: OkrTaskCommentItem[];
  discussion_channel_id?: string;
  created_at?: string;
  updated_at?: string;
  last_progress_at?: string;
}

export interface OkrKeyResultItem {
  id: string;
  objective_id: string;
  title: string;
  metric_type: OkrMetricType;
  current: number;
  target: number;
  risk_level?: OkrRiskLevel;
  linked_docs?: string[];
  linked_channel_docs?: OkrChannelDocRef[];
  discussion_channel_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface OkrObjectiveItem {
  id: string;
  title: string;
  owner: string;
  horizon: OkrHorizon;
  status: OkrObjectiveStatus;
  due?: string | null;
  parent_id?: string | null;
  discussion_channel_id?: string;
  narrative?: string;
  archived?: boolean;
  archived_at?: string;
  completion_summary?: string;
  created_at?: string;
  updated_at?: string;
  key_results?: OkrKeyResultItem[];
  tasks?: OkrTaskItem[];
}

export interface OkrListQuery {
  horizon?: OkrHorizon;
  status?: OkrObjectiveStatus;
  owner?: string;
  include_archived?: boolean;
  objective_id?: string;
  view?: OkrListView;
  task_id?: string;
  shape?: "summary";
  bearerToken?: string;
}

export interface OkrListResponse {
  objectives: OkrObjectiveItem[];
}

export interface CreateOkrObjectiveInput {
  title: string;
  horizon: OkrHorizon;
  owner?: string;
  due?: string;
  parent_id?: string;
  discussion_channel_id?: string;
  narrative?: string;
}

export interface UpdateOkrObjectiveInput {
  title?: string;
  horizon?: OkrHorizon;
  status?: OkrObjectiveStatus;
  due?: string | null;
  narrative?: string | null;
  if_match_updated_at?: string;
}

export interface ReparentOkrObjectiveInput {
  parent_id: string | null;
  if_match_updated_at?: string;
}

export interface ArchiveOkrObjectiveInput {
  completion_summary?: string;
}

export interface CreateOkrKrInput {
  title: string;
  metric_type: OkrMetricType;
  target: number;
  current?: number;
  risk_level?: OkrRiskLevel;
}

export interface UpdateOkrKrInput {
  title?: string;
  metric_type?: OkrMetricType;
  target?: number;
  current?: number;
  risk_level?: OkrRiskLevel;
  if_match_updated_at?: string;
}

export interface UpdateOkrKrProgressInput {
  current: number;
  risk_level?: OkrRiskLevel;
  if_match_updated_at?: string;
}

export interface CreateOkrTaskInput {
  title: string;
  assignee: string;
  due?: string;
  contributes_to?: string[];
  depends_on?: string[];
  linked_channel_docs?: OkrChannelDocRef[];
}

export interface UpdateOkrTaskInput {
  title?: string;
  status?: OkrTaskStatus;
  assignee?: string;
  due?: string | null;
  blocked_reason?: string | null;
  blocker_agent?: string | null;
  contributes_to?: string[];
  depends_on?: string[];
  linked_channel_docs?: OkrChannelDocRef[];
  append_evidence?: string;
  if_match_updated_at?: string;
}

// MARK: - Channel Docs CAS & Revision History (/api/channels/:id/docs) & Key Rotation

export interface ChannelDocRevisionItem {
  version: number;
  title: string;
  kind: ChannelDocKind;
  level: ChannelDocLevel;
  bodyMarkdown: string;
  updatedAt: string;
  updatedBy: string;
}

export interface ChannelDocSummaryItem {
  id: string;
  title: string;
  kind: ChannelDocKind;
  level: ChannelDocLevel;
  bodySummary: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
  archived?: boolean;
  skill_meta?: {
    name?: string;
    description?: string;
    trigger?: string;
    argument_hint?: string;
  };
}

export interface ChannelDocBacklinkItem {
  type: string;
  id: string;
  title: string;
  relation: string;
}

export interface ChannelDocDetailItem extends ChannelDocSummaryItem {
  bodyMarkdown: string;
  revisions?: ChannelDocRevisionItem[];
  backlinks?: ChannelDocBacklinkItem[];
}

export interface ChannelDocsListResponse {
  channel_id: string;
  docs: ChannelDocSummaryItem[];
}

export interface ChannelDocRevisionsResponse {
  revisions: ChannelDocRevisionItem[];
}

export interface SaveChannelDocInput {
  title: string;
  kind: ChannelDocKind;
  level: ChannelDocLevel;
  body_markdown: string;
  if_match_version: number;
}

export interface ArchiveChannelDocResponse {
  archived: true;
  version?: number;
}

export interface RotateAgentKeyResponse {
  ok: boolean;
  agent_id: string;
  key: string;
}

export interface ChannelThreadSummaryItem {
  parent_id: string;
  reply_count: number;
  last_reply_at: string;
}

export interface ChannelThreadsResponse {
  channel_id: string;
  threads: ChannelThreadSummaryItem[];
}

export interface ChannelOkrSnapshotResponse {
  channel_id: string;
  objectives: OkrObjectiveItem[];
  krs: OkrKeyResultItem[];
  tasks: OkrTaskItem[];
  include_archived?: boolean;
  loops?: RoomLoopScheduleItem[];
  note?: string;
}

// MARK: - Machine-Readable A2A / MCP Capability Discovery & Room Membership

export interface A2AAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface A2AAgentCard {
  name: string;
  alternateName?: string;
  description: string;
  url: string;
  endpoint: string;
  mcpEndpoint: string;
  documentationUrl: string;
  quickstartUrl: string;
  cloudStudioUrl?: string;
  llmsTxtUrl?: string;
  llmsFullTxtUrl?: string;
  answersFeedUrl?: string;
  version: string;
  protocolVersion: string;
  build?: string;
  provider?: {
    organization: string;
    url: string;
  };
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
  };
  skills: A2AAgentSkill[];
}

export interface McpDiscoveryRemote {
  transportType: string;
  url: string;
  oauthProtectedResource?: string;
  oauthAuthorizationServer?: string;
  toolCount?: number;
}

export interface McpDiscoveryToolSummary {
  name: string;
  readOnly: boolean;
}

export interface McpDiscoveryPackage {
  registryType: string;
  identifier: string;
  transport: { type: string };
}

export interface McpDiscoveryCard {
  name: string;
  title: string;
  description: string;
  version: string;
  build?: string;
  homepage: string;
  documentationUrl: string;
  quickstartUrl: string;
  onboardingGuideUrl?: string;
  llmsTxtUrl?: string;
  llmsFullTxtUrl?: string;
  remotes: McpDiscoveryRemote[];
  tools: McpDiscoveryToolSummary[];
  packages?: McpDiscoveryPackage[];
}

export interface UpdateAgentCapabilitiesResponse {
  id: string;
  name?: string;
  display_name?: string;
  capabilities: string[];
  online?: boolean;
}

export interface ChannelMemberRosterItem {
  agent_id: string;
  online: boolean;
  role: string;
  display_name: string | null;
  avatar_url?: string | null;
}

export interface ChannelMembersResponse {
  members: ChannelMemberRosterItem[];
  source?: "hub" | "store" | string;
  coordinator_agent_id?: string | null;
  same_owner_direct?: boolean;
}

export interface ChannelJoinResponse {
  ok: boolean;
  channel_id: string;
  name: string;
}

export interface ChannelLeaveResponse {
  ok: boolean;
  channel_id: string;
  left: string;
  was_member: boolean;
}

export interface ChannelDetailResponse {
  id: string;
  name: string;
  type: ChannelType | string;
  visibility: "public" | "private" | "invite-only" | string;
  topic: string;
  member_count: number;
  members?: string[];
  roles?: Record<string, string>;
  created_by: string;
  created_at: string;
}

// MARK: - Room Invites & Private Join-Request Governance

export type ChannelInviteAction = "accept" | "reject" | "cancel";
export type ChannelJoinRequestAction = "approve" | "reject";

export interface ChannelInviteMutationResponse {
  ok: boolean;
  status?: "pending" | "accepted";
  auto_accepted?: boolean;
  channel_id?: string;
  target_id?: string;
}

export interface ChannelOutgoingInviteItem {
  target_id: string;
  invited_by: string;
  created_at: string;
}

export interface ChannelOutgoingInvitesResponse {
  invites: ChannelOutgoingInviteItem[];
}

export interface AccountIncomingInviteItem {
  target_id: string;
  channel_id: string;
  channel_name: string;
  invited_by: string;
  created_at: string;
}

export interface AccountIncomingInvitesResponse {
  invites: AccountIncomingInviteItem[];
}

export interface RequestChannelJoinInput {
  message?: string;
  proxy_agent_id?: string;
  bearerToken?: string;
}

export interface RequestChannelJoinResponse {
  ok: boolean;
  status: "pending" | string;
  proxy_agent_id?: string;
}

export interface ChannelJoinRequestItem {
  account_id: string;
  name: string;
  avatar_url: string | null;
  message: string;
  created_at: string;
  proxy_agent_id?: string;
  owner_id?: string;
  owner_name?: string;
  owner_avatar_url?: string | null;
}

export interface ManagedChannelJoinRequestItem extends ChannelJoinRequestItem {
  channel_id: string;
  channel_name: string;
}

export interface ChannelJoinRequestsResponse {
  requests: ChannelJoinRequestItem[];
}

export interface ManagedChannelJoinRequestsResponse {
  requests: ManagedChannelJoinRequestItem[];
}

// MARK: - Persistent Agent Working Memory (/api/memory) & Cloud Room Lifecycle

export interface AgentMemorySummaryItem {
  name: string;
  description: string;
  version: number;
  bytes: number;
  updated_at: string;
}

export interface AgentMemoryListResponse {
  agent_id: string;
  memories: AgentMemorySummaryItem[];
}

export interface AgentMemoryDetailItem extends AgentMemorySummaryItem {
  body_markdown: string;
}

export interface AgentMemoryRevisionItem {
  version: number;
  description: string;
  bytes: number;
  body_markdown: string;
  updated_at: string;
}

export interface AgentMemoryRevisionsResponse {
  name: string;
  revisions: AgentMemoryRevisionItem[];
  revisions_truncated?: true;
}

export interface SaveAgentMemoryInput {
  body_markdown: string;
  description?: string;
  if_match_version?: number;
  bearerToken?: string;
}

export interface SaveAgentMemoryResponse extends AgentMemorySummaryItem {
  ok: boolean;
  agent_id: string;
  created: boolean;
  load?: string;
}

export interface DeleteAgentMemoryResponse {
  ok: boolean;
  agent_id: string;
  name: string;
  deleted: boolean;
}

export interface CloudAgentChannelMutationResponse {
  ok: boolean;
  already_member?: boolean;
  already_left?: boolean;
  channel_id: string;
  channel_name?: string;
  agent?: Record<string, unknown>;
}

export interface WakeCloudAgentInput {
  channel_id?: string;
  prompt?: string;
  bearerToken?: string;
}

export interface WakeCloudAgentResponse {
  ok: boolean;
  [key: string]: unknown;
}

export interface CloudAgentLoopSummary {
  active_count: number;
  paused_count: number;
  total_count: number;
  okr_wake_count?: number;
  okr_watch_count?: number;
}

export interface CloudAgentMemorySummary {
  note_count: number;
  total_bytes: number;
  updated_at?: string | null;
}

export interface CloudAgentSummaryItem {
  agent_id: string;
  display_name?: string;
  is_host?: boolean;
  status?: string;
  runtime_type?: string;
  harness?: string;
  model?: string | null;
  effort?: string | null;
  auth_mode?: string;
  capabilities?: string[];
  channels?: string[];
  host_environment_id?: string | null;
  parent_agent_id?: string | null;
  updated_at?: string;
  loop_summary?: CloudAgentLoopSummary;
  memory_summary?: CloudAgentMemorySummary;
  okr_summary?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface CloudAgentsListQuery {
  host_environment_id?: string;
  parent_agent_id?: string;
  bearerToken?: string;
}

export interface CloudAgentsListResponse {
  agents: CloudAgentSummaryItem[];
  catalog?: unknown[];
  sandbox_enabled?: boolean;
  sandbox_subscription_runtimes?: string[];
  persistence_notice?: string | null;
}

export interface CloudAgentMemoryListResponse {
  agent_id: string;
  memories: AgentMemorySummaryItem[];
  max_docs?: number;
  max_body_bytes?: number;
}

export interface CloudAgentMemoryDetailResponse {
  agent_id: string;
  memory: AgentMemoryDetailItem;
}

export interface SaveCloudAgentMemoryResponse {
  ok: boolean;
  agent_id: string;
  created: boolean;
  memory: AgentMemoryDetailItem;
}

export interface TuneCloudAgentInput {
  display_name?: string;
  system_prompt?: string | null;
  model?: string | null;
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | (string & {}) | null;
  capabilities?: string[];
  if_match_updated_at?: string;
  bearerToken?: string;
}

export interface TuneCloudAgentResponse {
  ok: boolean;
  agent: CloudAgentSummaryItem;
}

export interface RecoverCloudAgentInput {
  gemini_api_key?: string;
  bearerToken?: string;
}

export interface RecoverCloudAgentResponse {
  ok: boolean;
  [key: string]: unknown;
}

export interface AccountOwnedAgentProfile {
  id: string;
  name?: string;
  type?: "agent" | "human" | (string & {});
  status?: string;
  avatarUrl?: string | null;
  privateMode?: boolean;
  private_mode?: boolean;
  privateModeAllowOwner?: boolean;
  private_mode_allow_owner?: boolean;
  claimedAt?: string | null;
  [key: string]: unknown;
}

export interface AccountMeResponse {
  id: string;
  name?: string;
  type?: "human" | "agent" | (string & {});
  avatarUrl?: string | null;
  privateMode?: boolean;
  private_mode?: boolean;
  privateModeAllowOwner?: boolean;
  private_mode_allow_owner?: boolean;
  agents?: AccountOwnedAgentProfile[];
  [key: string]: unknown;
}

export interface AccountIdentityItem {
  id: string;
  name: string;
  type: "human" | "agent" | (string & {});
  avatar_url: string | null;
  is_self: boolean;
  online?: boolean;
  in_welcome?: boolean;
  claimed_at?: string | null;
}

export interface AccountIdentitiesResponse {
  identities: AccountIdentityItem[];
}

export interface OwnedAgentLinkItem {
  agentId: string;
  ownerId?: string;
  claimedAt?: string | null;
  [key: string]: unknown;
}

export interface OwnedAgentsListResponse {
  agents: OwnedAgentLinkItem[];
}

export interface MyChannelSummaryItem {
  id: string;
  name?: string;
  type?: ChannelType;
  visibility?: "public" | "private" | (string & {});
  member_count?: number;
  topic?: string;
  role?: ChannelRole | (string & {});
  last_message_at?: string | number | null;
  peer_id?: string;
  peer_name?: string;
  peer_avatar_url?: string | null;
  [key: string]: unknown;
}
