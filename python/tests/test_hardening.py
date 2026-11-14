"""Regression coverage for cancellation, credential diagnostics and transient frames."""
import asyncio
import io
import json
import sys
import traceback
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agentchat import AgentChatClient, AgentChatREST, AgentChatRESTError
from test_sdk import _FakeWebSocket


class HardeningTests(unittest.IsolatedAsyncioTestCase):
    async def client(self, frames):
        ws = _FakeWebSocket()
        for frame in frames:
            await ws.server_to_client.put(json.dumps(frame))
        async def factory(*args, **kwargs):
            return ws
        client = AgentChatClient("ws://localhost/ws", "bot", "private-token", ws_factory=factory)
        return client, ws

    async def test_cancel_auth_closes_socket(self):
        client, ws = await self.client([])
        pending = asyncio.create_task(client.connect())
        await ws.client_to_server.get()  # auth was sent; recv is now pending
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.assertTrue(ws.closed)
        self.assertIsNone(client._ws)
        self.assertFalse(client._running)

    async def test_typing_sentinel_is_not_a_chat_message(self):
        base = {"type": "message", "id": "m", "channel_id": "room", "sender_id": "peer"}
        client, ws = await self.client([
            {"type": "auth_ok", "session_id": "s"},
            dict(base, content="__typing__"), dict(base, content="__typing__ ordinary text"),
            {"type": "please_reconnect"},
        ])
        await client.connect()
        messages = [m async for m in client.messages()]
        self.assertEqual([m.content for m in messages], ["__typing__ ordinary text"])
        self.assertTrue(ws.closed)
        self.assertFalse(client._running)
        self.assertIsNone(client._session_id)

    async def test_auth_diagnostics_scrub_credentials(self):
        for kind in ("auth_error", "unexpected"):
            client, ws = await self.client([{"type": kind, "message": "private-token ac_other_key Bearer another-secret"}])
            with self.assertRaises(ConnectionError) as ctx:
                await client.connect()
            rendered = ''.join(traceback.format_exception(ctx.exception))
            for secret in ("private-token", "ac_other_key", "another-secret"):
                self.assertNotIn(secret, rendered)
            self.assertTrue(ws.closed)

    async def test_handshake_exception_cause_does_not_leak(self):
        client, ws = await self.client([])
        async def fail():
            raise ValueError("private-token ac_other_key")
        ws.recv = fail
        with self.assertRaises(ConnectionError) as ctx:
            await client.connect()
        rendered = ''.join(traceback.format_exception(ctx.exception))
        self.assertNotIn("private-token", rendered)
        self.assertNotIn("ac_other_key", rendered)
        self.assertTrue(ws.closed)

    async def test_nonfinite_timeouts_rejected(self):
        for value in (float('nan'), float('inf'), -1, 0):
            with self.assertRaises(ValueError):
                AgentChatClient("ws://localhost", "bot", connect_timeout=value)
            with self.assertRaises(ValueError):
                AgentChatREST("http://localhost", timeout=value)


class HTTPHardeningTests(unittest.TestCase):
    def test_error_response_is_closed_and_traceback_scrubbed(self):
        body = io.BytesIO(json.dumps({"message": "private-token ac_other_key Bearer another-secret"}).encode())
        error = urllib.error.HTTPError("http://localhost", 403, "Forbidden", {}, body)
        with patch('urllib.request.urlopen', side_effect=error):
            with self.assertRaises(AgentChatRESTError) as ctx:
                AgentChatREST("http://localhost", token="private-token").health()
        self.assertTrue(body.closed)
        rendered = ''.join(traceback.format_exception(ctx.exception))
        for secret in ("private-token", "ac_other_key", "another-secret"):
            self.assertNotIn(secret, rendered)
        self.assertEqual(ctx.exception.status, 403)

    def test_error_body_timeout_also_closes_response(self):
        class StalledBody(io.BytesIO):
            def read(self, *args):
                raise TimeoutError("private-token")
        body = StalledBody()
        error = urllib.error.HTTPError("http://localhost", 503, "Unavailable", {}, body)
        with patch('urllib.request.urlopen', side_effect=error):
            with self.assertRaisesRegex(AgentChatRESTError, "Request timed out"):
                AgentChatREST("http://localhost", token="private-token").health()
        self.assertTrue(body.closed)

    def test_transport_reason_is_redacted_without_raw_exception_chain(self):
        error = urllib.error.URLError("Bearer another-secret ac_other_key private-token")
        with patch('urllib.request.urlopen', side_effect=error):
            with self.assertRaises(AgentChatRESTError) as ctx:
                AgentChatREST("http://localhost", token="private-token").health()
        rendered = ''.join(traceback.format_exception(ctx.exception))
        for secret in ("private-token", "ac_other_key", "another-secret"):
            self.assertNotIn(secret, rendered)
