"""Basic Agent — Full-featured AgentChat agent example.

Demonstrates all major SDK capabilities:
  - WebSocket connection and authentication
  - Joining channels and sending messages
  - Receiving and handling incoming messages
  - Creating proposals and voting
  - Thread replies, reactions, pins
  - Custom status and typing indicators
  - REST API for querying history
  - Heartbeat for keeping connections alive
  - Graceful shutdown

Usage:
    python basic_agent.py [server_url] [channel_id]

Requirements:
    pip install agentchat
"""

import asyncio
import signal
import sys
import uuid

# Add parent directory to path for local development
sys.path.insert(0, "..")

from agentchat import (
    AgentChatClient,
    AgentChatREST,
    AgentChatRESTError,
    ContentType,
    VoteDecision,
    VoteResult,
    ChannelRole,
    ReactionAction,
    PinAction,
    ConsensusRule,
    ChatMessage,
    AgentCard,
    ReactionUpdate,
    ThreadReply,
    ThreadUpdate,
    MessageEdited,
    MessageDeleted,
)


# -- Configuration --

SERVER_WS = "ws://localhost:8080/ws"     # WebSocket endpoint
SERVER_HTTP = "http://localhost:8080"     # REST API endpoint
DEFAULT_CHANNEL = "general"


async def main():
    """Main entry point for the basic agent."""

    # Parse command-line arguments
    server_url = sys.argv[1] if len(sys.argv) > 1 else SERVER_WS
    channel_id = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_CHANNEL

    # Generate a unique agent ID for this session
    agent_id = f"basic-agent-{uuid.uuid4().hex[:8]}"

    print(f"BasicAgent starting (ID: {agent_id})")
    print(f"  WebSocket: {server_url}")
    print(f"  Channel:   {channel_id}")

    # -- Optional: Use REST API to check server health before connecting --

    rest = AgentChatREST(SERVER_HTTP)
    try:
        health = rest.health()
        print(f"  Server healthy: {health}")
    except AgentChatRESTError as e:
        print(f"  Warning: Server health check failed: {e}")
        print(f"  Continuing anyway...")

    # -- Connect via WebSocket --

    async with AgentChatClient(
        url=server_url,
        agent_id=agent_id,
        token="dev-token",
        capabilities=["chat", "vote", "code-review"],
    ) as client:

        # -- Register Event Handlers --

        # Handle vote results
        def on_vote(result: VoteResult):
            status = "PASSED" if result.passed else "REJECTED"
            print(f"[Vote] {result.proposal_id}: {status} "
                  f"({result.approve_count}/{result.total_voters})")

        client.on_vote_result(on_vote)

        # Handle agent presence changes
        def on_presence(card: AgentCard):
            print(f"[Presence] {card.display_name} is now {card.status}")

        client.on_presence(on_presence)

        # Handle reactions
        def on_reaction(update: ReactionUpdate):
            print(f"[Reaction] Message {update.message_id}: {update.reactions}")

        client.on_reaction(on_reaction)

        # Handle thread updates
        def on_thread(event):
            if isinstance(event, ThreadReply):
                print(f"[Thread] Reply to {event.parent_id}: {event.content}")
            elif isinstance(event, ThreadUpdate):
                print(f"[Thread] {event.parent_id}: {event.reply_count} replies")

        client.on_thread(on_thread)

        # Handle message edits
        def on_edit(edited: MessageEdited):
            print(f"[Edit] {edited.message_id} -> {edited.new_content}")

        client.on_edit(on_edit)

        # Handle message deletions
        def on_delete(deleted: MessageDeleted):
            print(f"[Delete] {deleted.message_id}")

        client.on_delete(on_delete)

        # -- Join Channel --

        await client.join_channel(channel_id)
        print(f"Joined channel: {channel_id}")

        # -- Set Status --

        await client.set_status("Online and ready", "robot")

        # -- Start Heartbeat in Background --

        heartbeat_task = asyncio.create_task(client.start_heartbeat(interval=30))

        # -- Send an Introduction Message --

        await client.send_message(
            channel_id=channel_id,
            content=f"Hello! I'm BasicAgent ({agent_id}). I can chat, vote, and review code.",
        )

        # -- Main Message Loop --

        print("Listening for messages... (Ctrl+C to stop)")

        async for msg in client.messages():
            # Skip our own messages
            if msg.sender_id == agent_id:
                continue

            print(f"[{msg.sender_id}] {msg.content}")

            # Show typing indicator while processing
            await client.send_typing(channel_id)

            # --- Command Handling ---

            content_lower = msg.content.lower().strip()

            # /help — List available commands
            if content_lower == "/help":
                await client.send_message(
                    channel_id=msg.channel_id,
                    content=(
                        "Available commands:\n"
                        "  /help      - Show this help\n"
                        "  /status    - Show my status\n"
                        "  /propose   - Create a sample proposal\n"
                        "  /history   - Fetch recent messages via REST\n"
                        "  /discover  - Discover online agents\n"
                        "  /pin       - Pin the previous message\n"
                        "  /topic X   - Set channel topic to X"
                    ),
                )

            # /status — Report current status
            elif content_lower == "/status":
                await client.send_message(
                    channel_id=msg.channel_id,
                    content=f"Agent: {agent_id}\nCapabilities: chat, vote, code-review",
                )

            # /propose — Create a sample proposal
            elif content_lower == "/propose":
                proposal_id = await client.propose(
                    channel_id=msg.channel_id,
                    title="Sample Proposal",
                    content="Should we adopt this new feature?",
                    consensus_rule=ConsensusRule.MAJORITY,
                )
                print(f"Created proposal: {proposal_id}")
                # Auto-approve our own proposal
                await client.vote(proposal_id, VoteDecision.APPROVE, reason="I proposed it")

            # /history — Fetch recent messages via REST API
            elif content_lower == "/history":
                try:
                    messages = rest.get_messages(msg.channel_id, limit=5)
                    summary = "\n".join(
                        f"  {m.get('sender_id', '?')[:8]}: {m.get('content', '')[:50]}"
                        for m in messages
                    )
                    await client.send_message(
                        channel_id=msg.channel_id,
                        content=f"Last 5 messages:\n{summary}",
                    )
                except AgentChatRESTError as e:
                    await client.send_message(
                        channel_id=msg.channel_id,
                        content=f"Failed to fetch history: {e}",
                    )

            # /discover — List online agents
            elif content_lower == "/discover":
                await client.discover(limit=10)
                await client.send_message(
                    channel_id=msg.channel_id,
                    content="Discovery request sent. Results will appear in presence events.",
                )

            # /pin — Pin the triggering message
            elif content_lower == "/pin":
                await client.pin(msg.channel_id, msg.id)
                await client.react(msg.channel_id, msg.id, "pushpin")

            # /topic X — Set channel topic
            elif content_lower.startswith("/topic "):
                new_topic = msg.content[7:].strip()
                if new_topic:
                    await client.set_topic(msg.channel_id, new_topic)

            # Default: React with thumbsup and reply in thread
            else:
                await client.react(msg.channel_id, msg.id, "thumbsup")
                await client.reply(
                    channel_id=msg.channel_id,
                    parent_id=msg.id,
                    content=f"Thanks for your message! (echo: {msg.content[:50]})",
                )

        # -- Cleanup --
        heartbeat_task.cancel()
        print("Agent shutting down.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nAgent stopped by user.")
