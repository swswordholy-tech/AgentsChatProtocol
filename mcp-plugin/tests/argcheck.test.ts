// Unit tests for validateToolArgs (src/argcheck.ts) — runtime input validation
// against a tool's declared inputSchema. Run with `bun test`.
import { test, expect } from "bun:test";
import { validateToolArgs } from "../src/argcheck.ts";

const schema = {
  type: "object",
  properties: {
    chat_id: { type: "string" },
    limit: { type: "number" },
    flag: { type: "boolean" },
    ids: { type: "array" },
  },
  required: ["chat_id"],
};

test("accepts valid args", () => {
  expect(validateToolArgs(schema, { chat_id: "c1", limit: 20, flag: true })).toBe(null);
});

test("rejects a missing required field", () => {
  expect(validateToolArgs(schema, { limit: 20 })).toBe('missing required argument "chat_id"');
});

test("treats a null/undefined required field as missing", () => {
  expect(validateToolArgs(schema, { chat_id: null })).toBe('missing required argument "chat_id"');
});

test("rejects a wrong declared type", () => {
  expect(validateToolArgs(schema, { chat_id: 5 })).toContain('argument "chat_id" must be string');
  expect(validateToolArgs(schema, { chat_id: "c", limit: "20" })).toContain('argument "limit" must be number');
  expect(validateToolArgs(schema, { chat_id: "c", ids: "x" })).toContain('argument "ids" must be array');
});

test("absent optional fields are fine", () => {
  expect(validateToolArgs(schema, { chat_id: "c" })).toBe(null);
});

test("extra undeclared props pass through (permissive — cannot break valid calls)", () => {
  expect(validateToolArgs(schema, { chat_id: "c", undeclared: 123 })).toBe(null);
});

test("non-object schema or missing properties is a no-op", () => {
  expect(validateToolArgs(null, { anything: 1 })).toBe(null);
  expect(validateToolArgs({ type: "string" }, "x")).toBe(null);
  expect(validateToolArgs({ type: "object" }, { a: 1 })).toBe(null);
});

test("integer accepts numbers but rejects NaN", () => {
  const s = { type: "object", properties: { n: { type: "integer" } }, required: [] };
  expect(validateToolArgs(s, { n: 3 })).toBe(null);
  expect(validateToolArgs(s, { n: NaN })).toContain("must be integer");
});

test("a union type array is honored", () => {
  const s = { type: "object", properties: { x: { type: ["string", "number"] } }, required: [] };
  expect(validateToolArgs(s, { x: "a" })).toBe(null);
  expect(validateToolArgs(s, { x: 1 })).toBe(null);
  expect(validateToolArgs(s, { x: true })).toContain("must be string|number");
});

test("non-object args still surface missing required fields", () => {
  expect(validateToolArgs(schema, undefined)).toBe('missing required argument "chat_id"');
  expect(validateToolArgs(schema, "not-an-object")).toBe('missing required argument "chat_id"');
});

test("object type accepts plain objects, rejects arrays", () => {
  const s = { type: "object", properties: { o: { type: "object" } }, required: [] };
  expect(validateToolArgs(s, { o: { k: 1 } })).toBe(null);
  expect(validateToolArgs(s, { o: [1, 2] })).toContain("must be object");
});
