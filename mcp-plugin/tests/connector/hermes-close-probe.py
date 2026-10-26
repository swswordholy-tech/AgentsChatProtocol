"""Execute installed Hermes close handling unchanged, without importing a gateway.

Usage: python3 hermes-close-probe.py /path/to/ws_transport.py '[{code,reason},...]'
AST extraction isolates actual methods from gateway/profile initialization. Socket
iteration and dial scheduling are test doubles; close decisions are real Hermes.
"""
import ast
import asyncio
import json
import logging
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

source = Path(sys.argv[1])
tree = ast.parse(source.read_text())
names = {"_read_loop", "_close_code_of", "_close_reason_of", "_latch_if_fresh_token_refused", "_dialer_running"}
cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and any(getattr(m, "name", None) == "_read_loop" for m in n.body))
methods = [n for n in cls.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names]
assert {n.name for n in methods} == names
constants = [n for n in tree.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in {"_RELAY_UNAUTHORIZED_CLOSE_CODE", "_RELAY_EXPIRED_CLOSE_REASON"} for t in n.targets)]
namespace: dict[str, Any] = dict(asyncio=asyncio, Optional=Optional, logger=logging.getLogger("probe"))
body: list[ast.stmt] = [*constants, ast.ClassDef(name="Probe", bases=[], keywords=[], body=list(methods), decorator_list=[])]
module = ast.Module(body=body, type_ignores=[])
exec(compile(ast.fix_missing_locations(module), str(source), "exec"), namespace)
Probe = namespace["Probe"]

class CloseError(Exception):
    rcvd: SimpleNamespace

class ClosedSocket:
    def __init__(self, close):
        self.error = CloseError("fixture close")
        self.error.rcvd = SimpleNamespace(**close)
    def __aiter__(self):
        return self
    async def __anext__(self):
        raise self.error

async def main():
    p = Probe()
    p._handshake_succeeded = True  # lifetime state after a real accepted descriptor
    p._closing = p._auth_revoked = p._auth_retry_pending = False
    p._reconnect = True
    p._supervisor = p._auth_retry = None
    p._auth_retry_generation = -1
    p._fail_pending = lambda callback: None
    scheduled = []
    async def normal():
        scheduled.append("normal")
    async def fresh():
        scheduled.append("fresh-token")
    p._reconnect_loop, p._redial_with_fresh_token = normal, fresh
    outcomes = []
    for generation, close in enumerate(json.loads(sys.argv[2])):
        if p._auth_retry_pending:
            p._auth_retry_generation = generation
        p._dial_generation = generation
        p._ws = ClosedSocket(close)
        await p._read_loop()
        await asyncio.sleep(0)
        outcomes.append(dict(auth_revoked=p._auth_revoked, retry=scheduled[-1] if len(scheduled) > generation else None))
    # Also exercise the failed-handshake/dial exception path with a pending retry.
    p._auth_retry_pending, p._auth_revoked = True, False
    latched = p._latch_if_fresh_token_refused(ClosedSocket(json.loads(sys.argv[2])[-1]).error)
    print(json.dumps(dict(reader=outcomes, dial_latched=latched)))

asyncio.run(main())
