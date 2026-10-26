import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const { agentChatConfig } = await createJiti(import.meta.url).import("../src/config.ts");
const cfg = (defaultAccountId) => ({ channels: { agentchat: {
  accounts: { a: { agentId: "a", token: "test-a" }, b: { agentId: "b", token: "test-b" } },
  ...(defaultAccountId === undefined ? {} : { defaultAccountId }),
} } });
test("explicit account wins, invalid explicit/default never falls back", () => {
  assert.equal(agentChatConfig.resolveAccount(cfg("b"), "a").agentId, "a");
  assert.throws(() => agentChatConfig.resolveAccount(cfg("b"), "missing"), /missing/);
  assert.throws(() => agentChatConfig.resolveAccount(cfg("missing")), /missing/);
  assert.throws(() => agentChatConfig.resolveAccount(cfg(), ""), /missing/);
});
test("ambiguous accounts require selection, configured default is reused", () => {
  assert.throws(() => agentChatConfig.defaultAccountId(cfg()), /Multiple/);
  assert.equal(agentChatConfig.defaultAccountId(cfg("b")), "b");
  assert.equal(agentChatConfig.defaultAccountId({}), "default");
  assert.equal(agentChatConfig.defaultAccountId({ channels: { agentchat: { accounts: { solo: {} } } } }), "solo");
});
