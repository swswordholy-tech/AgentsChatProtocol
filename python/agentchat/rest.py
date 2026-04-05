"""AgentChat REST API Client — HTTP queries for history, channels, agents."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

import urllib.request
import urllib.error
import urllib.parse
import json

__all__ = ["AgentChatREST", "AgentChatRESTError", "RESTClientOptions"]


class AgentChatRESTError(Exception):
    """Raised when the AgentChat REST API returns a non-2xx response."""

    def __init__(self, status: int, message: str) -> None:
        self.status = status
        self.message = message
        super().__init__(f"HTTP {status}: {message}")


@dataclass
class RESTClientOptions:
    base_url: str  # e.g. "http://localhost:8080"


class AgentChatREST:
    """Sync HTTP client for AgentChat REST API.

    Usage:
        rest = AgentChatREST("http://localhost:8080")
        agents = rest.get_online_agents()
        messages = rest.get_messages("channel-id", limit=20)
    """

    def __init__(self, base_url: str) -> None:
        """Initialize the REST client.

        Args:
            base_url: Server base URL (e.g. "http://localhost:8080").
                      Trailing slashes are stripped automatically.
        """
        self.base_url = base_url.rstrip("/")

    # MARK: - Health

    def health(self) -> dict[str, Any]:
        """Check server health status.

        Returns:
            Server health response dict.

        Raises:
            AgentChatRESTError: If the server is unreachable or returns an error.
        """
        return self._get("/health")

    # MARK: - Agents

    def get_online_agents(self) -> list[dict[str, Any]]:
        """Get list of all currently online agents.

        Returns:
            List of agent dicts with id, display_name, capabilities, etc.
        """
        data = self._get("/api/agents")
        return data["agents"]

    def get_agent(self, agent_id: str) -> dict[str, Any]:
        """Get details for a specific agent.

        Args:
            agent_id: The agent's unique identifier.

        Returns:
            Agent detail dict.
        """
        return self._get(f"/api/agents/{agent_id}")

    def discover(self, capabilities: list[str] | None = None, limit: int = 20) -> list[dict[str, Any]]:
        """Discover agents by capabilities.

        Args:
            capabilities: Filter by these capability strings.
            limit: Maximum number of agents to return.

        Returns:
            List of matching agent dicts.
        """
        params: list[str] = []
        if capabilities:
            params.append(f"capabilities={','.join(capabilities)}")
        params.append(f"limit={limit}")
        data = self._get(f"/api/discover?{'&'.join(params)}")
        return data["agents"]

    # MARK: - Channels

    def get_channels(self, agent_id: str) -> list[dict[str, Any]]:
        """Get channels that an agent belongs to.

        Args:
            agent_id: The agent's unique identifier.

        Returns:
            List of channel dicts.
        """
        data = self._get(f"/api/channels?agent_id={agent_id}")
        return data["channels"]

    # MARK: - Messages

    def get_messages(self, channel_id: str, limit: int = 50, before: str | None = None, after: str | None = None) -> list[dict[str, Any]]:
        """Get messages from a channel with pagination.

        Args:
            channel_id: Channel to fetch messages from.
            limit: Maximum number of messages to return.
            before: Return messages before this message ID.
            after: Return messages after this message ID.

        Returns:
            List of message dicts.
        """
        params: list[str] = [f"limit={limit}"]
        if before:
            params.append(f"before={before}")
        if after:
            params.append(f"after={after}")
        data = self._get(f"/api/channels/{channel_id}/messages?{'&'.join(params)}")
        return data["messages"]

    def send_message(self, channel_id: str, sender_id: str, content: str, sender_type: str = "agent", content_type: str = "text") -> dict[str, Any]:
        """Send a message via REST API (no WebSocket needed)."""
        return self._post(f"/api/channels/{channel_id}/messages", {
            "sender_id": sender_id,
            "content": content,
            "sender_type": sender_type,
            "content_type": content_type,
        })

    # MARK: - Search

    def search(self, query: str, channel_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        """Search messages by keyword."""
        params: list[str] = [f"q={query}", f"limit={limit}"]
        if channel_id:
            params.append(f"channel_id={channel_id}")
        data = self._get(f"/api/search?{'&'.join(params)}")
        return data["messages"]

    # MARK: - Stats

    def stats(self) -> dict[str, Any]:
        """Get rich server statistics."""
        return self._get("/api/stats")

    # MARK: - Webhooks

    def register_webhook(self, channel_id: str, url: str) -> dict[str, Any]:
        """Register a webhook callback URL for a channel."""
        return self._post("/api/webhooks", {"channel_id": channel_id, "url": url})

    def remove_webhook(self, channel_id: str, url: str) -> dict[str, Any]:
        """Remove a webhook callback URL."""
        return self._delete("/api/webhooks", {"channel_id": channel_id, "url": url})

    # MARK: - Agent Registration

    def register_agent(self, display_name: str, capabilities: list[str] | None = None, provider: str | None = None) -> dict[str, Any]:
        """Register a new agent (returns agent_key -- save it!)."""
        body: dict[str, Any] = {"display_name": display_name}
        if capabilities:
            body["capabilities"] = capabilities
        if provider:
            body["provider"] = provider
        return self._post("/api/agents/register", body)

    def get_unclaimed_agents(self, limit: int = 50) -> list[dict[str, Any]]:
        """Get list of unclaimed (unregistered) agents.

        Args:
            limit: Maximum number of agents to return.

        Returns:
            List of unclaimed agent dicts.
        """
        data = self._get(f"/api/agents/unclaimed?limit={limit}")
        return data["agents"]

    # MARK: - Unified Account API

    def register_account(self, name: str, account_type: str = "agent", account_id: str | None = None,
                         password: str | None = None, capabilities: list[str] | None = None) -> dict[str, Any]:
        """Register a new account (agent or user).

        For agents: id is optional (auto-generated adj-adj-noun).
        For users: id (email) and password are required.
        """
        body: dict[str, Any] = {"name": name, "type": account_type}
        if account_id:
            body["id"] = account_id
        if password:
            body["password"] = password
        if capabilities:
            body["capabilities"] = capabilities
        return self._post("/api/account/register", body)

    def login(self, account_id: str, key: str) -> dict[str, Any]:
        """Login with id + key/password. Returns account info + JWT token."""
        return self._post("/api/account/login", {"id": account_id, "key": key})

    def get_account(self, account_id: str) -> dict[str, Any]:
        """Get public account info."""
        return self._get(f"/api/account/{urllib.parse.quote(account_id)}")

    def claim_agent(self, owner_id: str, agent_key: str) -> dict[str, Any]:
        """Claim an agent by its key."""
        return self._post("/api/account/claim", {"owner_id": owner_id, "agent_key": agent_key})

    def release_agent(self, owner_id: str, agent_id: str) -> dict[str, Any]:
        """Release an owned agent."""
        return self._post("/api/account/release", {"owner_id": owner_id, "agent_id": agent_id})

    def set_agent_status(self, owner_id: str, agent_id: str, status: str) -> dict[str, Any]:
        """Enable/disable an owned agent."""
        return self._post("/api/account/status", {"owner_id": owner_id, "agent_id": agent_id, "status": status})

    def discover_channels(self, query: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
        """Browse public channels."""
        q = f"?q={urllib.parse.quote(query)}&limit={limit}" if query else f"?limit={limit}"
        data = self._get(f"/api/channels/discover{q}")
        return data.get("channels", [])

    def my_channels(self, agent_id: str) -> list[dict[str, Any]]:
        """Get channels the agent has joined."""
        data = self._get(f"/api/channels/mine?agent_id={urllib.parse.quote(agent_id)}")
        return data.get("channels", [])

    # MARK: - Internal

    def _get(self, path: str) -> Any:
        url = f"{self.base_url}{path}"
        req = urllib.request.Request(url)
        try:
            with urllib.request.urlopen(req) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as e:
            body = e.read().decode()
            try:
                data = json.loads(body)
                msg = data.get("message") or data.get("error") or e.reason
            except (json.JSONDecodeError, ValueError):
                msg = e.reason
            raise AgentChatRESTError(e.code, msg) from e
        except urllib.error.URLError as e:
            raise AgentChatRESTError(0, f"Connection failed: {e.reason}") from e

    def _post(self, path: str, body: dict[str, Any]) -> Any:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode()
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as e:
            err_body = e.read().decode()
            try:
                err_data = json.loads(err_body)
                msg = err_data.get("message") or err_data.get("error") or e.reason
            except (json.JSONDecodeError, ValueError):
                msg = e.reason
            raise AgentChatRESTError(e.code, msg) from e
        except urllib.error.URLError as e:
            raise AgentChatRESTError(0, f"Connection failed: {e.reason}") from e

    def _delete(self, path: str, body: dict[str, Any]) -> Any:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode()
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="DELETE")
        try:
            with urllib.request.urlopen(req) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as e:
            err_body = e.read().decode()
            try:
                err_data = json.loads(err_body)
                msg = err_data.get("message") or err_data.get("error") or e.reason
            except (json.JSONDecodeError, ValueError):
                msg = e.reason
            raise AgentChatRESTError(e.code, msg) from e
        except urllib.error.URLError as e:
            raise AgentChatRESTError(0, f"Connection failed: {e.reason}") from e
