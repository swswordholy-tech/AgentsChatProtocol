// Unit tests for redactSecrets (src/redact.ts) — the last line of defense
// against leaking ac_ keys / JWTs into channel content. Run with `bun test`.
import { test, expect } from "bun:test";
import { isHumanPiiHandle, redactParticipantPii, redactSecrets } from "../src/redact.ts";

test("masks an ac_ API key of 16+ chars", () => {
  expect(redactSecrets("my key is ac_Dor5zPhpIKxj5JRhmgyIuA4u ok")).toBe(
    "my key is ac_***REDACTED*** ok",
  );
});

test("leaves an ac_ token shorter than 16 chars intact (documents the {16,} bound)", () => {
  const short = "ac_" + "a".repeat(15); // 15 < 16 → not matched
  expect(redactSecrets(short)).toBe(short);
});

test("redacts multiple ac_ keys in one string (global flag)", () => {
  const two = "ac_" + "A".repeat(20) + " and ac_" + "B".repeat(20);
  expect(redactSecrets(two)).toBe("ac_***REDACTED*** and ac_***REDACTED***");
});

test("masks a JWT including base64url - and _ chars", () => {
  const jwt = "eyJ" + "a".repeat(20) + ".eyJab-c_d.sig-nature_";
  expect(redactSecrets("token=" + jwt)).toBe("token=***JWT_REDACTED***");
});

test("redacts an ac_ key and a JWT present together", () => {
  const jwt = "eyJ" + "x".repeat(20) + ".payload.signature";
  const s = "ac_" + "Z".repeat(18) + " " + jwt;
  expect(redactSecrets(s)).toBe("ac_***REDACTED*** ***JWT_REDACTED***");
});

test("masks an ac_ token containing base64url - and _ chars", () => {
  const tok = "ac_" + "aB3-dE5_fG7hI9jK1lM3"; // 20 chars incl - and _
  expect(redactSecrets("key " + tok)).toBe("key ac_***REDACTED***");
});

test("leaves ordinary text (including a bare 'ac_' with too few chars) untouched", () => {
  expect(redactSecrets("hello world, ac_short, no secrets")).toBe(
    "hello world, ac_short, no secrets",
  );
});

test("preserves ac_ keys when preserveAcKeys=true (same-owner DM) while still redacting JWTs", () => {
  const jwt = "eyJ" + "x".repeat(20) + ".payload.signature";
  const key = "ac_Dor5zPhpIKxj5JRhmgyIuA4u";
  expect(redactSecrets(`key=${key} jwt=${jwt}`, { preserveAcKeys: true })).toBe(
    `key=${key} jwt=***JWT_REDACTED***`,
  );
});

test("isHumanPiiHandle detects emails and phone numbers while leaving agent IDs false", () => {
  expect(isHumanPiiHandle("swswordholy@gmail.com")).toBe(true);
  expect(isHumanPiiHandle("+86 138-0013-8000")).toBe(true);
  expect(isHumanPiiHandle("13800138000")).toBe(true);
  expect(isHumanPiiHandle("knobbly-tangy-beacon")).toBe(false);
  expect(isHumanPiiHandle("claude-code-live")).toBe(false);
  expect(isHumanPiiHandle("")).toBe(false);
});

test("redactParticipantPii masks emails and phones and preserves full agent IDs", () => {
  expect(redactParticipantPii("swswordholy@gmail.com")).toBe("user:sw***");
  expect(redactParticipantPii("A@example.org")).toBe("user:a***");
  expect(redactParticipantPii("+86 138-0013-8099")).toBe("user:phone_***99");
  expect(redactParticipantPii("knobbly-tangy-beacon")).toBe("knobbly-tangy-beacon");
  expect(redactParticipantPii("spinning-midnight-tunicate")).toBe("spinning-midnight-tunicate");
});
