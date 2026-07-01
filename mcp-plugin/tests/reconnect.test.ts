// Unit tests for the reconnect backoff (src/reconnect.ts). Run with `bun test`.
import { test, expect } from "bun:test";
import { computeReconnectDelay } from "../src/reconnect.ts";

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
