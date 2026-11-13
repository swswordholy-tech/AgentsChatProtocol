/**
 * Minimal runtime validation of tool-call arguments against a tool's declared
 * inputSchema (the same JSON-Schema-ish object advertised in tools/list).
 *
 * Deliberately permissive: it enforces only what the declared contract already
 * promises — required fields present, and declared fields matching their declared
 * primitive type. It never rejects unknown/extra properties (handlers may read
 * undeclared fields), so it cannot break a previously-valid call; it only turns
 * a contract violation into a clear message instead of a downstream throw.
 *
 * Returns null when the args are acceptable, or a human-readable reason string.
 */
export function validateToolArgs(schema: any, args: any): string | null {
  if (!schema || schema.type !== "object" || !schema.properties) return null;
  const a = args && typeof args === "object" && !Array.isArray(args) ? args : {};

  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (a[key] === undefined || a[key] === null) {
      return `missing required argument "${key}"`;
    }
  }

  for (const [key, spec] of Object.entries<any>(schema.properties)) {
    const val = a[key];
    if (val === undefined || val === null) continue; // absent optional → fine
    const expected = spec?.type;
    if (!expected) continue; // no declared type → don't constrain
    if (!matchesJsonType(val, expected)) {
      const want = Array.isArray(expected) ? expected.join("|") : expected;
      return `argument "${key}" must be ${want}, got ${jsType(val)}`;
    }
  }

  return null;
}

function jsType(v: any): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

function matchesJsonType(val: any, expected: string | string[]): boolean {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((t) => {
    switch (t) {
      case "string":
        return typeof val === "string";
      case "number":
      case "integer":
        return typeof val === "number" && !Number.isNaN(val);
      case "boolean":
        return typeof val === "boolean";
      case "array":
        return Array.isArray(val);
      case "object":
        return val !== null && typeof val === "object" && !Array.isArray(val);
      case "null":
        return val === null;
      default:
        return true; // unknown type keyword → don't block
    }
  });
}

export const TASK_EVIDENCE_KINDS = [
  "commit",
  "deploy",
  "probe",
  "doc",
  "external",
  "rollout",
] as const;
export type TaskEvidenceKind = (typeof TASK_EVIDENCE_KINDS)[number];

export interface TaskEvidenceInput {
  kind: TaskEvidenceKind;
  ref: string;
  note?: string;
}

const TASK_EVIDENCE_CAP = 10;
const TASK_EVIDENCE_REF_MAX = 160;
const TASK_EVIDENCE_NOTE_MAX = 200;
const EVIDENCE_CTRL_RE = /[\u0000-\u001f\u007f]/;
const EVIDENCE_SECRET_RE =
  /(?:(?:ac|agent_key)_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:sk|rk)-(?:live-|test-|proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [^-]*PRIVATE KEY-----)/;

function isTaskEvidenceKind(v: unknown): v is TaskEvidenceKind {
  return typeof v === "string" && (TASK_EVIDENCE_KINDS as readonly string[]).includes(v);
}

/**
 * Validate `okr_update_task` `evidence` client-side so invalid shapes or
 * accidental credential leaks fail fast before leaving the local MCP runtime.
 * Passing `[]` or `null` normalizes to `[]` so callers can clear existing evidence.
 */
export function validateTaskEvidenceInput(
  raw: unknown,
): { ok: true; value: TaskEvidenceInput[] } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: "evidence must be an array (max 10 items; pass [] to clear)" };
  }
  if (raw.length === 0) return { ok: true, value: [] };
  if (raw.length > TASK_EVIDENCE_CAP) {
    return { ok: false, error: `evidence exceeds max ${TASK_EVIDENCE_CAP} items` };
  }

  const out: TaskEvidenceInput[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: `evidence[${i}] must be an object` };
    }
    const rawKind = (item as Record<string, unknown>).kind;
    const rawRef = (item as Record<string, unknown>).ref;
    const rawNote = (item as Record<string, unknown>).note;
    if (!isTaskEvidenceKind(rawKind)) {
      return {
        ok: false,
        error: `evidence[${i}].kind must be one of ${TASK_EVIDENCE_KINDS.join("|")}`,
      };
    }
    if (typeof rawRef !== "string") {
      return { ok: false, error: `evidence[${i}].ref must be a non-empty string` };
    }
    const ref = rawRef.trim();
    if (!ref) {
      return { ok: false, error: `evidence[${i}].ref must be a non-empty string` };
    }
    if (ref.length > TASK_EVIDENCE_REF_MAX) {
      return { ok: false, error: `evidence[${i}].ref exceeds ${TASK_EVIDENCE_REF_MAX} chars` };
    }
    if (EVIDENCE_CTRL_RE.test(ref)) {
      return { ok: false, error: `evidence[${i}].ref contains disallowed control characters` };
    }
    if (EVIDENCE_SECRET_RE.test(ref)) {
      return { ok: false, error: `evidence[${i}].ref rejected: appears to contain a secret or token` };
    }

    let note: string | undefined;
    if (rawNote !== undefined && rawNote !== null) {
      if (typeof rawNote !== "string") {
        return { ok: false, error: `evidence[${i}].note must be a string` };
      }
      const normalizedNote = rawNote.replace(/[\r\n\t]+/g, " ").trim();
      if (normalizedNote.length > TASK_EVIDENCE_NOTE_MAX) {
        return { ok: false, error: `evidence[${i}].note exceeds ${TASK_EVIDENCE_NOTE_MAX} chars` };
      }
      if (EVIDENCE_CTRL_RE.test(normalizedNote)) {
        return { ok: false, error: `evidence[${i}].note contains disallowed control characters` };
      }
      if (normalizedNote.length > 0) {
        if (EVIDENCE_SECRET_RE.test(normalizedNote)) {
          return { ok: false, error: `evidence[${i}].note rejected: appears to contain a secret or token` };
        }
        note = normalizedNote;
      }
    }

    const dedupKey = `${rawKind}:${ref}`;
    if (seen.has(dedupKey)) {
      return { ok: false, error: `duplicate evidence entry "${dedupKey}"` };
    }
    seen.add(dedupKey);
    out.push({
      kind: rawKind,
      ref,
      ...(note ? { note } : {}),
    });
  }
  return { ok: true, value: out };
}

export function validateAppendTaskEvidenceInput(
  raw: unknown,
): { ok: true; value: TaskEvidenceInput[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      error: `append_evidence must be a non-empty array (1..${TASK_EVIDENCE_CAP} items)`,
    };
  }
  return validateTaskEvidenceInput(raw);
}

export function validateTaskVersionToken(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") {
    return { ok: false, error: "if_match_updated_at must be a non-empty string" };
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 64 || EVIDENCE_CTRL_RE.test(trimmed)) {
    return {
      ok: false,
      error: "if_match_updated_at must be a valid non-empty timestamp token (<=64 chars)",
    };
  }
  return { ok: true, value: trimmed };
}

export function responseIncludesAppendedEvidence(
  taskRaw: unknown,
  appended: ReadonlyArray<TaskEvidenceInput>,
): boolean {
  if (!taskRaw || typeof taskRaw !== "object") return false;
  const evList = (taskRaw as Record<string, unknown>).evidence;
  if (!Array.isArray(evList)) return false;
  return appended.every((want) =>
    evList.some((item) => {
      if (!item || typeof item !== "object") return false;
      const gotKind = (item as Record<string, unknown>).kind;
      const gotRef = typeof (item as Record<string, unknown>).ref === "string"
        ? ((item as Record<string, unknown>).ref as string).trim()
        : "";
      const gotNote = typeof (item as Record<string, unknown>).note === "string"
        ? ((item as Record<string, unknown>).note as string).replace(/[\r\n\t]+/g, " ").trim()
        : "";
      return gotKind === want.kind && gotRef === want.ref && gotNote === (want.note ?? "");
    }),
  );
}

export function mergeLegacyTaskEvidence(
  existingRaw: unknown,
  appended: ReadonlyArray<TaskEvidenceInput>,
): { ok: true; value: TaskEvidenceInput[] } | { ok: false; error: string } {
  const merged: TaskEvidenceInput[] = [];
  const indexByKey = new Map<string, number>();
  if (Array.isArray(existingRaw)) {
    for (const raw of existingRaw) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const rawKind = (raw as Record<string, unknown>).kind;
      const rawRef = (raw as Record<string, unknown>).ref;
      const rawNote = (raw as Record<string, unknown>).note;
      if (!isTaskEvidenceKind(rawKind) || typeof rawRef !== "string") continue;
      const ref = rawRef.trim();
      if (!ref || ref.length > TASK_EVIDENCE_REF_MAX || EVIDENCE_CTRL_RE.test(ref)) continue;
      const note = typeof rawNote === "string"
        ? rawNote.replace(/[\r\n\t]+/g, " ").trim()
        : "";
      if (note.length > TASK_EVIDENCE_NOTE_MAX || EVIDENCE_CTRL_RE.test(note)) continue;
      const key = `${rawKind}:${ref}`;
      if (indexByKey.has(key)) continue;
      if (merged.length >= TASK_EVIDENCE_CAP) break;
      indexByKey.set(key, merged.length);
      merged.push({ kind: rawKind, ref, ...(note ? { note } : {}) });
    }
  }
  for (const item of appended) {
    const key = `${item.kind}:${item.ref}`;
    const existingIdx = indexByKey.get(key);
    if (existingIdx !== undefined) {
      merged[existingIdx] = { ...item };
    } else {
      if (merged.length >= TASK_EVIDENCE_CAP) {
        return {
          ok: false,
          error: `evidence_cap_exceeded (task already at ${TASK_EVIDENCE_CAP} items; refused to overwrite history)`,
        };
      }
      indexByKey.set(key, merged.length);
      merged.push({ ...item });
    }
  }
  return { ok: true, value: merged };
}

export const CREATE_LOOP_MODES = ["okr_wake", "okr_watch", "prompt"] as const;
export type CreateLoopMode = (typeof CREATE_LOOP_MODES)[number];

export interface ValidatedCreateLoopBody {
  channel_id: string;
  mode: CreateLoopMode;
  interval?: string;
  interval_ms?: number;
  objective_id?: string;
  prompt?: string;
  target_agents?: string[];
  watch_idle?: boolean;
  watch_supply?: boolean;
}

const LOOP_MIN_INTERVAL_MS = 60_000;
const LOOP_MAX_INTERVAL_MS = 86_400_000;
const SAFE_CHANNEL_OR_LOOP_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_OBJECTIVE_ID_RE = /^[A-Za-z0-9_-]{6,80}$/;
const SAFE_AGENT_HANDLE_RE = /^[A-Za-z0-9_-]{2,64}$/;
const LOOP_PROMPT_CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function parseLoopIntervalShorthandMs(raw: string): number | null {
  const m = raw.trim().match(/^(\d+)\s*(s|sec|m|min|h|hr|d)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  const unit = (m[2] || "m").toLowerCase();
  const mult =
    unit === "s" || unit === "sec" ? 1_000 :
    unit === "m" || unit === "min" ? 60_000 :
    unit === "h" || unit === "hr" ? 3_600_000 :
    86_400_000;
  const ms = n * mult;
  if (!Number.isSafeInteger(ms) || ms < LOOP_MIN_INTERVAL_MS || ms > LOOP_MAX_INTERVAL_MS) {
    return null;
  }
  return ms;
}

export function validateCreateLoopInput(
  args: unknown,
): { ok: true; value: ValidatedCreateLoopBody } | { ok: false; error: string } {
  const a = args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
  const channelId = typeof a.channel_id === "string" ? a.channel_id.trim() : "";
  if (!SAFE_CHANNEL_OR_LOOP_ID_RE.test(channelId) || channelId.includes("..")) {
    return { ok: false, error: "create_loop needs a valid channel_id." };
  }
  const rawMode = typeof a.mode === "string" ? a.mode.trim() : "";
  if (!(CREATE_LOOP_MODES as readonly string[]).includes(rawMode)) {
    return { ok: false, error: "create_loop mode must be one of okr_wake|okr_watch|prompt." };
  }
  const mode = rawMode as CreateLoopMode;

  let intervalMs: number | undefined;
  let interval: string | undefined;
  if (a.interval_ms !== undefined && a.interval_ms !== null) {
    if (
      typeof a.interval_ms !== "number" ||
      !Number.isSafeInteger(a.interval_ms) ||
      a.interval_ms < LOOP_MIN_INTERVAL_MS ||
      a.interval_ms > LOOP_MAX_INTERVAL_MS
    ) {
      return {
        ok: false,
        error: `create_loop interval_ms must be an integer in ${LOOP_MIN_INTERVAL_MS}..${LOOP_MAX_INTERVAL_MS} (1m..24h).`,
      };
    }
    intervalMs = a.interval_ms;
  }
  if (a.interval !== undefined && a.interval !== null) {
    if (typeof a.interval !== "string" || !a.interval.trim()) {
      return { ok: false, error: "create_loop interval must be a shorthand string such as 5m, 15m, 1h." };
    }
    const parsed = parseLoopIntervalShorthandMs(a.interval);
    if (parsed === null) {
      return { ok: false, error: "create_loop interval must resolve within 1m..24h (e.g. 5m, 15m, 30m, 1h)." };
    }
    interval = a.interval.trim();
    if (intervalMs !== undefined && intervalMs !== parsed) {
      return { ok: false, error: "create_loop interval and interval_ms disagree; pass only one or matching values." };
    }
  }

  let targetAgents: string[] | undefined;
  if (a.target_agents !== undefined && a.target_agents !== null) {
    if (!Array.isArray(a.target_agents)) {
      return { ok: false, error: "create_loop target_agents must be an array of agent handles." };
    }
    if (a.target_agents.length > 12) {
      return { ok: false, error: "create_loop target_agents exceeds max 12 targets." };
    }
    const dedup: string[] = [];
    const seenTargets = new Set<string>();
    for (const entry of a.target_agents) {
      if (typeof entry !== "string") {
        return { ok: false, error: "create_loop target_agents items must be strings." };
      }
      const handle = entry.trim().replace(/^@+/, "");
      if (!handle) continue;
      if (!SAFE_AGENT_HANDLE_RE.test(handle)) {
        return { ok: false, error: `create_loop invalid target agent handle "${handle}".` };
      }
      if (!seenTargets.has(handle)) {
        seenTargets.add(handle);
        dedup.push(handle);
      }
    }
    if (dedup.length > 0) targetAgents = dedup;
  }

  const out: ValidatedCreateLoopBody = {
    channel_id: channelId,
    mode,
    ...(intervalMs !== undefined ? { interval_ms: intervalMs } : interval ? { interval } : {}),
    ...(targetAgents ? { target_agents: targetAgents } : {}),
  };

  if (mode === "okr_wake" || mode === "okr_watch") {
    const objectiveId = typeof a.objective_id === "string" ? a.objective_id.trim() : "";
    if (!SAFE_OBJECTIVE_ID_RE.test(objectiveId)) {
      return { ok: false, error: `create_loop mode="${mode}" requires a valid objective_id.` };
    }
    out.objective_id = objectiveId;
    if (mode === "okr_watch") {
      if (typeof a.watch_idle === "boolean") out.watch_idle = a.watch_idle;
      if (typeof a.watch_supply === "boolean") out.watch_supply = a.watch_supply;
    }
    return { ok: true, value: out };
  }

  const prompt = typeof a.prompt === "string" ? a.prompt.trim() : "";
  if (!prompt) {
    return { ok: false, error: 'create_loop mode="prompt" requires a non-empty prompt.' };
  }
  if (prompt.length > 500) {
    return { ok: false, error: "create_loop prompt exceeds max 500 characters." };
  }
  if (LOOP_PROMPT_CTRL_RE.test(prompt)) {
    return { ok: false, error: "create_loop prompt contains disallowed control characters." };
  }
  if (EVIDENCE_SECRET_RE.test(prompt)) {
    return { ok: false, error: "create_loop prompt rejected: appears to contain a secret or token." };
  }
  out.prompt = prompt;
  return { ok: true, value: out };
}
