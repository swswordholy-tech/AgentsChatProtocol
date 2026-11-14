// Unit tests for the reconnect backoff (src/reconnect.ts). Run with `bun test`.
import { test, expect } from "bun:test";
import {
  computePleaseReconnectDelay,
  computeReconnectDelay,
  resolveDrainReconnectDelay,
  withTimeoutController,
} from "../src/reconnect.ts";

const noJitter = () => 0;

test("delay scales with attempt then caps at 30s", () => {
  expect(computeReconnectDelay(1, noJitter)).toBe(2000); // min(2,30)*1000
  expect(computeReconnectDelay(5, noJitter)).toBe(10000); // min(10,30)*1000
  expect(computeReconnectDelay(15, noJitter)).toBe(30000); // min(30,30)*1000
  expect(computeReconnectDelay(100, noJitter)).toBe(30000); // capped, not unbounded
});

test("jitter adds up to 3s to the base delay", () => {
  expect(computeReconnectDelay(1, () => 0)).toBe(2000);
  expect(computeReconnectDelay(1, () => 0.5)).toBe(2000 + 1500);
  const near = computeReconnectDelay(1, () => 0.999);
  expect(near).toBeGreaterThanOrEqual(2000);
  expect(near).toBeLessThan(2000 + 3000);
});

test("the 30s cap holds even under maximum jitter", () => {
  const d = computeReconnectDelay(1000, () => 0.999);
  expect(d).toBeGreaterThanOrEqual(30000);
  expect(d).toBeLessThan(33000);
});

test("computePleaseReconnectDelay clamps graceful drain jitter into [200ms, 10200ms]", () => {
  expect(computePleaseReconnectDelay(undefined, () => 0)).toBe(200);
  expect(computePleaseReconnectDelay(undefined, () => 0.5)).toBe(1200);
  expect(computePleaseReconnectDelay(60000, () => 0.9999)).toBe(10199);
  expect(computePleaseReconnectDelay(-5, () => 0.25)).toBe(700);
});

test("resolveDrainReconnectDelay spreads shard_moved fleet drains and honors within_ms/jitter_ms", () => {
  expect(resolveDrainReconnectDelay({ reason: "admin_fleet_drain" } as any, () => 0)).toBe(200);
  expect(resolveDrainReconnectDelay({ reason: "admin_fleet_drain" } as any, () => 0.75)).toBe(1700);
  expect(resolveDrainReconnectDelay({ within_ms: 4000 }, () => 0.5)).toBe(2200);
  expect(resolveDrainReconnectDelay({ jitter_ms: 1000, within_ms: 4000 }, () => 0.5)).toBe(700);
});

test("withTimeoutController composes parentSignal with timeoutMs instead of dropping deadline", async () => {
  const parent = new AbortController();
  const { signal, cleanup } = withTimeoutController(parent.signal, 30);
  try {
    expect(signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 55));
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error)?.name).toBe("TimeoutError");
  } finally {
    cleanup();
  }

  // Immediate parent abort also propagates before timeoutMs fires
  const parent2 = new AbortController();
  const { signal: sig2, cleanup: clean2 } = withTimeoutController(parent2.signal, 5000);
  try {
    parent2.abort(new Error("caller_cancelled"));
    expect(sig2.aborted).toBe(true);
    expect((sig2.reason as Error)?.message).toBe("caller_cancelled");
  } finally {
    clean2();
  }
});
