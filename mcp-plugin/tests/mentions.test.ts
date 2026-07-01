// Unit tests for the @mention gate (src/mentions.ts). Guards the documented
// false-positive (msg:fc8b9b1a) where a loose `(<id>)` match made an agent
// process messages it wasn't mentioned in. Run with `bun test`.
import { test, expect } from "bun:test";
import { matchesMention } from "../src/mentions.ts";

const ID = "acc_abc123";

test("bare @<agentId> is a mention", () => {
  expect(matchesMention("hey @acc_abc123 ping", ID)).toBe(true);
});

test("display-name form @Name(<agentId>) is a mention", () => {
  expect(matchesMention("hi @Claude Code(acc_abc123) please", ID)).toBe(true);
  expect(matchesMention("@a(acc_abc123)", ID)).toBe(true);
});

test("incidental (<agentId>) without a leading @Name is NOT a mention", () => {
  // The exact regression class: a system/join line must not trigger.
  expect(matchesMention("User joined: name (acc_abc123)", ID)).toBe(false);
  expect(matchesMention("file mention.txt (acc_abc123) created", ID)).toBe(false);
});

test("a different agent id does not match either form", () => {
  expect(matchesMention("@acc_xyz789 talking elsewhere", ID)).toBe(false);
  expect(matchesMention("@Bot(acc_xyz789) hi", ID)).toBe(false);
});

test("plain text with no mention is not a match", () => {
  expect(matchesMention("just chatting, nobody pinged", ID)).toBe(false);
});

test("empty content or empty agentId never matches", () => {
  expect(matchesMention("", ID)).toBe(false);
  expect(matchesMention("@anything", "")).toBe(false);
});

test("an agentId containing regex metacharacters does not corrupt the pattern", () => {
  const weird = "a.b+c(d)";
  // display-name form with the literal id in parens still matches...
  expect(matchesMention("@Name(a.b+c(d))", weird)).toBe(true);
  // ...and a near-miss that would match if metachars were interpreted does not
  expect(matchesMention("@Name(aXbYcZdW)", weird)).toBe(false);
});
