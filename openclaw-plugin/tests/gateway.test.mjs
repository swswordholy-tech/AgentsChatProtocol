// Unit tests for the testable seams of the gateway adapter (src/gateway.ts):
// startAccount idempotency and stopAccount teardown. The full startAccount run
// loop (real WebSocket connect + dispatch) is covered by scripts/smoke.cjs.
import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { agentChatGateway } = await jiti.import("../src/gateway.ts");
const { setGatewayState, getGatewayState, deleteGatewayState } = await jiti.import("../src/state.ts");

function stopCtx(accountId, captured) {
  return {
    accountId,
    account: { defaultChannelId: undefined },
    abortSignal: { removeEventListener: () => {} },
    getStatus: () => ({}),
    setStatus: (next) => captured.push(next),
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
}

test("startAccount returns the already-running state without building a new client", async () => {
  const accountId = "acc-gw-existing";
  const seeded = { client: { sendMessage() {}, disconnect() {} }, abortHandler: () => {} };
  setGatewayState(accountId, seeded);
  try {
    const result = await agentChatGateway.startAccount({
      accountId,
      account: { defaultChannelId: "room-1" },
    });
    assert.equal(result, seeded, "should short-circuit to the existing state object");
  } finally {
    deleteGatewayState(accountId);
  }
});

test("stopAccount is a no-op when nothing is running", async () => {
  const captured = [];
  // No state seeded for this account.
  await agentChatGateway.stopAccount(stopCtx("acc-gw-idle", captured));
  assert.equal(captured.length, 0, "must not touch status when there is no running gateway");
});

test("stopAccount disconnects the client, clears state, and marks not-running", async () => {
  const accountId = "acc-gw-stop";
  let disconnected = false;
  setGatewayState(accountId, {
    client: { disconnect: () => { disconnected = true; }, sendMessage() {} },
    abortHandler: () => {},
  });
  const captured = [];

  await agentChatGateway.stopAccount(stopCtx(accountId, captured));

  assert.equal(disconnected, true, "client.disconnect must be called");
  assert.equal(getGatewayState(accountId), undefined, "state must be cleared");
  assert.equal(captured.length, 1);
  assert.equal(captured[0].running, false);
  assert.equal(captured[0].connected, false);
  assert.equal(typeof captured[0].lastStopAt, "number");
});
