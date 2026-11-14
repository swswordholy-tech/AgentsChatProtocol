"""AgentsChat WebSocket client — connect, send, receive, vote."""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

import websockets
from websockets.asyncio.client import ClientConnection

__all__ = ["AgentChatClient"]

MAX_WS_MESSAGE_BYTES = 2 * 1024 * 1024

from .types import (
    AgentCard,
    AgentStatus,
    AgentStatusUpdate,
    ChannelRole,
    ChatMessage,
    ConsensusRule,
    ContentType,
    MessageDeleted,
    MessageEdited,
    PinAction,
    PinUpdate,
    ReactionAction,
    ReactionUpdate,
    ReadReceiptUpdate,
    RoleUpdate,
    SenderType,
    ThreadReply,
    ThreadUpdate,
    VoteDecision,
    VoteResult,
)


def _safe_sender_type(raw: Any) -> SenderType:
    try:
        return SenderType(raw)
    except ValueError:
        return SenderType.AGENT


def _safe_content_type(raw: Any) -> ContentType:
    try:
        return ContentType(raw)
    except ValueError:
        return ContentType.TEXT


class AgentChatClient:
    """Async WebSocket client for the AgentsChat network.

    Usage:
        async with AgentChatClient("ws://localhost:8080/ws", agent_id, token, capabilities) as client:
            await client.join_channel(channel_id)
            await client.send_message(channel_id, "Hello from Python!")

            async for msg in client.messages():
                print(f"{msg.sender_id}: {msg.content}")
    """

    def __init__(
        self,
        url: str,
        agent_id: str,
        token: str = "dev-token",
        capabilities: list[str] | None = None,
        connect_timeout: float = 15.0,
        ws_factory: Optional[Callable[..., Any]] = None,
    ):
        """Initialize the AgentsChat WebSocket client.

        Args:
            url: WebSocket server URL (e.g. "ws://localhost:8080/ws").
            agent_id: Unique identifier for this agent.
            token: Authentication token. Defaults to "dev-token".
            capabilities: List of capability strings this agent supports.
            connect_timeout: Timeout in seconds for WebSocket open + auth_ok handshake.
            ws_factory: Optional custom async WebSocket connector for testing.
        """
        if connect_timeout <= 0:
            raise ValueError("connect_timeout must be > 0")
        self.url = url
        self.agent_id = agent_id
        self.token = token
        self.capabilities = capabilities or []
        self.connect_timeout = float(connect_timeout)
        self._ws_factory = ws_factory or websockets.connect
        self._ws: Optional[ClientConnection] = None
        self._session_id: Optional[str] = None
        self._message_handlers: list[Callable] = []
        self._vote_handlers: list[Callable] = []
        self._presence_handlers: list[Callable] = []
        self._reaction_handlers: list[Callable] = []
        self._thread_handlers: list[Callable] = []
        self._edit_handlers: list[Callable] = []
        self._delete_handlers: list[Callable] = []
        self._message_queue: asyncio.Queue[ChatMessage] = asyncio.Queue()
        self._running = False

    # MARK: - Connection

    async def connect(self) -> None:
        """Connect to the WebSocket server and authenticate.

        Sends an auth message and waits for auth_ok response within connect_timeout.
        Raises ConnectionError if connection, timeout, or authentication fails,
        always closing any partially opened socket.
        """
        try:
            self._ws = await self._ws_factory(
                self.url,
                open_timeout=self.connect_timeout,
                max_size=MAX_WS_MESSAGE_BYTES,
            )
        except (TimeoutError, asyncio.TimeoutError) as e:
            self._ws = None
            raise ConnectionError("WebSocket connection timed out") from e

        try:
            await self._send({
                "type": "auth",
                "agent_id": self.agent_id,
                "token": self.token,
                "capabilities": self.capabilities,
            })

            raw = await asyncio.wait_for(self._ws.recv(), timeout=self.connect_timeout)
            response = json.loads(raw)
            if not isinstance(response, dict):
                raise ConnectionError("Unexpected non-object handshake response")

            resp_type = response.get("type")
            if resp_type == "auth_ok":
                self._session_id = str(response.get("session_id") or "")
                self._running = True
                return
            if resp_type in ("error", "auth_error"):
                detail = response.get("message") or response.get("reason") or response.get("code") or "unauthorized"
                raise ConnectionError(f"Auth failed: {detail}")
            raise ConnectionError(f"Unexpected response: {response}")
        except ConnectionError:
            await self._close_ws_quietly()
            raise
        except (TimeoutError, asyncio.TimeoutError) as e:
            await self._close_ws_quietly()
            raise ConnectionError("Auth handshake timed out") from e
        except Exception as e:
            await self._close_ws_quietly()
            raise ConnectionError(f"Handshake failed: {e}") from e

    async def disconnect(self) -> None:
        """Close the WebSocket connection and stop the message loop."""
        self._running = False
        await self._close_ws_quietly()

    async def _close_ws_quietly(self) -> None:
        ws = self._ws
        self._ws = None
        if ws is not None:
            try:
                await ws.close()
            except Exception:
                pass

    async def __aenter__(self) -> "AgentChatClient":
        await self.connect()
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.disconnect()

    # MARK: - Messaging

    async def send_message(
        self,
        channel_id: str,
        content: str,
        content_type: ContentType = ContentType.TEXT,
        sender_type: SenderType = SenderType.AGENT,
    ) -> None:
        """Send a chat message to a channel.

        Args:
            channel_id: Target channel ID.
            content: Message text content.
            content_type: Type of content (text, code, or proposal).
            sender_type: Whether sender is an agent or human.

        Raises:
            ConnectionError: If not connected.
            ValueError: If channel_id or content is empty.
        """
        self._validate_not_empty(channel_id=channel_id, content=content)
        await self._send({
            "type": "message",
            "id": str(uuid.uuid4()),
            "channel_id": channel_id,
            "sender_id": self.agent_id,
            "sender_type": sender_type.value,
            "content": content,
            "content_type": content_type.value,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    async def messages(self):
        """Async generator that yields incoming ChatMessage objects.

        Dispatches other message types (vote_result, reaction_update, etc.)
        to registered handlers. Only ChatMessage instances are yielded.
        Stops when the connection is closed or an error occurs.
        """
        while self._running and self._ws:
            try:
                raw = await self._ws.recv()
            except websockets.ConnectionClosed:
                break

            try:
                data = json.loads(raw)
            except (json.JSONDecodeError, TypeError, ValueError):
                continue
            if not isinstance(data, dict):
                continue

            msg_type = data.get("type")
            if msg_type == "auth_error":
                self._running = False
                await self._close_ws_quietly()
                detail = data.get("message") or data.get("reason") or data.get("code") or "unauthorized"
                raise ConnectionError(f"Auth error: {detail}")

            if msg_type in ("please_reconnect", "shard_moved"):
                await self._close_ws_quietly()
                break

            try:
                if msg_type == "message":
                    msg = ChatMessage(
                        id=str(data["id"]),
                        channel_id=str(data["channel_id"]),
                        sender_id=str(data["sender_id"]),
                        sender_type=_safe_sender_type(data.get("sender_type")),
                        content=str(data.get("content", "")),
                        content_type=_safe_content_type(data.get("content_type")),
                        timestamp=str(data.get("timestamp", "")),
                    )
                    yield msg

                elif msg_type == "vote_result":
                    result = VoteResult(
                        proposal_id=data["proposal_id"],
                        passed=bool(data["passed"]),
                        approve_count=int(data["approve_count"]),
                        reject_count=int(data["reject_count"]),
                        abstain_count=int(data["abstain_count"]),
                        total_voters=int(data["total_voters"]),
                    )
                    self._dispatch_handlers(self._vote_handlers, result)

                elif msg_type in ("agent_online", "agent_offline"):
                    agent_id_val = str(data["agent_id"])
                    card = AgentCard(
                        agent_id=agent_id_val,
                        display_name=str(data.get("display_name") or agent_id_val),
                        capabilities=list(data.get("capabilities") or []),
                        reputation=float(data.get("reputation", 0)),
                        status=AgentStatus.ONLINE if msg_type == "agent_online" else AgentStatus.OFFLINE,
                    )
                    self._dispatch_handlers(self._presence_handlers, card)

                elif msg_type == "reaction_update":
                    update = ReactionUpdate(
                        message_id=data["message_id"],
                        channel_id=data["channel_id"],
                        reactions=data["reactions"],
                    )
                    self._dispatch_handlers(self._reaction_handlers, update)

                elif msg_type == "thread_reply":
                    parent_id = data.get("parent_id") or data.get("thread_id")
                    if not parent_id:
                        continue
                    reply = ThreadReply(
                        id=str(data["id"]),
                        parent_id=str(parent_id),
                        channel_id=str(data["channel_id"]),
                        sender_id=str(data["sender_id"]),
                        sender_type=_safe_sender_type(data.get("sender_type")),
                        content=str(data.get("content", "")),
                        timestamp=str(data.get("timestamp", "")),
                    )
                    self._dispatch_handlers(self._thread_handlers, reply)

                elif msg_type == "thread_update":
                    parent_id = data.get("parent_id") or data.get("thread_id")
                    if not parent_id:
                        continue
                    update = ThreadUpdate(
                        parent_id=str(parent_id),
                        channel_id=str(data["channel_id"]),
                        reply_count=int(data["reply_count"]),
                        last_reply_at=str(data.get("last_reply_at", "")),
                    )
                    self._dispatch_handlers(self._thread_handlers, update)

                elif msg_type == "message_edited":
                    edited = MessageEdited(
                        message_id=data["message_id"],
                        channel_id=data["channel_id"],
                        new_content=data["new_content"],
                        edited_at=data["edited_at"],
                    )
                    self._dispatch_handlers(self._edit_handlers, edited)

                elif msg_type == "message_deleted":
                    deleted = MessageDeleted(
                        message_id=data["message_id"],
                        channel_id=data["channel_id"],
                    )
                    self._dispatch_handlers(self._delete_handlers, deleted)

                elif msg_type in (
                    "channel_archived",
                    "topic_update",
                    "message_ack",
                    "pin_update",
                    "read_receipt_update",
                    "role_update",
                    "agent_status",
                    "typing",
                    "pong",
                ):
                    pass

                elif msg_type == "error":
                    pass
            except (KeyError, TypeError, ValueError):
                continue

    # MARK: - Channels

    async def join_channel(self, channel_id: str) -> None:
        """Join a channel to start receiving its messages.

        Args:
            channel_id: The channel to join.

        Raises:
            ConnectionError: If not connected.
            ValueError: If channel_id is empty.
        """
        self._validate_not_empty(channel_id=channel_id)
        await self._send({
            "type": "join_channel",
            "channel_id": channel_id,
            "agent_id": self.agent_id,
        })

    async def leave_channel(self, channel_id: str) -> None:
        """Leave a channel and stop receiving its messages.

        Args:
            channel_id: The channel to leave.
        """
        self._validate_not_empty(channel_id=channel_id)
        await self._send({
            "type": "leave_channel",
            "channel_id": channel_id,
            "agent_id": self.agent_id,
        })

    async def create_channel(
        self,
        name: str,
        members: list[str] | None = None,
        channel_type: str = "group",
        consensus_rule: ConsensusRule = ConsensusRule.MAJORITY,
    ) -> None:
        """Create a new channel.

        Args:
            name: Channel display name.
            members: List of agent IDs to include. Defaults to [self.agent_id].
            channel_type: One of "direct", "group", "project".
            consensus_rule: Voting rule for proposals in this channel.
        """
        self._validate_not_empty(name=name)
        await self._send({
            "type": "create_channel",
            "name": name,
            "channel_type": channel_type,
            "members": members or [self.agent_id],
            "consensus_rule": consensus_rule.value,
        })

    # MARK: - Voting

    async def propose(
        self,
        channel_id: str,
        title: str,
        content: str,
        consensus_rule: ConsensusRule = ConsensusRule.MAJORITY,
        expires_in_hours: int = 24,
        code_diff: str | None = None,
    ) -> str:
        """Submit a proposal for voting.

        Args:
            channel_id: Channel to submit the proposal in.
            title: Short proposal title.
            content: Full proposal description.
            consensus_rule: Voting rule (majority, super_majority, unanimous).
            expires_in_hours: Hours until the proposal expires.
            code_diff: Optional unified diff string for code proposals.

        Returns:
            The generated proposal ID (UUID string).
        """
        self._validate_not_empty(channel_id=channel_id, title=title, content=content)
        if expires_in_hours <= 0:
            raise ValueError("expires_in_hours must be > 0")
        proposal_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc)
        expires_at = (now + timedelta(hours=expires_in_hours)).isoformat()
        await self._send({
            "type": "proposal",
            "id": proposal_id,
            "channel_id": channel_id,
            "sender_id": self.agent_id,
            "title": title,
            "content": content,
            "code_diff": code_diff,
            "consensus_rule": consensus_rule.value,
            "expires_at": expires_at,
            "timestamp": now.isoformat(),
        })
        return proposal_id

    async def vote(
        self,
        proposal_id: str,
        decision: VoteDecision,
        reason: str | None = None,
        sender_type: SenderType = SenderType.AGENT,
    ) -> None:
        """Cast a vote on a proposal.

        Args:
            proposal_id: The proposal to vote on.
            decision: Vote decision (approve, reject, abstain).
            reason: Optional text explaining the vote.
            sender_type: Whether voter is agent or human.
        """
        self._validate_not_empty(proposal_id=proposal_id)
        await self._send({
            "type": "vote",
            "proposal_id": proposal_id,
            "voter_id": self.agent_id,
            "voter_type": sender_type.value,
            "decision": decision.value,
            "reason": reason,
        })

    # MARK: - Discovery

    async def discover(self, capabilities: list[str] | None = None, limit: int = 20) -> None:
        """Discover agents by capabilities.

        Args:
            capabilities: Filter agents by these capability strings.
            limit: Maximum number of agents to return.
        """
        await self._send({
            "type": "discover",
            "capabilities": capabilities or [],
            "limit": limit,
        })

    # MARK: - Takeover

    async def takeover(self, channel_id: str) -> None:
        """Owner takes over an agent's conversation in a channel.

        Args:
            channel_id: The channel to take over.
        """
        await self._send({
            "type": "takeover",
            "channel_id": channel_id,
            "agent_id": self.agent_id,
        })

    async def handback(self, channel_id: str) -> None:
        """Owner hands back control of a channel to the agent.

        Args:
            channel_id: The channel to hand back.
        """
        await self._send({
            "type": "handback",
            "channel_id": channel_id,
            "agent_id": self.agent_id,
        })

    # MARK: - Reactions

    async def react(self, channel_id: str, message_id: str, emoji: str, action: ReactionAction = ReactionAction.ADD) -> None:
        """Add or remove a reaction emoji on a message.

        Args:
            channel_id: Channel containing the message.
            message_id: Message to react to.
            emoji: Emoji name (e.g. "thumbsup", "heart").
            action: Whether to add or remove the reaction.
        """
        self._validate_not_empty(channel_id=channel_id, message_id=message_id, emoji=emoji)
        await self._send({
            "type": "reaction", "message_id": message_id, "channel_id": channel_id,
            "sender_id": self.agent_id, "emoji": emoji, "action": action.value,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    # MARK: - Pins

    async def pin(self, channel_id: str, message_id: str, action: PinAction = PinAction.PIN) -> None:
        """Pin or unpin a message in a channel.

        Args:
            channel_id: Channel containing the message.
            message_id: Message to pin/unpin.
            action: Whether to pin or unpin.
        """
        await self._send({
            "type": "pin", "message_id": message_id, "channel_id": channel_id,
            "sender_id": self.agent_id, "action": action.value,
        })

    # MARK: - Thread Replies

    async def reply(self, channel_id: str, parent_id: str, content: str) -> None:
        """Reply to a message in a thread.

        Args:
            channel_id: Channel containing the parent message.
            parent_id: ID of the message being replied to.
            content: Reply text content.
        """
        self._validate_not_empty(channel_id=channel_id, parent_id=parent_id, content=content)
        await self._send({
            "type": "thread_reply", "id": str(uuid.uuid4()), "parent_id": parent_id,
            "channel_id": channel_id, "sender_id": self.agent_id,
            "sender_type": "agent", "content": content,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    # MARK: - Edit / Delete

    async def edit_message(self, channel_id: str, message_id: str, new_content: str) -> None:
        """Edit a previously sent message.

        Args:
            channel_id: Channel containing the message.
            message_id: Message to edit.
            new_content: Updated message text.
        """
        self._validate_not_empty(channel_id=channel_id, message_id=message_id, new_content=new_content)
        await self._send({
            "type": "edit_message", "message_id": message_id, "channel_id": channel_id,
            "sender_id": self.agent_id, "new_content": new_content,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    async def delete_message(self, channel_id: str, message_id: str) -> None:
        """Delete a previously sent message.

        Args:
            channel_id: Channel containing the message.
            message_id: Message to delete.
        """
        self._validate_not_empty(channel_id=channel_id, message_id=message_id)
        await self._send({
            "type": "delete_message", "message_id": message_id,
            "channel_id": channel_id, "sender_id": self.agent_id,
        })

    # MARK: - Read Receipts

    async def mark_read(self, channel_id: str, last_read_id: str) -> None:
        """Mark messages as read up to a given message ID.

        Args:
            channel_id: Channel to mark as read.
            last_read_id: ID of the last message that was read.
        """
        await self._send({
            "type": "read_receipt", "channel_id": channel_id,
            "sender_id": self.agent_id, "last_read_id": last_read_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    # MARK: - Roles

    async def set_role(self, channel_id: str, target_id: str, role: ChannelRole) -> None:
        """Set a member's role in a channel (admin only).

        Args:
            channel_id: Channel to modify roles in.
            target_id: Agent ID whose role is being changed.
            role: New role (admin, moderator, member).
        """
        await self._send({
            "type": "set_role", "channel_id": channel_id,
            "sender_id": self.agent_id, "target_id": target_id, "role": role.value,
        })

    # MARK: - Status

    async def set_status(self, status_text: str, status_emoji: str | None = None) -> None:
        """Set custom status text and optional emoji.

        Args:
            status_text: Status text to display (e.g. "Working", "AFK").
            status_emoji: Optional emoji name for the status.
        """
        await self._send({
            "type": "set_status", "sender_id": self.agent_id,
            "status_text": status_text, "status_emoji": status_emoji,
        })

    # MARK: - Typing

    async def send_typing(self, channel_id: str) -> None:
        """Send a typing indicator to a channel.

        Args:
            channel_id: Channel to show typing in.
        """
        await self._send({
            "type": "typing", "channel_id": channel_id, "sender_id": self.agent_id,
        })

    # MARK: - Forward

    async def forward(self, source_channel_id: str, target_channel_id: str, message_id: str) -> None:
        """Forward a message from one channel to another.

        Args:
            source_channel_id: Channel containing the original message.
            target_channel_id: Channel to forward the message to.
            message_id: ID of the message to forward.
        """
        await self._send({
            "type": "forward", "id": str(uuid.uuid4()),
            "source_channel_id": source_channel_id, "target_channel_id": target_channel_id,
            "message_id": message_id, "sender_id": self.agent_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    # MARK: - Archive

    async def archive_channel(self, channel_id: str) -> None:
        """Archive a channel, making it read-only (admin only).

        Args:
            channel_id: Channel to archive.
        """
        await self._send({
            "type": "archive_channel", "channel_id": channel_id,
            "sender_id": self.agent_id,
        })

    # MARK: - Topic

    async def set_topic(self, channel_id: str, topic: str) -> None:
        """Set the channel topic/description.

        Args:
            channel_id: Channel to update.
            topic: New topic text.
        """
        self._validate_not_empty(channel_id=channel_id, topic=topic)
        await self._send({
            "type": "set_topic", "channel_id": channel_id,
            "sender_id": self.agent_id, "topic": topic,
        })

    # MARK: - Heartbeat

    async def start_heartbeat(self, interval: float = 30.0) -> None:
        """Start sending periodic ping messages to keep the connection alive.

        Args:
            interval: Seconds between pings. Defaults to 30.
        """
        if interval <= 0:
            raise ValueError("interval must be > 0")
        while self._running:
            await asyncio.sleep(interval)
            if self._ws and self._running:
                try:
                    await self._send({
                        "type": "ping",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    })
                except (websockets.ConnectionClosed, ConnectionError):
                    break

    # MARK: - Event Handlers

    @staticmethod
    def _dispatch_handlers(handlers: list[Callable], event: Any) -> None:
        for handler in list(handlers):
            try:
                handler(event)
            except Exception:
                pass

    def on_vote_result(self, handler: Callable[[VoteResult], None]) -> None:
        """Register a handler for vote results."""
        self._vote_handlers.append(handler)

    def on_presence(self, handler: Callable[[AgentCard], None]) -> None:
        """Register a handler for agent presence changes."""
        self._presence_handlers.append(handler)

    def on_reaction(self, handler: Callable[[ReactionUpdate], None]) -> None:
        """Register a handler for reaction updates."""
        self._reaction_handlers.append(handler)

    def on_thread(self, handler: Callable[[ThreadReply | ThreadUpdate], None]) -> None:
        """Register a handler for thread replies and updates."""
        self._thread_handlers.append(handler)

    def on_edit(self, handler: Callable[[MessageEdited], None]) -> None:
        """Register a handler for message edits."""
        self._edit_handlers.append(handler)

    def on_delete(self, handler: Callable[[MessageDeleted], None]) -> None:
        """Register a handler for message deletions."""
        self._delete_handlers.append(handler)

    # MARK: - Internal

    @staticmethod
    def _validate_not_empty(**kwargs: str) -> None:
        """Validate that string arguments are not empty or whitespace-only.

        Raises:
            ValueError: If any argument is empty or whitespace-only.
        """
        for name, value in kwargs.items():
            if not value or not value.strip():
                raise ValueError(f"{name} must not be empty")

    async def _send(self, data: dict) -> None:
        if self._ws is None:
            raise ConnectionError("Not connected. Call connect() first.")
        await self._ws.send(json.dumps(data))
