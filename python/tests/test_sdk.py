"""Unit tests for AgentsChat Python SDK (rest.py & client.py)."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import socket
import sys
import threading
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import websockets
from websockets.exceptions import ConnectionClosedOK
from websockets.frames import Close

from agentchat import (
    AgentChatClient,
    AgentChatREST,
    AgentChatRESTError,
    AgentStatus,
    ContentType,
    SenderType,
)


class _FakeWebSocket:
    """Deterministic in-memory WebSocket connection for unit tests."""

    def __init__(self) -> None:
        self.client_to_server: asyncio.Queue[str | None] = asyncio.Queue()
        self.server_to_client: asyncio.Queue[str | None] = asyncio.Queue()
        self.closed = False
        self.connect_kwargs: dict[str, Any] = {}

    async def send(self, payload: str) -> None:
        if self.closed:
            raise ConnectionClosedOK(Close(1000, "closed"), Close(1000, "closed"), True)
        await self.client_to_server.put(payload)

    async def recv(self) -> str:
        item = await self.server_to_client.get()
        if item is None:
            raise ConnectionClosedOK(Close(1000, "closed"), Close(1000, "closed"), True)
        return item

    async def close(self) -> None:
        if not self.closed:
            self.closed = True
            await self.server_to_client.put(None)
            await self.client_to_server.put(None)


class _RecordingHTTPHandler(BaseHTTPRequestHandler):
    recorded: list[dict[str, Any]] = []
    oversized_mode: bool = False

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        return

    def _handle(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode("utf-8") if length > 0 else ""
        type(self).recorded.append({
            "method": self.command,
            "path": self.path,
            "auth": self.headers.get("Authorization"),
            "body": body,
        })
        if type(self).oversized_mode:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"x" * (4 * 1024 * 1024 + 64))
            return

        if self.path.startswith("/error"):
            self.send_response(403)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "forbidden channel"}).encode("utf-8"))
            return

        payload = {
            "ok": True,
            "agents": [{"id": "ag-1"}],
            "channels": [{"id": "ch-1"}],
            "messages": [{"id": "m-1"}],
        }
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode("utf-8"))

    do_GET = _handle
    do_POST = _handle
    do_DELETE = _handle


class TestAgentChatREST(unittest.TestCase):
    def setUp(self) -> None:
        _RecordingHTTPHandler.recorded = []
        _RecordingHTTPHandler.oversized_mode = False
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _RecordingHTTPHandler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)

    def test_bearer_header_and_path_query_encoding(self) -> None:
        rest = AgentChatREST(f"http://127.0.0.1:{self.port}/", token="ac_secret_123", timeout=3.0)
        rest.get_agent("team/agent#1")
        rest.get_account("user/with/slash")
        rest.get_messages("ch/alpha", limit=10, before="msg&1")
        rest.search("hello&world=1#frag", channel_id="ch/1", limit=5)
        rest.discover_channels("中文 & Rust#1", limit=7)

        paths = [r["path"] for r in _RecordingHTTPHandler.recorded]
        self.assertEqual(paths[0], "/api/agents/team%2Fagent%231")
        self.assertEqual(paths[1], "/api/account/user%2Fwith%2Fslash")
        self.assertEqual(paths[2], "/api/channels/ch%2Falpha/messages?limit=10&before=msg%261")
        self.assertIn("q=hello%26world%3D1%23frag", paths[3])
        self.assertIn("channel_id=ch%2F1", paths[3])
        self.assertIn("q=%E4%B8%AD%E6%96%87+%26+Rust%231", paths[4])
        for rec in _RecordingHTTPHandler.recorded:
            self.assertEqual(rec["auth"], "Bearer ac_secret_123")

    def test_http_error_extracts_server_error_field(self) -> None:
        rest = AgentChatREST(f"http://127.0.0.1:{self.port}", timeout=3.0)
        with self.assertRaises(AgentChatRESTError) as ctx:
            rest._get("/error")
        self.assertEqual(ctx.exception.status, 403)
        self.assertIn("forbidden channel", ctx.exception.message)

    def test_oversized_response_rejected(self) -> None:
        _RecordingHTTPHandler.oversized_mode = True
        rest = AgentChatREST(f"http://127.0.0.1:{self.port}", timeout=3.0)
        with self.assertRaises(AgentChatRESTError) as ctx:
            rest.health()
        self.assertEqual(ctx.exception.status, 0)
        self.assertIn("exceeded maximum", ctx.exception.message)

    def test_socket_timeout_raises_rest_error(self) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(("127.0.0.1", 0))
        sock.listen(1)
        port = sock.getsockname()[1]
        accepted: list[socket.socket] = []

        def accept_and_stall() -> None:
            try:
                conn, _ = sock.accept()
                accepted.append(conn)
            except OSError:
                pass

        t = threading.Thread(target=accept_and_stall, daemon=True)
        t.start()
        try:
            rest = AgentChatREST(f"http://127.0.0.1:{port}", timeout=0.2)
            with self.assertRaises(AgentChatRESTError) as ctx:
                rest.health()
            self.assertEqual(ctx.exception.status, 0)
            self.assertIn("timed out", ctx.exception.message)
        finally:
            for conn in accepted:
                conn.close()
            sock.close()
            t.join(timeout=1)

    def test_invalid_timeout_rejected(self) -> None:
        with self.assertRaises(ValueError):
            AgentChatREST("http://127.0.0.1:8080", timeout=0)


class TestAgentChatClient(unittest.IsolatedAsyncioTestCase):
    async def test_connect_timeout_closes_stalled_handshake_socket(self) -> None:
        fake_ws = _FakeWebSocket()

        async def factory(_url: str, **kwargs: Any) -> _FakeWebSocket:
            fake_ws.connect_kwargs = kwargs
            return fake_ws

        client = AgentChatClient("ws://localhost:8080/ws", "ag-1", "tok", connect_timeout=0.15, ws_factory=factory)
        with self.assertRaises(ConnectionError) as ctx:
            await client.connect()
        self.assertIn("timed out", str(ctx.exception))
        self.assertTrue(fake_ws.closed)
        self.assertIsNone(client._ws)
        self.assertEqual(fake_ws.connect_kwargs["open_timeout"], 0.15)
        self.assertEqual(fake_ws.connect_kwargs["max_size"], 2 * 1024 * 1024)

    async def test_connect_auth_error_closes_socket_and_raises(self) -> None:
        fake_ws = _FakeWebSocket()
        await fake_ws.server_to_client.put(json.dumps({"type": "auth_error", "reason": "revoked key"}))

        async def factory(_url: str, **_kwargs: Any) -> _FakeWebSocket:
            return fake_ws

        client = AgentChatClient("ws://localhost:8080/ws", "ag-1", "bad-tok", connect_timeout=2.0, ws_factory=factory)
        with self.assertRaises(ConnectionError) as ctx:
            await client.connect()
        self.assertIn("revoked key", str(ctx.exception))
        self.assertTrue(fake_ws.closed)
        self.assertIsNone(client._ws)

    async def test_propose_sets_future_expires_at(self) -> None:
        fake_ws = _FakeWebSocket()
        await fake_ws.server_to_client.put(json.dumps({"type": "auth_ok", "session_id": "sess-1"}))

        async def factory(_url: str, **_kwargs: Any) -> _FakeWebSocket:
            return fake_ws

        before = datetime.now(timezone.utc)
        async with AgentChatClient("ws://localhost:8080/ws", "ag-1", "tok", ws_factory=factory) as client:
            auth_frame = json.loads(await fake_ws.client_to_server.get())
            self.assertEqual(auth_frame["type"], "auth")
            prop_id = await client.propose("ch-1", "Ship fix", "Details", expires_in_hours=12)
            frame = json.loads(await fake_ws.client_to_server.get())

        self.assertEqual(frame["id"], prop_id)
        expires = datetime.fromisoformat(frame["expires_at"])
        delta_hours = (expires - before).total_seconds() / 3600.0
        self.assertGreater(delta_hours, 11.9)
        self.assertLess(delta_hours, 12.2)

    async def test_messages_resilience_unknown_enums_handlers_and_shard_moved(self) -> None:
        fake_ws = _FakeWebSocket()
        await fake_ws.server_to_client.put(json.dumps({"type": "auth_ok", "session_id": "sess-2"}))
        await fake_ws.server_to_client.put("not-json-{{")
        await fake_ws.server_to_client.put(json.dumps({"type": "agent_offline", "agent_id": "peer-9"}))
        await fake_ws.server_to_client.put(json.dumps({
            "type": "thread_reply",
            "id": "tr-1",
            "thread_id": "parent-99",
            "channel_id": "ch-1",
            "sender_id": "peer-9",
            "sender_type": "system_bot",
            "content": "reply body",
            "timestamp": "2026-11-14T00:00:00Z",
        }))
        await fake_ws.server_to_client.put(json.dumps({
            "type": "message",
            "id": "m-42",
            "channel_id": "ch-1",
            "sender_id": "peer-9",
            "sender_type": "human",
            "content": "**bold**",
            "content_type": "markdown",
            "timestamp": "2026-11-14T00:00:01Z",
        }))
        await fake_ws.server_to_client.put(json.dumps({"type": "shard_moved"}))

        async def factory(_url: str, **_kwargs: Any) -> _FakeWebSocket:
            return fake_ws

        thread_events: list[Any] = []
        presence_events: list[Any] = []
        client = AgentChatClient("ws://localhost:8080/ws", "ag-1", "tok", ws_factory=factory)

        def bad_handler(_ev: Any) -> None:
            raise RuntimeError("boom in user callback")

        client.on_presence(bad_handler)
        client.on_presence(lambda card: presence_events.append(card))
        client.on_thread(bad_handler)
        client.on_thread(lambda ev: thread_events.append(ev))

        await client.connect()
        yielded = []
        async for msg in client.messages():
            yielded.append(msg)

        self.assertEqual(len(yielded), 1)
        self.assertEqual(yielded[0].id, "m-42")
        self.assertEqual(yielded[0].sender_type, SenderType.HUMAN)
        self.assertEqual(yielded[0].content_type, ContentType.TEXT)
        self.assertEqual(len(presence_events), 1)
        self.assertEqual(presence_events[0].status, AgentStatus.OFFLINE)
        self.assertEqual(presence_events[0].display_name, "peer-9")
        self.assertEqual(len(thread_events), 1)
        self.assertEqual(thread_events[0].parent_id, "parent-99")
        self.assertTrue(fake_ws.closed)
        self.assertIsNone(client._ws)

    async def test_messages_raises_on_midstream_auth_error_and_heartbeat_exits_cleanly(self) -> None:
        fake_ws = _FakeWebSocket()
        await fake_ws.server_to_client.put(json.dumps({"type": "auth_ok", "session_id": "sess-3"}))
        await fake_ws.server_to_client.put(json.dumps({"type": "auth_error", "message": "token revoked"}))

        async def factory(_url: str, **_kwargs: Any) -> _FakeWebSocket:
            return fake_ws

        client = AgentChatClient("ws://localhost:8080/ws", "ag-1", "tok", ws_factory=factory)
        await client.connect()
        hb_task = asyncio.create_task(client.start_heartbeat(interval=0.05))
        with self.assertRaises(ConnectionError) as ctx:
            async for _ in client.messages():
                pass
        await asyncio.wait_for(hb_task, timeout=0.5)
        self.assertIn("token revoked", str(ctx.exception))
        self.assertFalse(client._running)
        self.assertTrue(fake_ws.closed)
        self.assertIsNone(client._ws)


if __name__ == "__main__":
    unittest.main()
