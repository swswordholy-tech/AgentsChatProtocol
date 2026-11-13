// Unit tests for validateToolArgs (src/argcheck.ts) — runtime input validation
// against a tool's declared inputSchema. Run with `bun test`.
import { test, expect } from "bun:test";
import {
  validateCreateLoopInput,
  validateDeleteMemoryInput,
  validateListLoopsInput,
  validateOkrSetKrProgressInput,
  validateOkrTaskDueInput,
  validateOkrTaskTitleInput,
  validateOkrUpdateKrInput,
  validateTaskEvidenceInput,
  validateToolArgs,
} from "../src/argcheck.ts";

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

test("validateTaskEvidenceInput normalizes valid items and supports clearing", () => {
  expect(validateTaskEvidenceInput([])).toEqual({ ok: true, value: [] });
  expect(validateTaskEvidenceInput(null)).toEqual({ ok: true, value: [] });

  const valid = validateTaskEvidenceInput([
    { kind: "commit", ref: " 548958af ", note: "  Bun 145/145\npass  " },
    { kind: "probe", ref: "bun test okr-task-evidence" },
  ]);
  expect(valid).toEqual({
    ok: true,
    value: [
      { kind: "commit", ref: "548958af", note: "Bun 145/145 pass" },
      { kind: "probe", ref: "bun test okr-task-evidence" },
    ],
  });
});

test("validateTaskEvidenceInput rejects malformed items, duplicates, and leaked secrets", () => {
  expect(validateTaskEvidenceInput("nope").ok).toBe(false);
  expect(validateTaskEvidenceInput([{ kind: "unknown", ref: "abc" }]).ok).toBe(false);
  expect(validateTaskEvidenceInput([{ kind: "commit", ref: "   " }]).ok).toBe(false);
  expect(
    validateTaskEvidenceInput([
      { kind: "commit", ref: "548958af" },
      { kind: "commit", ref: " 548958af " },
    ]).ok,
  ).toBe(false);
  expect(
    validateTaskEvidenceInput([
      { kind: "external", ref: "ac_live_secret_token_1234567890" },
    ]),
  ).toEqual({
    ok: false,
    error: "evidence[0].ref rejected: appears to contain a secret or token",
  });
  expect(
    validateTaskEvidenceInput([
      { kind: "doc", ref: "doc-1", note: "token sk-proj-1234567890abcdefghijklmnop" },
    ]),
  ).toEqual({
    ok: false,
    error: "evidence[0].note rejected: appears to contain a secret or token",
  });
});

test("validateCreateLoopInput accepts okr_wake, okr_watch, and prompt modes", () => {
  expect(
    validateCreateLoopInput({
      channel_id: "edbb8180-4356-4dab-9d75-bc9fe6f26194",
      mode: "okr_wake",
      interval: "5m",
      objective_id: "obj_mwdznid5_3jvlpq3c",
      target_agents: ["@bot-a", "bot-b", "@bot-a"],
    }),
  ).toEqual({
    ok: true,
    value: {
      channel_id: "edbb8180-4356-4dab-9d75-bc9fe6f26194",
      mode: "okr_wake",
      interval: "5m",
      objective_id: "obj_mwdznid5_3jvlpq3c",
      target_agents: ["bot-a", "bot-b"],
    },
  });

  expect(
    validateCreateLoopInput({
      channel_id: "chan-1",
      mode: "okr_watch",
      interval_ms: 900_000,
      objective_id: "obj_watch_123",
      watch_idle: true,
      watch_supply: false,
    }),
  ).toEqual({
    ok: true,
    value: {
      channel_id: "chan-1",
      mode: "okr_watch",
      interval_ms: 900_000,
      objective_id: "obj_watch_123",
      watch_idle: true,
      watch_supply: false,
    },
  });

  expect(
    validateCreateLoopInput({
      channel_id: "dm-dtr851",
      mode: "prompt",
      interval: "30m",
      prompt: "  巡检汇报  ",
    }),
  ).toEqual({
    ok: true,
    value: {
      channel_id: "dm-dtr851",
      mode: "prompt",
      interval: "30m",
      prompt: "巡检汇报",
    },
  });
});

test("validateCreateLoopInput rejects path traversal, invalid intervals, missing objective_id, and secret prompts", () => {
  expect(validateCreateLoopInput({ channel_id: "../admin", mode: "prompt", prompt: "hi" }).ok).toBe(false);
  expect(validateCreateLoopInput({ channel_id: "chan-1", mode: "okr_wake" }).ok).toBe(false);
  expect(validateCreateLoopInput({ channel_id: "chan-1", mode: "okr_wake", objective_id: "obj_ok_123", interval: "10s" }).ok).toBe(false);
  expect(validateCreateLoopInput({ channel_id: "chan-1", mode: "okr_wake", objective_id: "obj_ok_123", interval: "5m", interval_ms: 600_000 }).ok).toBe(false);
  expect(
    validateCreateLoopInput({
      channel_id: "chan-1",
      mode: "prompt",
      prompt: "bearer ac_live_secret_token_1234567890",
    }),
  ).toEqual({
    ok: false,
    error: "create_loop prompt rejected: appears to contain a secret or token.",
  });
});

test("validateCreateLoopInput validates stall_minutes for okr_watch only (5..1440)", () => {
  expect(
    validateCreateLoopInput({
      channel_id: "chan-1",
      mode: "okr_watch",
      objective_id: "obj_watch_123",
      stall_minutes: 15,
    }),
  ).toEqual({
    ok: true,
    value: {
      channel_id: "chan-1",
      mode: "okr_watch",
      objective_id: "obj_watch_123",
      stall_minutes: 15,
    },
  });
  expect(
    validateCreateLoopInput({
      channel_id: "chan-1",
      mode: "okr_wake",
      objective_id: "obj_watch_123",
      stall_minutes: 15,
    }).ok,
  ).toBe(false);
  expect(
    validateCreateLoopInput({
      channel_id: "chan-1",
      mode: "okr_watch",
      objective_id: "obj_watch_123",
      stall_minutes: 4,
    }).ok,
  ).toBe(false);
  expect(
    validateCreateLoopInput({
      channel_id: "chan-1",
      mode: "okr_watch",
      objective_id: "obj_watch_123",
      stall_minutes: 1441,
    }).ok,
  ).toBe(false);
});

test("validateListLoopsInput accepts safe filters and rejects invalid modes/statuses/ids", () => {
  expect(validateListLoopsInput({})).toEqual({ ok: true, value: {} });
  expect(
    validateListLoopsInput({
      channel_id: " chan-1 ",
      status: "paused",
      mode: "okr_watch",
      objective_id: " obj_watch_123 ",
    }),
  ).toEqual({
    ok: true,
    value: {
      channel_id: "chan-1",
      status: "paused",
      mode: "okr_watch",
      objective_id: "obj_watch_123",
    },
  });
  expect(validateListLoopsInput({ channel_id: "../admin" }).ok).toBe(false);
  expect(validateListLoopsInput({ status: "stopped" }).ok).toBe(false);
  expect(validateListLoopsInput({ mode: "static" }).ok).toBe(false);
  expect(validateListLoopsInput({ objective_id: "bad/id" }).ok).toBe(false);
});

test("validateDeleteMemoryInput validates slug, CAS version, and allow_missing", () => {
  expect(
    validateDeleteMemoryInput({
      name: " sprint-note_1.v2 ",
      if_match_version: 3,
      allow_missing: true,
    }),
  ).toEqual({
    ok: true,
    value: {
      name: "sprint-note_1.v2",
      if_match_version: 3,
      allow_missing: true,
    },
  });
  expect(validateDeleteMemoryInput({ name: "../etc/passwd" }).ok).toBe(false);
  expect(validateDeleteMemoryInput({ name: ".hidden" }).ok).toBe(false);
  expect(validateDeleteMemoryInput({ name: "note", if_match_version: 0 }).ok).toBe(false);
  expect(validateDeleteMemoryInput({ name: "note", allow_missing: "yes" }).ok).toBe(false);
});

test("validateOkrUpdateKrInput and validateOkrSetKrProgressInput enforce routing, metric bounds, CAS, and secret blocks", () => {
  expect(
    validateOkrSetKrProgressInput({
      kr_id: " kr_prog_1 ",
      current: 2,
      risk_level: "green",
    }),
  ).toEqual({
    ok: true,
    value: {
      kr_id: "kr_prog_1",
      body: { current: 2, risk_level: "green" },
      useMetadataEndpoint: false,
    },
  });

  expect(
    validateOkrSetKrProgressInput({
      kr_id: "kr_meta_1",
      title: " Ship 5 tasks ",
      target: 5,
      if_match_updated_at: "2026-11-13T08:00:00.000Z",
    }),
  ).toEqual({
    ok: true,
    value: {
      kr_id: "kr_meta_1",
      body: {
        title: "Ship 5 tasks",
        target: 5,
        if_match_updated_at: "2026-11-13T08:00:00.000Z",
      },
      useMetadataEndpoint: true,
    },
  });

  expect(
    validateOkrUpdateKrInput({
      kr_id: "kr_bool_1",
      metric_type: "bool",
      target: 1,
      current: 1,
    }),
  ).toEqual({
    ok: true,
    value: {
      kr_id: "kr_bool_1",
      body: { metric_type: "bool", target: 1, current: 1 },
      useMetadataEndpoint: true,
    },
  });

  expect(validateOkrUpdateKrInput({ kr_id: "kr_empty" }).ok).toBe(false);
  expect(validateOkrUpdateKrInput({ kr_id: "kr_bad", metric_type: "bool", target: 2 }).ok).toBe(false);
  expect(validateOkrUpdateKrInput({ kr_id: "kr_bad", metric_type: "percent", target: 101 }).ok).toBe(false);
  expect(validateOkrUpdateKrInput({ kr_id: "kr_sec", title: "agent_key_supersecret123456" }).ok).toBe(false);
});

test("validateOkrTaskTitleInput and validateOkrTaskDueInput support clearing due and block secrets/invalid dates", () => {
  expect(validateOkrTaskTitleInput("  Revise KR endpoint  ")).toEqual({
    ok: true,
    value: "Revise KR endpoint",
  });
  expect(validateOkrTaskTitleInput("").ok).toBe(false);
  expect(validateOkrTaskTitleInput("sk-live-1234567890abcdef1234").ok).toBe(false);

  expect(validateOkrTaskDueInput("")).toEqual({ ok: true, value: "" });
  expect(validateOkrTaskDueInput("2026-11-20T12:00:00Z")).toEqual({
    ok: true,
    value: "2026-11-20T12:00:00Z",
  });
  expect(validateOkrTaskDueInput("not-a-date").ok).toBe(false);
  expect(validateOkrTaskDueInput("agent_key_supersecret123456").ok).toBe(false);
});
