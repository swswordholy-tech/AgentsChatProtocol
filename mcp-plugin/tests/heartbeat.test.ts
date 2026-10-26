// Unit tests for the HeartbeatMonitor.tick() state machine (src/heartbeat.ts) —
// the dead-connection detector that drives reconnects. Time is controlled by
// stubbing Date.now (the monitor reads it directly); deps are spied via
// counters. Run with `bun test`.
import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  HeartbeatMonitor,
  WS_OPEN,
  WS_CONNECTING,
  WS_CLOSING,
  WS_CLOSED,
} from "../src/heartbeat.ts";

let now = 1_000_000;
const realNow = Date.now;
beforeEach(() => {
  now = 1_000_000;
  Date.now = () => now;
});
afterEach(() => {
  Date.now = realNow;
});

function harness(state: number, opts: { ping?: number; pong?: number; connect?: number } = {}) {
  const calls = { ping: 0, reconnect: 0 };
  let readyState = state;
  const m = new HeartbeatMonitor(
    {
      sendPing: () => {
        calls.ping++;
      },
      reconnect: () => {
        calls.reconnect++;
      },
      getReadyState: () => readyState,
    },
    opts.ping ?? 30_000,
    opts.pong ?? 90_000,
    opts.connect ?? 30_000,
  );
  return { m, calls, setState: (s: number) => (readyState = s) };
}

test("OPEN within the pong window sends a ping and does not reconnect", () => {
  const { m, calls } = harness(WS_OPEN);
  m.receivedPong();
  now += 10_000; // < pongTimeout
  m.tick();
  expect(calls.ping).toBe(1);
  expect(calls.reconnect).toBe(0);
});

test("OPEN past the pong timeout reconnects exactly once, then is a no-op until reset", () => {
  const { m, calls } = harness(WS_OPEN, { pong: 90_000 });
  m.receivedPong();
  now += 90_001; // > pongTimeout
  m.tick();
  expect(calls.reconnect).toBe(1);
  expect(calls.ping).toBe(0); // reconnect path returns before sendPing

  // still timed-out and mid-reconnect → guard suppresses a second reconnect
  now += 90_001;
  m.tick();
  expect(calls.reconnect).toBe(1);

  // once the guard is cleared, a still-dead socket reconnects again
  m.resetReconnecting();
  m.tick();
  expect(calls.reconnect).toBe(2);
});

test("receivedPong clears the reconnect guard and refreshes liveness", () => {
  const { m, calls } = harness(WS_OPEN, { pong: 90_000 });
  m.receivedPong();
  now += 90_001;
  m.tick();
  expect(calls.reconnect).toBe(1);

  m.receivedPong(); // reconnected / alive again
  m.tick(); // back within the window
  expect(calls.ping).toBe(1);
  expect(calls.reconnect).toBe(1);
});

test("CONNECTING under the connect timeout does not reconnect, but does once exceeded", () => {
  const { m, calls } = harness(WS_CONNECTING, { connect: 30_000 });
  m.tick(); // first sighting records connectingSince
  expect(calls.reconnect).toBe(0);
  now += 10_000; // still < connectTimeout
  m.tick();
  expect(calls.reconnect).toBe(0);
  now += 30_001; // now > connectTimeout since first sighting
  m.tick();
  expect(calls.reconnect).toBe(1);
});

test("CLOSED reconnects immediately", () => {
  const { m, calls } = harness(WS_CLOSED);
  m.tick();
  expect(calls.reconnect).toBe(1);
});

test("CLOSING reconnects immediately", () => {
  const { m, calls } = harness(WS_CLOSING);
  m.tick();
  expect(calls.reconnect).toBe(1);
});

test("start() then stop() leaves a live socket alone (ping, no reconnect)", () => {
  const { m, calls } = harness(WS_OPEN);
  m.start();
  m.stop(); // don't leak the interval into the test runner
  now += 10_000;
  m.tick();
  expect(calls.ping).toBe(1);
  expect(calls.reconnect).toBe(0);
});
