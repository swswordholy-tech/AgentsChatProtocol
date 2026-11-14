import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { buildInboundPolicy } = await jiti.import('../src/policy.ts');
const { agentChatConfig: config } = await jiti.import('../src/config.ts');
const { parseConversationId, buildConversationId } = await jiti.import('../src/conversation.ts');
const { agentChatMessaging } = await jiti.import('../src/messaging.ts');
const { agentChatOutbound } = await jiti.import('../src/outbound.ts');
const { getMentionCursor, setMentionCursor, setGatewayState, deleteGatewayState } = await jiti.import('../src/state.ts');
const account = { accountId: 'hardening', agentId: 'bot', token: 'ac_secret', wsUrl: 'wss://example.com/ws', enabled: true };
let nextId = 0;
const message = (overrides = {}) => ({ id: `m-${++nextId}`, channel_id: `hardening-${nextId}`, sender_id: 'other', content: '@bot help', timestamp: '2026-11-14T10:00:00.000Z', ...overrides });
async function withFetch(fetcher, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  try { return await run(); } finally { globalThis.fetch = original; }
}
const policy = (msg, extra = {}) => buildInboundPolicy({ account, accountId: account.accountId, message: msg, ...extra });

test('self echoes in groups and DMs never fetch or dispatch', async () => {
  await withFetch(() => { throw new Error('unexpected fetch'); }, async () => {
    for (const channel_id of ['group', 'dm-private']) {
      assert.equal((await policy(message({ channel_id, sender_id: 'bot' }))).shouldDispatch, false);
    }
    assert.equal((await policy(message({ channel_id: 'dm-private', sender_id: 'other' }))).shouldDispatch, true);
  });
});

test('history cancels failed response before fallback and forbids redirects', async () => {
  let cancelled = false;
  const logs = [];
  await withFetch(async (_url, init) => {
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer ac_secret');
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 });
  }, async () => {
    const result = await policy(message(), { log: (...args) => { assert.equal(cancelled, true); logs.push(args); } });
    assert.equal(result.bodyForAgent, '@bot help');
  });
  assert.equal(cancelled, true);
  assert.match(logs[0][2].error, /HTTP 503/);
});

test('history URL rejects schemes, URL credentials and remote plaintext before fetch', async () => {
  await withFetch(() => { throw new Error('unexpected fetch'); }, async () => {
    for (const wsUrl of ['https://example.com/ws', 'file:///ws', 'ws://example.com/ws', 'wss://u:p@example.com/ws', 'ws://localhost.evil/ws']) {
      const logs = [];
      await policy(message(), { account: { ...account, wsUrl }, log: (...args) => logs.push(args) });
      assert.equal(logs.length, 1);
      assert.doesNotMatch(logs[0][2].error, /unexpected fetch|u:p/);
    }
  });
});

test('history supports secure remote and the three plaintext loopback forms', async () => {
  for (const wsUrl of ['wss://example.com/prefix/ws?q=1#hash', 'ws://127.0.0.1:123/ws', 'ws://localhost/ws', 'ws://[::1]/ws']) {
    let fetched = false;
    await withFetch(async (url) => {
      fetched = true;
      assert.match(url, /^https?:\/\//);
      assert.doesNotMatch(url, /#|q=1/);
      return Response.json({ messages: [{ id: 'past', sender_id: 'friend', content: 'context' }] });
    }, async () => assert.match((await policy(message(), { account: { ...account, wsUrl } })).bodyForAgent, /friend: context/));
    assert.equal(fetched, true);
  }
});

test('history enforces actual streamed bytes with cancellation, independent of headers', async () => {
  let cancelled = false;
  const bytes = new TextEncoder().encode(JSON.stringify({ messages: [], padding: '汉'.repeat(180000) }));
  let offset = 0;
  await withFetch(async () => new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.subarray(offset, offset + 4096)); offset += 4096;
    },
    cancel() { cancelled = true; },
  }), { headers: { 'content-length': '2' } }), async () => {
    const logs = [];
    assert.equal((await policy(message(), { log: (...args) => logs.push(args) })).bodyForAgent, '@bot help');
    assert.match(logs[0][2].error, /byte limit/);
  });
  assert.equal(cancelled, true);
  assert.ok(offset < bytes.length);
});

test('history accepts exactly 512KiB and UTF8 characters split across chunks', async () => {
  const text = JSON.stringify({ messages: [{ id: 'past', sender_id: 'friend', content: '汉🙂' }], padding: '' });
  const bytes = new TextEncoder().encode(text.replace('"padding":""', `"padding":"${' '.repeat(512 * 1024 - Buffer.byteLength(text))}"`));
  assert.equal(bytes.length, 512 * 1024);
  let offset = 0;
  await withFetch(async () => new Response(new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = offset < 256 ? offset + 1 : Math.min(offset + 16384, bytes.length);
      controller.enqueue(bytes.subarray(offset, end)); offset = end;
    },
  })), async () => assert.match((await policy(message())).bodyForAgent, /friend: 汉🙂/));
});

test('history error logs redact Bearer and ac_ credentials', async () => {
  for (const error of [new Error('Bearer top-secret ac_private_key'), 'bearer another-secret AC_uppercase']) {
    await withFetch(async () => { throw error; }, async () => {
      const logs = [];
      await policy(message(), { log: (...args) => logs.push(args) });
      assert.doesNotMatch(logs[0][2].error, /top-secret|private_key|another-secret|uppercase/);
      assert.match(logs[0][2].error, /redacted/);
    });
  }
});

test('invalid timestamps preserve a cursor; compound cursor keys cannot collide', async () => {
  setMentionCursor('a:b', 'c', 'first'); setMentionCursor('a', 'b:c', 'second');
  assert.equal(getMentionCursor('a:b', 'c'), 'first');
  assert.equal(getMentionCursor('a', 'b:c'), 'second');
  const channel_id = 'cursor-validation';
  const conversationId = buildConversationId(channel_id);
  setMentionCursor(account.accountId, conversationId, 'old');
  await withFetch(async () => Response.json({ messages: [] }), async () => {
    for (const timestamp of [undefined, null, 123, '', '   ']) {
      await policy(message({ channel_id, timestamp }));
      assert.equal(getMentionCursor(account.accountId, conversationId), 'old');
    }
    await policy(message({ channel_id, timestamp: 'new' }));
    assert.equal(getMentionCursor(account.accountId, conversationId), 'new');
  });
});

test('account keys exclude reserved names including explicit and default selection', () => {
  for (const id of ['__proto__', 'constructor', 'prototype', 'CONSTRUCTOR', 'Prototype']) {
    const cfg = { channels: { agentchat: { accounts: JSON.parse(`{"${id}": {"agentId":"evil","token":"secret"},"good":{"agentId":"ok","token":"valid"}}`) } } };
    assert.deepEqual(config.listAccountIds(cfg), ['good']);
    assert.equal(config.resolveAccount(cfg).agentId, 'ok');
    assert.throws(() => config.resolveAccount(cfg, id), /missing/);
    assert.throws(() => config.inspectAccount(cfg, id), /missing/);
    cfg.channels.agentchat.defaultAccountId = id;
    assert.throws(() => config.defaultAccountId(cfg), /missing/);
  }
  const cfg = { channels: { agentchat: { accounts: Object.create({ default: { agentId: 'inherited', token: 'secret' } }) } } };
  assert.equal(config.resolveAccount(cfg).agentId, undefined);
  assert.equal(config.inspectAccount(cfg), null);
});

test('account configuration trims fields and whitespace credentials remain unconfigured', () => {
  const cfg = { channels: { agentchat: { accounts: { good: { name: ' Name ', agentId: ' bot ', token: ' key ', wsUrl: ' wss://example.com/ws ', defaultChannelId: ' room ' } } } } };
  const resolved = config.resolveAccount(cfg);
  assert.deepEqual([resolved.name, resolved.agentId, resolved.token, resolved.wsUrl, resolved.defaultChannelId], ['Name', 'bot', 'key', 'wss://example.com/ws', 'room']);
  assert.equal(config.isConfigured(resolved), true);
  for (const partial of [{ agentId: ' ', token: 'key' }, { agentId: 'bot', token: '\t' }]) {
    assert.equal(config.isConfigured(partial), false);
    assert.match(config.unconfiguredReason(partial), /Missing/);
    assert.equal(config.describeAccount(partial).configured, false);
    assert.equal(config.describeAccount(partial).linked, false);
  }
});

test('empty parsed channels and outbound targets never reach the client', async () => {
  for (const id of ['agentchat:channel:', 'agentchat:channel:  ', 'agentchat:channel::thread:t', 'agentchat:channel: :thread:t']) {
    assert.equal(parseConversationId(id), null);
    assert.equal(agentChatMessaging.resolveDeliveryTarget({ conversationId: id }), null);
  }
  const sent = [];
  setGatewayState('target-test', { client: { sendMessage: (...args) => sent.push(args) } });
  try {
    for (const to of [undefined, '', '  ']) await assert.rejects(() => agentChatOutbound.sendText({ accountId: 'target-test', to, text: 'test' }), /target is required/);
    assert.equal(sent.length, 0);
    const result = await agentChatOutbound.sendText({ accountId: 'target-test', to: ' room ', text: 'test', threadId: 'thread' });
    assert.deepEqual(sent, [['room', 'test', 'thread']]);
    assert.equal(result.channelId, 'room');
    assert.equal(result.conversationId, 'agentchat:channel:room:thread:thread');
  } finally { deleteGatewayState('target-test'); }
});
