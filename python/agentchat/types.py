"""Protocol types matching AgentChat Protocol (ACProtocol.swift / protocol.ts)."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Optional

__all__ = [
    # Enums
    "SenderType", "ContentType", "ChannelType", "ConsensusRule",
    "VoteDecision", "AgentStatus", "ReactionAction", "PinAction",
    "ChannelRole", "TaskStatus",
    # Core dataclasses
    "ChatMessage", "AgentCard", "VoteResult", "Proposal",
    "ReactionUpdate", "PinUpdate", "ThreadReply", "ThreadUpdate",
    "MessageEdited", "MessageDeleted", "ReadReceiptUpdate",
    "RoleUpdate", "AgentStatusUpdate",
    # Protocol — Client -> Server
    "AuthMessage", "JoinChannelMessage", "LeaveChannelMessage",
    "CreateChannelMessage", "TakeoverMessage", "HandbackMessage",
    "DiscoverMessage", "PingMessage", "ReactionMessage", "PinMessageCmd",
    "EditMessageCmd", "DeleteMessageCmd", "ReadReceiptMessage",
    "SetRoleMessage", "SetStatusMessage", "TypingMessage",
    "ForwardMessage", "ArchiveChannelMessage", "SetTopicMessage",
    # Protocol — Server -> Client
    "AuthOKMessage", "ChannelCreatedMessage", "VoteResultMessage",
    "DiscoverResultMessage", "ErrorMessage", "PongMessage",
    "MessageAck", "TopicUpdateMessage", "ChannelArchivedMessage",
    # V2: Raft + DAG
    "RequestVoteMessage", "VoteGrantedMessage", "LeaderElectedMessage",
    "TaskNode", "CreateDAGMessage", "AssignTaskMessage",
    "TaskUpdateMessage", "TaskVerifiedMessage",
]


class SenderType(StrEnum):
    AGENT = "agent"
    HUMAN = "human"


class ContentType(StrEnum):
    TEXT = "text"
    CODE = "code"
    PROPOSAL = "proposal"


class ChannelType(StrEnum):
    DIRECT = "direct"
    GROUP = "group"
    PROJECT = "project"


class ConsensusRule(StrEnum):
    MAJORITY = "majority"
    SUPER_MAJORITY = "super_majority"
    UNANIMOUS = "unanimous"


class VoteDecision(StrEnum):
    APPROVE = "approve"
    REJECT = "reject"
    ABSTAIN = "abstain"


class AgentStatus(StrEnum):
    ONLINE = "online"
    OFFLINE = "offline"
    BUSY = "busy"


@dataclass
class ChatMessage:
    id: str
    channel_id: str
    sender_id: str
    sender_type: SenderType
    content: str
    content_type: ContentType
    timestamp: str


@dataclass
class AgentCard:
    agent_id: str
    display_name: str
    capabilities: list[str]
    reputation: float
    status: AgentStatus
    description: Optional[str] = None


@dataclass
class VoteResult:
    proposal_id: str
    passed: bool
    approve_count: int
    reject_count: int
    abstain_count: int
    total_voters: int


@dataclass
class Proposal:
    id: str
    channel_id: str
    sender_id: str
    title: str
    content: str
    consensus_rule: ConsensusRule
    expires_at: str
    timestamp: str
    code_diff: Optional[str] = None


class ReactionAction(StrEnum):
    ADD = "add"
    REMOVE = "remove"


class PinAction(StrEnum):
    PIN = "pin"
    UNPIN = "unpin"


class ChannelRole(StrEnum):
    ADMIN = "admin"
    MODERATOR = "moderator"
    MEMBER = "member"


@dataclass
class ReactionUpdate:
    message_id: str
    channel_id: str
    reactions: dict[str, list[str]]  # emoji → [sender_ids]


@dataclass
class PinUpdate:
    channel_id: str
    pinned_messages: list[str]


@dataclass
class ThreadReply:
    id: str
    parent_id: str
    channel_id: str
    sender_id: str
    sender_type: SenderType
    content: str
    timestamp: str


@dataclass
class ThreadUpdate:
    parent_id: str
    channel_id: str
    reply_count: int
    last_reply_at: str


@dataclass
class MessageEdited:
    message_id: str
    channel_id: str
    new_content: str
    edited_at: str


@dataclass
class MessageDeleted:
    message_id: str
    channel_id: str


@dataclass
class ReadReceiptUpdate:
    channel_id: str
    receipts: dict[str, str]  # agent_id → last_read_message_id


@dataclass
class RoleUpdate:
    channel_id: str
    target_id: str
    role: ChannelRole


@dataclass
class AgentStatusUpdate:
    agent_id: str
    status_text: str
    status_emoji: Optional[str] = None


# ============================================================
# Full Protocol Messages — matches Server protocol.ts (48 types)
# ============================================================

# Client -> Server

@dataclass
class AuthMessage:
    agent_id: str
    token: str
    capabilities: list[str]


@dataclass
class JoinChannelMessage:
    channel_id: str
    agent_id: str


@dataclass
class LeaveChannelMessage:
    channel_id: str
    agent_id: str


@dataclass
class CreateChannelMessage:
    name: str
    channel_type: ChannelType
    members: list[str]
    consensus_rule: ConsensusRule


@dataclass
class TakeoverMessage:
    channel_id: str
    agent_id: str


@dataclass
class HandbackMessage:
    channel_id: str
    agent_id: str


@dataclass
class DiscoverMessage:
    capabilities: list[str]
    limit: int


@dataclass
class PingMessage:
    timestamp: str


@dataclass
class ReactionMessage:
    message_id: str
    channel_id: str
    sender_id: str
    emoji: str
    action: ReactionAction
    timestamp: str


@dataclass
class PinMessageCmd:
    message_id: str
    channel_id: str
    sender_id: str
    action: PinAction


@dataclass
class EditMessageCmd:
    message_id: str
    channel_id: str
    sender_id: str
    new_content: str
    timestamp: str


@dataclass
class DeleteMessageCmd:
    message_id: str
    channel_id: str
    sender_id: str


@dataclass
class ReadReceiptMessage:
    channel_id: str
    sender_id: str
    last_read_id: str
    timestamp: str


@dataclass
class SetRoleMessage:
    channel_id: str
    sender_id: str
    target_id: str
    role: ChannelRole


@dataclass
class SetStatusMessage:
    sender_id: str
    status_text: str
    status_emoji: Optional[str] = None


@dataclass
class TypingMessage:
    channel_id: str
    sender_id: str


@dataclass
class ForwardMessage:
    id: str
    source_channel_id: str
    target_channel_id: str
    message_id: str
    sender_id: str
    timestamp: str


@dataclass
class ArchiveChannelMessage:
    channel_id: str
    sender_id: str


@dataclass
class SetTopicMessage:
    channel_id: str
    sender_id: str
    topic: str


# Server -> Client

@dataclass
class AuthOKMessage:
    agent_id: str
    session_id: str


@dataclass
class ChannelCreatedMessage:
    channel_id: str
    name: str
    channel_type: ChannelType


@dataclass
class VoteResultMessage:
    proposal_id: str
    passed: bool
    approve_count: int
    reject_count: int
    abstain_count: int
    total_voters: int


@dataclass
class DiscoverResultMessage:
    agents: list[AgentCard]


@dataclass
class ErrorMessage:
    code: int
    message: str


@dataclass
class PongMessage:
    timestamp: str


@dataclass
class MessageAck:
    message_id: str
    channel_id: str
    delivered_to: int
    timestamp: str


@dataclass
class TopicUpdateMessage:
    channel_id: str
    topic: str
    set_by: str


@dataclass
class ChannelArchivedMessage:
    channel_id: str


# V2: Raft Leader Election + DAG Task Collaboration

class TaskStatus(StrEnum):
    PENDING = "pending"
    ASSIGNED = "assigned"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class RequestVoteMessage:
    channel_id: str
    candidate_id: str
    term: int
    timestamp: str


@dataclass
class VoteGrantedMessage:
    channel_id: str
    voter_id: str
    candidate_id: str
    term: int


@dataclass
class LeaderElectedMessage:
    channel_id: str
    leader_id: str
    term: int


@dataclass
class TaskNode:
    id: str
    title: str
    description: str
    depends_on: list[str]
    status: TaskStatus
    assigned_to: Optional[str] = None
    result: Optional[str] = None


@dataclass
class CreateDAGMessage:
    channel_id: str
    leader_id: str
    goal: str
    tasks: list[TaskNode]
    timestamp: str


@dataclass
class AssignTaskMessage:
    channel_id: str
    leader_id: str
    task_id: str
    agent_id: str


@dataclass
class TaskUpdateMessage:
    channel_id: str
    task_id: str
    agent_id: str
    status: TaskStatus
    result: Optional[str] = None


@dataclass
class TaskVerifiedMessage:
    channel_id: str
    leader_id: str
    task_id: str
    accepted: bool
    feedback: Optional[str] = None
