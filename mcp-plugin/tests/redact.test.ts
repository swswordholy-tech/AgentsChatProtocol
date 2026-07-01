// Unit tests for redactSecrets (src/redact.ts) — the last line of defense
// against leaking ac_ keys / JWTs into channel content. Run with `bun test`.
import { test, expect } from "bun:test";
import { redactSecrets } from "../src/redact.ts";

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

test("leaves ordinary text (including a bare 'ac_' with too few chars) untouched", () => {
  expect(redactSecrets("hello world, ac_short, no secrets")).toBe(
    "hello world, ac_short, no secrets",
  );
});
