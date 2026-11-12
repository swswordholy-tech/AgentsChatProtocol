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
  /(?:ac_[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:sk|rk)-(?:live-|test-|proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16})/;

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
