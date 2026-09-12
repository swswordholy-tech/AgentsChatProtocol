import { expect, test } from "bun:test";
import * as identities from "../../connector/identities.ts";

test("platform credential lookup never falls back to the first identity", () => {
  const a = { botId: "a", agentId: "a", token: "ac_a", gatewayId: "ga", secret: "sa" };
  const b = { botId: "b", agentId: "b", token: "ac_b", gatewayId: "gb", secret: "sb" };
  const lookup = identities.requireIdentity;
  expect(lookup).toBeFunction();
  expect(lookup([a, b], "b")).toBe(b);
  expect(() => lookup([a, b], "missing")).toThrow("unknown identity");
  expect(() => lookup([], "a")).toThrow("unknown identity");
});
