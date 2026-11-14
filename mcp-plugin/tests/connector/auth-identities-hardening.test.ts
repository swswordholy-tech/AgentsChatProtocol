import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { makeToken, sign, verifySignature, verifyToken } from "../../connector/auth.ts";
import { IdentityTable, requireIdentity, type Identity } from "../../connector/identities.ts";
import { buildDescriptor } from "../../connector/descriptor.ts";
import { startConnector } from "../../connector/server.ts";

const secret = "fixture-secret";
const identity: Identity = { botId: "bot-a", agentId: "agent-a", token: "ac_fixture", gatewayId: "gateway-a", secret };
function token(exp: string, signedExp = exp): string {
  const sig = createHmac("sha256", secret).update(`gw:with:colon:${signedExp}`).digest("hex");
  return Buffer.from(`gw:with:colon:${exp}:${sig}`).toString("base64url");
}

test("HMAC rejects non-hex extension, odd length, whitespace and truncated signatures", () => {
  const sig = sign("payload", secret);
  for (const bad of [sig + "junk", sig + "g", sig + "0", sig + "\n", " " + sig, sig.slice(1), "", "z".repeat(64)]) {
    expect(verifySignature("payload", bad, [secret])).toBe(false);
  }
  expect(verifySignature("payload", sig.toUpperCase(), ["wrong", secret])).toBe(true);
  expect(verifySignature("changed", sig, [secret])).toBe(false);
  const good = makeToken("gateway", secret);
  const decoded = Buffer.from(good, "base64url").toString();
  expect(verifyToken(Buffer.from(decoded + "junk").toString("base64url"), [secret])).toBeNull();
});

test("expiration requires canonical safe nonnegative integer wire text", () => {
  for (const exp of ["0abc", "-0", "+0", "00", "01", " 0", "0 ", "0.0", "0e0", "", "Infinity", "NaN", "9007199254740992"]) {
    expect(verifyToken(token(exp, "0"), [secret])).toBeNull();
    expect(verifyToken(token(exp), [secret])).toBeNull();
  }
  expect(verifyToken(token("0"), ["old", secret])).toBe("gw:with:colon");
  expect(verifyToken(token("1"), [secret])).toBeNull();
  const future = String(Math.floor(Date.now() / 1000) + 60);
  expect(verifyToken(token(future), [secret])).toBe("gw:with:colon");
});

test("negative and nonfinite TTLs cannot issue immortal credentials", () => {
  for (const ttl of [-1, -0.01, NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
    expect(() => makeToken("gw", secret, ttl)).toThrow(RangeError);
  }
  for (const ttl of [0, 0.25, 10]) expect(verifyToken(makeToken("gw", secret, ttl), [secret])).toBe("gw");
});

test("invalid identity keys and empty credentials fail at every entry point", () => {
  for (const field of ["botId", "agentId"] as const) {
    for (const value of ["", " ", "\t", "__proto__", "constructor", "prototype", "CONSTRUCTOR", "bot a", " bot-a", "bot-a ", "a\0"]) {
      const bad = { ...identity, [field]: value };
      expect(() => new IdentityTable([bad])).toThrow();
      expect(() => requireIdentity([bad], bad.botId)).toThrow();
    }
  }
  expect(() => new IdentityTable([{ botId: "default", agentId: "default", token: "", gatewayId: "", secret: "" }])).toThrow();
  for (const field of ["token", "secret", "gatewayId"] as const) {
    for (const value of ["", " \n"]) expect(() => new IdentityTable([{ ...identity, [field]: value }])).toThrow();
  }
});

test("duplicate bot and agent keys cannot shadow identities or partially reload", () => {
  const table = new IdentityTable([identity]);
  for (const bad of [
    { ...identity, agentId: "agent-b" },
    { ...identity, botId: "bot-b" },
    { ...identity, botId: " bot-a ", agentId: "agent-b" },
    { ...identity, botId: "bot-b", token: " " },
  ]) {
    expect(() => table.replace([identity, bad])).toThrow();
    expect(() => requireIdentity([identity, bad], identity.botId)).toThrow();
    expect(table.size).toBe(1);
    expect(table.forBot("bot-a")?.token).toBe(identity.token);
  }
  expect(table.forBot("__proto__")).toBeNull();
  expect(table.forBot(" bot-a ")).toBeNull();
  expect(requireIdentity([identity], "bot-a")).toBe(identity);
});

test("legacy empty-credential opt-in applies only to construction", () => {
  const placeholder = { botId: "default", agentId: "default", token: "", gatewayId: "", secret: "" };
  const table = new IdentityTable([placeholder], { allowEmptyCredentials: true });
  expect(table.forBot("default")).toEqual(placeholder);
  expect(Object.isFrozen(table.forBot("default"))).toBe(true);
  expect(() => new IdentityTable([placeholder], { allowEmptyCredentials: false })).toThrow();
  for (const field of ["token", "gatewayId", "secret"] as const) {
    expect(() => new IdentityTable([{ ...placeholder, [field]: " \n" }], { allowEmptyCredentials: true })).toThrow();
    expect(() => new IdentityTable([{ ...placeholder, [field]: null } as unknown as Identity], { allowEmptyCredentials: true })).toThrow();
    expect(() => table.replace([{ ...identity, [field]: "" }])).toThrow();
    expect(table.forBot("default")).toEqual(placeholder);
  }
  expect(() => new IdentityTable([{ ...placeholder, botId: "__proto__" }], { allowEmptyCredentials: true })).toThrow();
  expect(() => new IdentityTable([placeholder, placeholder], { allowEmptyCredentials: true })).toThrow();
  expect(() => requireIdentity([placeholder], "default")).toThrow();
  table.replace([identity]);
  expect(table.forBot("default")).toBeNull();
  expect(table.forBot(identity.botId)).toEqual(identity);
  expect(() => table.replace([placeholder])).toThrow();
  expect(table.forBot(identity.botId)).toEqual(identity);
});

test("connector legacy placeholder cannot weaken configured identities or reload validation", async () => {
  const config = {
    port: 0,
    secrets: { "gateway-a": [secret] },
    agentschat: {
      async sendMessage() { return { id: "fixture-message" }; },
      async getChatInfo() { return { name: "fixture", type: "group" }; },
    },
  };
  const server = startConnector(config);
  try {
    for (const field of ["token", "gatewayId", "secret"] as const) {
      const bad = { ...identity, [field]: "" };
      expect(() => startConnector({ ...config, identities: [bad] })).toThrow();
      expect(() => server.reloadIdentities([bad])).toThrow();
      expect(config.secrets).toEqual({ "gateway-a": [secret] });
    }
    expect(() => server.reloadIdentities([identity])).not.toThrow();
    expect(() => server.reloadIdentities([{ ...identity, secret: "" }])).toThrow();
    expect(config.secrets).toEqual({ "gateway-a": [secret] });
  } finally {
    await server.stop();
  }
});

test("table snapshots cannot be mutated into another identity", () => {
  const supplied = { ...identity };
  const table = new IdentityTable([supplied]);
  supplied.token = "changed";
  supplied.botId = "bot-b";
  expect(table.forBot("bot-a")?.token).toBe(identity.token);
  expect(Object.isFrozen(table.all()[0])).toBe(true);
  expect(table.forBot("bot-b")).toBeNull();
});

test("descriptor rejects prototype and ambiguous trimmed override keys", () => {
  for (const key of ["__proto__", "constructor", "prototype", " CONSTRUCTOR ", "", " label"]) {
    const overrides = JSON.parse(JSON.stringify({ [key]: "bad" }));
    expect(() => buildDescriptor(overrides)).toThrow();
  }
  expect(() => buildDescriptor(JSON.parse('{"label":"ok"," label ":"bad"}'))).toThrow();
  expect(buildDescriptor({ label: "Custom" }).label).toBe("Custom");
  expect(Object.getPrototypeOf(buildDescriptor())).toBe(Object.prototype);
});
