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
  if (EVIDENCE_SECRET_RE.test(trimmed)) {
    return {
      ok: false,
      error: "if_match_updated_at rejected: appears to contain a secret or token",
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
  stall_minutes?: number;
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

  if (a.stall_minutes !== undefined && a.stall_minutes !== null) {
    if (mode !== "okr_watch") {
      return { ok: false, error: 'create_loop stall_minutes is only supported when mode="okr_watch".' };
    }
    if (
      typeof a.stall_minutes !== "number" ||
      !Number.isSafeInteger(a.stall_minutes) ||
      a.stall_minutes < 5 ||
      a.stall_minutes > 1_440
    ) {
      return { ok: false, error: "create_loop stall_minutes must be an integer in 5..1440." };
    }
  }

  if (mode === "okr_wake" || mode === "okr_watch") {
    const objectiveId = typeof a.objective_id === "string" ? a.objective_id.trim() : "";
    if (!SAFE_OBJECTIVE_ID_RE.test(objectiveId)) {
      return { ok: false, error: `create_loop mode="${mode}" requires a valid objective_id.` };
    }
    out.objective_id = objectiveId;
    if (mode === "okr_watch") {
      if (typeof a.watch_idle === "boolean") out.watch_idle = a.watch_idle;
      if (typeof a.watch_supply === "boolean") out.watch_supply = a.watch_supply;
      if (typeof a.stall_minutes === "number") out.stall_minutes = a.stall_minutes;
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

export const OKR_KR_METRIC_TYPES = ["count", "bool", "percent"] as const;
export type OkrKrMetricType = (typeof OKR_KR_METRIC_TYPES)[number];
export const OKR_KR_RISK_LEVELS = ["green", "yellow", "red"] as const;
export type OkrKrRiskLevel = (typeof OKR_KR_RISK_LEVELS)[number];

export interface ValidatedOkrAddKrInput {
  objective_id: string;
  body: {
    title: string;
    metric_type: OkrKrMetricType;
    target: number;
    current?: number;
    risk_level?: OkrKrRiskLevel;
  };
}

export function validateOkrAddKrInput(
  args: unknown,
): { ok: true; value: ValidatedOkrAddKrInput } | { ok: false; error: string } {
  const a = args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
  const objectiveId = typeof a.objective_id === "string" ? a.objective_id.trim() : "";
  if (!objectiveId || !SAFE_CHANNEL_OR_LOOP_ID_RE.test(objectiveId) || objectiveId.includes("..")) {
    return { ok: false, error: "okr_add_kr requires a valid objective_id." };
  }
  const rawTitle = typeof a.title === "string" ? a.title : "";
  const title = rawTitle.replace(/[\r\n\t]+/g, " ").trim();
  if (!title || title.length > 200 || EVIDENCE_CTRL_RE.test(title)) {
    return { ok: false, error: "okr_add_kr title must be a non-empty string (<=200 chars) without control characters." };
  }
  if (EVIDENCE_SECRET_RE.test(title)) {
    return { ok: false, error: "okr_add_kr title rejected: appears to contain a secret or token." };
  }
  const mt = a.metric_type === undefined ? "count" : a.metric_type;
  if (typeof mt !== "string" || !(OKR_KR_METRIC_TYPES as readonly string[]).includes(mt)) {
    return { ok: false, error: "okr_add_kr metric_type must be count|bool|percent." };
  }
  const metricType = mt as OkrKrMetricType;
  if (typeof a.target !== "number" || !Number.isFinite(a.target) || a.target < 0 || a.target > 1_000_000) {
    return { ok: false, error: "okr_add_kr target must be a finite number in 0..1000000." };
  }
  if (metricType === "bool" && a.target !== 0 && a.target !== 1) {
    return { ok: false, error: "okr_add_kr bool target must be 0 or 1." };
  }
  if (metricType === "percent" && a.target > 100) {
    return { ok: false, error: "okr_add_kr percent target must be <= 100." };
  }
  let current: number | undefined;
  if (a.current !== undefined && a.current !== null) {
    if (typeof a.current !== "number" || !Number.isFinite(a.current) || a.current < 0 || a.current > 1_000_000) {
      return { ok: false, error: "okr_add_kr current must be a finite number in 0..1000000." };
    }
    if (metricType === "bool" && a.current !== 0 && a.current !== 1) {
      return { ok: false, error: "okr_add_kr bool current must be 0 or 1." };
    }
    if (metricType === "percent" && a.current > 100) {
      return { ok: false, error: "okr_add_kr percent current must be <= 100." };
    }
    current = a.current;
  }
  let riskLevel: OkrKrRiskLevel | undefined;
  if (a.risk_level !== undefined && a.risk_level !== null) {
    if (typeof a.risk_level !== "string" || !(OKR_KR_RISK_LEVELS as readonly string[]).includes(a.risk_level)) {
      return { ok: false, error: "okr_add_kr risk_level must be green|yellow|red." };
    }
    riskLevel = a.risk_level as OkrKrRiskLevel;
  }
  return {
    ok: true,
    value: {
      objective_id: objectiveId,
      body: {
        title,
        metric_type: metricType,
        target: a.target,
        ...(current !== undefined ? { current } : {}),
        ...(riskLevel !== undefined ? { risk_level: riskLevel } : {}),
      },
    },
  };
}

export interface ValidatedOkrKrUpdateBody {
  title?: string;
  metric_type?: OkrKrMetricType;
  target?: number;
  current?: number;
  risk_level?: OkrKrRiskLevel;
  if_match_updated_at?: string;
}

export interface ValidatedOkrKrUpdateResult {
  kr_id: string;
  body: ValidatedOkrKrUpdateBody;
  useMetadataEndpoint: boolean;
}

function validateOkrKrMutationInput(
  args: unknown,
  toolLabel: "okr_set_kr_progress" | "okr_update_kr",
  forceMetadataEndpoint: boolean,
): { ok: true; value: ValidatedOkrKrUpdateResult } | { ok: false; error: string } {
  const a = args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
  const krId = typeof a.kr_id === "string" ? a.kr_id.trim() : "";
  if (
    !krId ||
    !SAFE_CHANNEL_OR_LOOP_ID_RE.test(krId) ||
    krId.includes("..") ||
    EVIDENCE_CTRL_RE.test(krId) ||
    EVIDENCE_SECRET_RE.test(krId)
  ) {
    return { ok: false, error: `${toolLabel} requires a valid kr_id.` };
  }

  const body: ValidatedOkrKrUpdateBody = {};

  if (a.title !== undefined && a.title !== null) {
    if (typeof a.title !== "string") {
      return { ok: false, error: `${toolLabel} title must be a non-empty string (1..200 chars).` };
    }
    if (EVIDENCE_CTRL_RE.test(a.title)) {
      return { ok: false, error: `${toolLabel} title must not contain control characters.` };
    }
    if (EVIDENCE_SECRET_RE.test(a.title)) {
      return { ok: false, error: `${toolLabel} title rejected: appears to contain a secret or token.` };
    }
    const trimmedTitle = a.title.trim();
    if (!trimmedTitle || trimmedTitle.length > 200) {
      return { ok: false, error: `${toolLabel} title must be 1..200 chars.` };
    }
    body.title = trimmedTitle;
  }

  let metricType: OkrKrMetricType | undefined;
  if (a.metric_type !== undefined && a.metric_type !== null) {
    if (typeof a.metric_type !== "string" || !(OKR_KR_METRIC_TYPES as readonly string[]).includes(a.metric_type)) {
      return { ok: false, error: `${toolLabel} metric_type must be count|bool|percent.` };
    }
    metricType = a.metric_type as OkrKrMetricType;
    body.metric_type = metricType;
  }

  if (a.target !== undefined && a.target !== null) {
    if (typeof a.target !== "number" || !Number.isFinite(a.target) || a.target < 0 || a.target > 1_000_000) {
      return { ok: false, error: `${toolLabel} target must be a finite number in 0..1000000.` };
    }
    if (metricType === "bool" && a.target !== 0 && a.target !== 1) {
      return { ok: false, error: `${toolLabel} bool target must be 0 or 1.` };
    }
    if (metricType === "percent" && a.target > 100) {
      return { ok: false, error: `${toolLabel} percent target must be <= 100.` };
    }
    body.target = a.target;
  }

  if (a.current !== undefined && a.current !== null) {
    if (typeof a.current !== "number" || !Number.isFinite(a.current) || a.current < 0 || a.current > 1_000_000) {
      return { ok: false, error: `${toolLabel} current must be a finite number in 0..1000000.` };
    }
    if (metricType === "bool" && a.current !== 0 && a.current !== 1) {
      return { ok: false, error: `${toolLabel} bool current must be 0 or 1.` };
    }
    if (metricType === "percent" && a.current > 100) {
      return { ok: false, error: `${toolLabel} percent current must be <= 100.` };
    }
    body.current = a.current;
  }

  if (a.risk_level !== undefined && a.risk_level !== null) {
    if (typeof a.risk_level !== "string" || !(OKR_KR_RISK_LEVELS as readonly string[]).includes(a.risk_level)) {
      return { ok: false, error: `${toolLabel} risk_level must be green|yellow|red.` };
    }
    body.risk_level = a.risk_level as OkrKrRiskLevel;
  }

  const hasMutableField =
    body.title !== undefined ||
    body.metric_type !== undefined ||
    body.target !== undefined ||
    body.current !== undefined ||
    body.risk_level !== undefined;
  if (!hasMutableField) {
    return {
      ok: false,
      error: `${toolLabel} requires at least one of current, risk_level, title, metric_type, or target.`,
    };
  }

  if (a.if_match_updated_at !== undefined && a.if_match_updated_at !== null) {
    const verCheck = validateTaskVersionToken(a.if_match_updated_at);
    if (!verCheck.ok) {
      return { ok: false, error: `${toolLabel} invalid if_match_updated_at: ${verCheck.error}` };
    }
    if (EVIDENCE_SECRET_RE.test(verCheck.value)) {
      return { ok: false, error: `${toolLabel} if_match_updated_at rejected: appears to contain a secret or token.` };
    }
    body.if_match_updated_at = verCheck.value;
  }

  const useMetadataEndpoint =
    forceMetadataEndpoint ||
    body.title !== undefined ||
    body.metric_type !== undefined ||
    body.target !== undefined ||
    body.current === undefined;

  return {
    ok: true,
    value: {
      kr_id: krId,
      body,
      useMetadataEndpoint,
    },
  };
}

export function validateOkrSetKrProgressInput(
  args: unknown,
): { ok: true; value: ValidatedOkrKrUpdateResult } | { ok: false; error: string } {
  return validateOkrKrMutationInput(args, "okr_set_kr_progress", false);
}

export function validateOkrUpdateKrInput(
  args: unknown,
): { ok: true; value: ValidatedOkrKrUpdateResult } | { ok: false; error: string } {
  return validateOkrKrMutationInput(args, "okr_update_kr", true);
}

export function validateOkrTaskTitleInput(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") {
    return { ok: false, error: "title must be a non-empty string (1..200 chars)" };
  }
  if (EVIDENCE_CTRL_RE.test(raw)) {
    return { ok: false, error: "title must not contain control characters" };
  }
  if (EVIDENCE_SECRET_RE.test(raw)) {
    return { ok: false, error: "title rejected: appears to contain a secret or token" };
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 200) {
    return { ok: false, error: "title must be 1..200 chars" };
  }
  return { ok: true, value: trimmed };
}

export function validateOkrTaskDueInput(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (raw === null || raw === "") {
    return { ok: true, value: "" };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: "due must be an ISO-8601 date/timestamp string (<= 32 chars) or empty string to clear" };
  }
  if (EVIDENCE_CTRL_RE.test(raw)) {
    return { ok: false, error: "due must not contain control characters" };
  }
  if (EVIDENCE_SECRET_RE.test(raw)) {
    return { ok: false, error: "due rejected: appears to contain a secret or token" };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, value: "" };
  }
  if (trimmed.length > 32 || !Number.isFinite(Date.parse(trimmed))) {
    return { ok: false, error: "due must be a valid ISO-8601 date/timestamp (<= 32 chars) or empty string to clear" };
  }
  return { ok: true, value: trimmed };
}

const OKR_TASK_CONTRIBUTES_CAP = 5;

export function validateOkrTaskAssigneeInput(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") {
    return { ok: false, error: "assignee must be a non-empty agent handle string" };
  }
  const trimmed = raw.trim().replace(/^@+/, "");
  if (!trimmed || trimmed.length > 128 || EVIDENCE_CTRL_RE.test(trimmed)) {
    return { ok: false, error: "assignee must be a non-empty agent handle (<=128 chars)" };
  }
  if (trimmed.includes("@")) {
    return { ok: false, error: "assignee rejected: must be an agent handle, never an email address" };
  }
  if (EVIDENCE_SECRET_RE.test(trimmed)) {
    return { ok: false, error: "assignee rejected: appears to contain a secret or token" };
  }
  if (!SAFE_CHANNEL_OR_LOOP_ID_RE.test(trimmed) || trimmed.includes("..")) {
    return { ok: false, error: `assignee "${trimmed}" contains invalid characters` };
  }
  return { ok: true, value: trimmed };
}

export function validateOkrTaskContributesToInput(
  raw: unknown,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: `contributes_to must be an array of KR IDs (0..${OKR_TASK_CONTRIBUTES_CAP} items; pass [] to clear)`,
    };
  }
  if (raw.length === 0) return { ok: true, value: [] };
  if (raw.length > OKR_TASK_CONTRIBUTES_CAP) {
    return { ok: false, error: `contributes_to exceeds max ${OKR_TASK_CONTRIBUTES_CAP} KR IDs` };
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== "string") {
      return { ok: false, error: `contributes_to[${i}] must be a non-empty KR ID string` };
    }
    const id = item.trim();
    if (!id || id.length > 128 || EVIDENCE_CTRL_RE.test(id)) {
      return { ok: false, error: `contributes_to[${i}] must be a non-empty KR ID (<=128 chars)` };
    }
    if (EVIDENCE_SECRET_RE.test(id)) {
      return { ok: false, error: `contributes_to[${i}] rejected: appears to contain a secret or token` };
    }
    if (!SAFE_CHANNEL_OR_LOOP_ID_RE.test(id) || id.includes("..")) {
      return { ok: false, error: `contributes_to[${i}] contains invalid KR ID characters` };
    }
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return { ok: true, value: out };
}

const OKR_TASK_DEPENDS_ON_CAP = 20;
const OKR_LINKED_CHANNEL_DOCS_CAP = 10;
const OKR_DOC_CHANNEL_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const OKR_DOC_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const OKR_NARRATIVE_MAX = 2000;

export interface OkrLinkedChannelDocInput {
  channel_id: string;
  doc_id: string;
}

export function validateOkrTaskDependsOnInput(
  raw: unknown,
  selfTaskId?: string,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: `depends_on must be an array of task IDs (0..${OKR_TASK_DEPENDS_ON_CAP} items; pass [] to clear)`,
    };
  }
  if (raw.length === 0) return { ok: true, value: [] };
  if (raw.length > OKR_TASK_DEPENDS_ON_CAP) {
    return { ok: false, error: `depends_on exceeds max ${OKR_TASK_DEPENDS_ON_CAP} task IDs` };
  }
  const normalizedSelf = typeof selfTaskId === "string" ? selfTaskId.trim() : "";
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== "string") {
      return { ok: false, error: `depends_on[${i}] must be a non-empty task ID string` };
    }
    const id = item.trim();
    if (!id || id.length > 128 || EVIDENCE_CTRL_RE.test(id)) {
      return { ok: false, error: `depends_on[${i}] must be a non-empty task ID (<=128 chars)` };
    }
    if (EVIDENCE_SECRET_RE.test(id)) {
      return { ok: false, error: `depends_on[${i}] rejected: appears to contain a secret or token` };
    }
    if (!SAFE_CHANNEL_OR_LOOP_ID_RE.test(id) || id.includes("..")) {
      return { ok: false, error: `depends_on[${i}] contains invalid task ID characters` };
    }
    if (normalizedSelf && id === normalizedSelf) {
      return { ok: false, error: `depends_on[${i}] cannot reference the task itself (${id})` };
    }
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return { ok: true, value: out };
}

export function validateOkrLinkedChannelDocsInput(
  raw: unknown,
  expectedChannelId?: string,
): { ok: true; value: OkrLinkedChannelDocInput[] } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: `linked_channel_docs must be an array of {channel_id, doc_id} objects (0..${OKR_LINKED_CHANNEL_DOCS_CAP} items; pass [] to clear)`,
    };
  }
  if (raw.length === 0) return { ok: true, value: [] };
  if (raw.length > OKR_LINKED_CHANNEL_DOCS_CAP) {
    return { ok: false, error: `linked_channel_docs exceeds max ${OKR_LINKED_CHANNEL_DOCS_CAP} items` };
  }
  const requiredChannel = typeof expectedChannelId === "string" ? expectedChannelId.trim() : "";
  const out: OkrLinkedChannelDocInput[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: `linked_channel_docs[${i}] must be an object with channel_id and doc_id` };
    }
    const rawChannelId = (item as Record<string, unknown>).channel_id;
    const rawDocId = (item as Record<string, unknown>).doc_id;
    if (typeof rawChannelId !== "string" || typeof rawDocId !== "string") {
      return { ok: false, error: `linked_channel_docs[${i}] requires string channel_id and doc_id` };
    }
    const channelId = rawChannelId.trim();
    const docId = rawDocId.trim();
    if (!channelId || !OKR_DOC_CHANNEL_ID_RE.test(channelId) || /^dm-/i.test(channelId)) {
      return {
        ok: false,
        error: `linked_channel_docs[${i}].channel_id must be a valid non-DM room ID (1..80 chars)`,
      };
    }
    if (EVIDENCE_SECRET_RE.test(channelId) || EVIDENCE_SECRET_RE.test(docId)) {
      return { ok: false, error: `linked_channel_docs[${i}] rejected: appears to contain a secret or token` };
    }
    if (!docId || !OKR_DOC_ID_RE.test(docId)) {
      return { ok: false, error: `linked_channel_docs[${i}].doc_id must match ^[A-Za-z0-9_-]{1,120}$` };
    }
    if (requiredChannel && channelId !== requiredChannel) {
      return {
        ok: false,
        error: `linked_channel_docs[${i}].channel_id (${channelId}) must match discussion_channel_id (${requiredChannel})`,
      };
    }
    const key = `${channelId}:${docId}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ channel_id: channelId, doc_id: docId });
    }
  }
  return { ok: true, value: out };
}

export function validateOkrObjectiveNarrativeInput(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (raw === null || raw === "") return { ok: true, value: "" };
  if (typeof raw !== "string") {
    return { ok: false, error: "narrative must be a string" };
  }
  if (raw.length > OKR_NARRATIVE_MAX || EVIDENCE_CTRL_RE.test(raw)) {
    return { ok: false, error: `narrative must be <= ${OKR_NARRATIVE_MAX} chars without control characters` };
  }
  if (EVIDENCE_SECRET_RE.test(raw)) {
    return { ok: false, error: "narrative rejected: appears to contain a secret or token" };
  }
  return { ok: true, value: raw.trim() };
}

const OKR_OBJECTIVE_TITLE_MAX = 200;
const OKR_COMPLETION_SUMMARY_MAX = 280;
const OKR_OBJECTIVE_STATUSES = ["active", "done", "abandoned"] as const;
const OKR_OBJECTIVE_HORIZONS = ["week", "month", "Q"] as const;

export function validateOkrCompletionSummaryInput(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (raw === null || raw === "") return { ok: true, value: "" };
  if (typeof raw !== "string") {
    return { ok: false, error: "completion_summary must be a string" };
  }
  if (EVIDENCE_CTRL_RE.test(raw)) {
    return { ok: false, error: "completion_summary must not contain control characters" };
  }
  if (EVIDENCE_SECRET_RE.test(raw)) {
    return { ok: false, error: "completion_summary rejected: appears to contain a secret or token" };
  }
  const trimmed = raw.trim();
  if (trimmed.length > OKR_COMPLETION_SUMMARY_MAX) {
    return { ok: false, error: `completion_summary exceeds max ${OKR_COMPLETION_SUMMARY_MAX} chars` };
  }
  return { ok: true, value: trimmed };
}

export interface ValidatedOkrUpdateObjectiveInput {
  objective_id: string;
  body: Record<string, unknown>;
}

export function validateOkrUpdateObjectiveInput(
  args: unknown,
): { ok: true; value: ValidatedOkrUpdateObjectiveInput } | { ok: false; error: string } {
  const a = args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
  const objectiveId = typeof a.objective_id === "string" ? a.objective_id.trim() : "";
  if (
    !objectiveId ||
    !SAFE_CHANNEL_OR_LOOP_ID_RE.test(objectiveId) ||
    objectiveId.includes("..") ||
    EVIDENCE_CTRL_RE.test(objectiveId) ||
    EVIDENCE_SECRET_RE.test(objectiveId)
  ) {
    return { ok: false, error: "objective_id must be a valid non-empty identifier" };
  }

  const body: Record<string, unknown> = {};

  if (a.title !== undefined) {
    if (typeof a.title !== "string") {
      return { ok: false, error: "title must be a non-empty string (<= 200 chars)" };
    }
    if (EVIDENCE_CTRL_RE.test(a.title)) {
      return { ok: false, error: "title must not contain control characters" };
    }
    if (EVIDENCE_SECRET_RE.test(a.title)) {
      return { ok: false, error: "title rejected: appears to contain a secret or token" };
    }
    const trimmedTitle = a.title.trim();
    if (!trimmedTitle || trimmedTitle.length > OKR_OBJECTIVE_TITLE_MAX) {
      return { ok: false, error: `title must be 1..${OKR_OBJECTIVE_TITLE_MAX} chars` };
    }
    body.title = trimmedTitle;
  }

  if (a.status !== undefined) {
    if (
      typeof a.status !== "string" ||
      !(OKR_OBJECTIVE_STATUSES as readonly string[]).includes(a.status)
    ) {
      return { ok: false, error: "status must be active, done, or abandoned" };
    }
    body.status = a.status;
  }

  if (a.horizon !== undefined) {
    if (
      typeof a.horizon !== "string" ||
      !(OKR_OBJECTIVE_HORIZONS as readonly string[]).includes(a.horizon)
    ) {
      return { ok: false, error: "horizon must be week, month, or Q" };
    }
    body.horizon = a.horizon;
  }

  if (a.due !== undefined) {
    if (a.due === null || a.due === "") {
      body.due = "";
    } else if (typeof a.due === "string") {
      if (EVIDENCE_CTRL_RE.test(a.due)) {
        return { ok: false, error: "due must not contain control characters" };
      }
      if (EVIDENCE_SECRET_RE.test(a.due)) {
        return { ok: false, error: "due rejected: appears to contain a secret or token" };
      }
      const trimmedDue = a.due.trim();
      if (!trimmedDue) {
        body.due = "";
      } else if (trimmedDue.length > 32 || !Number.isFinite(Date.parse(trimmedDue))) {
        return { ok: false, error: "due must be a valid ISO-8601 date/timestamp (<= 32 chars) or empty string to clear" };
      } else {
        body.due = trimmedDue;
      }
    } else {
      return { ok: false, error: "due must be an ISO-8601 date string or empty string to clear" };
    }
  }

  if (a.narrative !== undefined) {
    const narCheck = validateOkrObjectiveNarrativeInput(a.narrative);
    if (!narCheck.ok) return narCheck;
    body.narrative = narCheck.value;
  }

  if (a.completion_summary !== undefined) {
    const sumCheck = validateOkrCompletionSummaryInput(a.completion_summary);
    if (!sumCheck.ok) return sumCheck;
    body.completion_summary = sumCheck.value;
  }

  if (a.linked_channel_docs !== undefined) {
    const docsCheck = validateOkrLinkedChannelDocsInput(a.linked_channel_docs);
    if (!docsCheck.ok) return docsCheck;
    if (docsCheck.value.length > 1) {
      const firstChan = docsCheck.value[0].channel_id;
      if (docsCheck.value.some((d) => d.channel_id !== firstChan)) {
        return { ok: false, error: "linked_channel_docs items on an Objective must all reference the same channel_id" };
      }
    }
    body.linked_channel_docs = docsCheck.value;
  }

  if (Object.keys(body).length === 0) {
    return {
      ok: false,
      error: "at least one mutable field (title, status, horizon, due, narrative, completion_summary, linked_channel_docs) is required",
    };
  }

  if (a.if_match_updated_at !== undefined && a.if_match_updated_at !== null) {
    const verCheck = validateTaskVersionToken(a.if_match_updated_at);
    if (!verCheck.ok) {
      return { ok: false, error: verCheck.error };
    }
    body.if_match_updated_at = verCheck.value;
  }

  return { ok: true, value: { objective_id: objectiveId, body } };
}


export function validateOkrArchiveObjectiveInput(
  args: unknown,
): { ok: true; value: { objective_id: string; body: Record<string, unknown> } } | { ok: false; error: string } {
  const a = args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
  const objectiveId = typeof a.objective_id === "string" ? a.objective_id.trim() : "";
  if (
    !objectiveId ||
    !SAFE_CHANNEL_OR_LOOP_ID_RE.test(objectiveId) ||
    objectiveId.includes("..") ||
    EVIDENCE_CTRL_RE.test(objectiveId) ||
    EVIDENCE_SECRET_RE.test(objectiveId)
  ) {
    return { ok: false, error: "objective_id must be a valid non-empty identifier" };
  }
  const body: Record<string, unknown> = {};
  if (a.completion_summary !== undefined && a.completion_summary !== null) {
    const sumCheck = validateOkrCompletionSummaryInput(a.completion_summary);
    if (!sumCheck.ok) return sumCheck;
    if (sumCheck.value) {
      body.completion_summary = sumCheck.value;
    }
  }
  return { ok: true, value: { objective_id: objectiveId, body } };
}

export interface ValidatedListLoopsFilter {
  channel_id?: string;
  status?: "active" | "paused";
  mode?: CreateLoopMode;
  objective_id?: string;
}

export function validateListLoopsInput(
  args: unknown,
): { ok: true; value: ValidatedListLoopsFilter } | { ok: false; error: string } {
  const a = args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
  const out: ValidatedListLoopsFilter = {};
  if (a.channel_id !== undefined && a.channel_id !== null) {
    const cid = typeof a.channel_id === "string" ? a.channel_id.trim() : "";
    if (!SAFE_CHANNEL_OR_LOOP_ID_RE.test(cid) || cid.includes("..") || EVIDENCE_SECRET_RE.test(cid)) {
      return { ok: false, error: "list_loops channel_id must be a valid channel identifier." };
    }
    out.channel_id = cid;
  }
  if (a.status !== undefined && a.status !== null) {
    if (a.status !== "active" && a.status !== "paused") {
      return { ok: false, error: "list_loops status must be one of: active, paused." };
    }
    out.status = a.status;
  }
  if (a.mode !== undefined && a.mode !== null) {
    if (typeof a.mode !== "string" || !(CREATE_LOOP_MODES as readonly string[]).includes(a.mode)) {
      return { ok: false, error: "list_loops mode must be one of: okr_wake, okr_watch, prompt." };
    }
    out.mode = a.mode as CreateLoopMode;
  }
  if (a.objective_id !== undefined && a.objective_id !== null) {
    const oid = typeof a.objective_id === "string" ? a.objective_id.trim() : "";
    if (!SAFE_OBJECTIVE_ID_RE.test(oid) || EVIDENCE_SECRET_RE.test(oid)) {
      return { ok: false, error: "list_loops objective_id must be a valid objective identifier." };
    }
    out.objective_id = oid;
  }
  return { ok: true, value: out };
}

const SAFE_MEMORY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export interface ValidatedDeleteMemoryInput {
  name: string;
  if_match_version?: number;
  allow_missing?: boolean;
}

export function validateDeleteMemoryInput(
  args: unknown,
): { ok: true; value: ValidatedDeleteMemoryInput } | { ok: false; error: string } {
  const a = args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
  const name = typeof a.name === "string" ? a.name.trim() : "";
  if (
    !name ||
    !SAFE_MEMORY_NAME_RE.test(name) ||
    name.includes("..") ||
    EVIDENCE_CTRL_RE.test(name) ||
    EVIDENCE_SECRET_RE.test(name)
  ) {
    return {
      ok: false,
      error: "delete_memory requires a valid memory name (1..64 alphanumeric/._- chars starting with alphanumeric).",
    };
  }
  const out: ValidatedDeleteMemoryInput = { name };
  if (a.if_match_version !== undefined && a.if_match_version !== null) {
    if (
      typeof a.if_match_version !== "number" ||
      !Number.isSafeInteger(a.if_match_version) ||
      a.if_match_version < 1 ||
      a.if_match_version > 1_000_000
    ) {
      return { ok: false, error: "delete_memory if_match_version must be an integer in 1..1000000." };
    }
    out.if_match_version = a.if_match_version;
  }
  if (a.allow_missing !== undefined && a.allow_missing !== null) {
    if (typeof a.allow_missing !== "boolean") {
      return { ok: false, error: "delete_memory allow_missing must be a boolean." };
    }
    out.allow_missing = a.allow_missing;
  }
  return { ok: true, value: out };
}
