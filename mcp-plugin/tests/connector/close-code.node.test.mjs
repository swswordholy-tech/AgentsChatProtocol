import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';

const root = fileURLToPath(new URL('../../', import.meta.url));
const identity = { botId: 'agent-a', agentId: 'agent-a', gatewayId: 'gw-a', secret: 'FAKE_SECRET_a', token: 'FAKE_TOKEN_a' };
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < deadline, 'fixture deadline'); await delay(10); }
}
function token(secret = identity.secret) {
  const payload = `${identity.gatewayId}:0`;
  return Buffer.from(`${payload}:${createHmac('sha256', secret).update(payload).digest('hex')}`).toString('base64url');
}
function hermes(closes) {
  if (!process.env.HERMES_WS_TRANSPORT_SOURCE) return null;
  const result = spawnSync('python3', [fileURLToPath(new URL('./hermes-close-probe.py', import.meta.url)), process.env.HERMES_WS_TRANSPORT_SOURCE, JSON.stringify(closes)], { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'close-code-node-'));
  const file = join(home, 'identities.json');
  writeFileSync(file, JSON.stringify([identity]));
  const hub = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/channels/mine' ? { channels: [] } : { messages: [] }));
  });
  const upstream = new WebSocketServer({ server: hub });
  upstream.on('connection', ws => ws.on('message', data => {
    const frame = JSON.parse(String(data));
    if (frame.type === 'auth') ws.send(JSON.stringify({ type: 'auth_ok' }));
    if (frame.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
  }));
  await new Promise(resolve => hub.listen(0, '127.0.0.1', resolve));
  const url = `127.0.0.1:${hub.address().port}`;
  const proc = spawn('node', ['src/cli.mjs', '--connector'], {
    cwd: root, env: { HOME: home, PATH: process.env.PATH, RELAY_IDENTITIES_FILE: file, RELAY_PORT: '0', AGENTCHAT_API_URL: `http://${url}`, AGENTCHAT_WS_URL: `ws://${url}/ws`, AGENTCHAT_CURSOR_DIR: home }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  const exited = new Promise(resolve => proc.once('exit', resolve));
  let logs = '';
  proc.stderr.on('data', data => { logs += data; });
  const clients = [];
  try { await until(() => /listening on 127\.0\.0\.1:(\d+)/.test(logs)); }
  catch (e) { proc.kill(); await exited; upstream.clients.forEach(c => c.terminate()); upstream.close(); hub.close(); rmSync(home, { recursive: true, force: true }); throw e; }
  const port = logs.match(/listening on 127\.0\.0\.1:(\d+)/)[1];
  return {
    async dial(secret) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`, { headers: { Authorization: `Bearer ${token(secret)}` } });
      clients.push(ws);
      const frames = [];
      let close;
      ws.on('message', data => frames.push(JSON.parse(String(data))));
      ws.on('close', (code, reason) => { close = { code, reason: String(reason) }; });
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      return { ws, frames, closed: () => close, hello: () => ws.send(JSON.stringify({ type: 'hello', platform: 'agentschat', botId: identity.botId })) };
    },
    async reload(ids) {
      const before = (logs.match(/hot-reload/g) ?? []).length;
      writeFileSync(file, JSON.stringify(ids)); proc.kill('SIGHUP');
      await until(() => (logs.match(/hot-reload/g) ?? []).length > before);
    },
    async stop() {
      clients.forEach(c => c.terminate()); proc.kill(); await exited;
      upstream.clients.forEach(c => c.terminate()); upstream.close();
      await new Promise(resolve => hub.close(resolve)); rmSync(home, { recursive: true, force: true });
    },
  };
}

test('Node bundle: prior success, repeated missing identity, table repair recovers without auth revocation', async () => {
  const f = await fixture();
  try {
    const first = await f.dial(); first.hello();
    await until(() => first.frames.some(f => f.type === 'descriptor'));
    // Preserve accepted upgrade credentials while temporarily misconfiguring botId.
    await f.reload([{ ...identity, botId: 'temporarily-wrong' }]);
    first.hello(); await until(first.closed);
    const second = await f.dial(); second.hello(); await until(second.closed);
    const closes = [first.closed(), second.closed()];
    const state = hermes(closes);
    if (state) {
      assert.equal(state.reader.some(s => s.auth_revoked), false, `Hermes latched on recoverable hello: ${JSON.stringify(state)}`);
      assert.deepEqual(state.reader.map(s => s.retry), ['normal', 'normal']);
      assert.equal(state.dial_latched, false);
    }
    assert.deepEqual(closes, Array(2).fill({ code: 1002, reason: 'hello rejected: unknown_identity' }));
    assert.equal(second.frames.some(f => f.type === 'descriptor'), false);
    assert.equal(first.frames.filter(f => f.type === 'descriptor').length, 1);
    await f.reload([identity]);
    const recovered = await f.dial(); recovered.hello();
    await until(() => recovered.frames.some(f => f.type === 'descriptor'));
    recovered.ws.send(JSON.stringify({ type: 'outbound', requestId: 'recovered', botId: identity.botId, action: { op: 'get_chat_info', chat_id: 'room' } }));
    await until(() => recovered.frames.some(f => f.requestId === 'recovered'));
    assert.deepEqual(recovered.frames.find(f => f.requestId === 'recovered').result, { name: 'room', type: 'group' });
    assert.equal(recovered.closed(), undefined);
  } finally { await f.stop(); }
});

test('Node bundle: refused upgrade credentials retain terminal 4401 semantics', async () => {
  const f = await fixture();
  try {
    const accepted = await f.dial(); accepted.hello();
    await until(() => accepted.frames.some(f => f.type === 'descriptor'));
    await f.reload([{ ...identity, secret: 'FAKE_ROTATED' }]);
    const closes = [];
    for (let i = 0; i < 2; i++) {
      const c = await f.dial(); await until(c.closed);
      assert.deepEqual(c.closed(), { code: 4401, reason: 'unauthorized' });
      assert.equal(c.frames.some(f => f.type === 'descriptor'), false);
      closes.push(c.closed());
    }
    const state = hermes(closes);
    if (state) {
      assert.equal(state.reader[0].retry, 'fresh-token');
      assert.equal(state.reader[1].auth_revoked, true);
      assert.equal(state.reader[1].retry, null);
      assert.equal(state.dial_latched, true);
    }
  } finally { await f.stop(); }
});
