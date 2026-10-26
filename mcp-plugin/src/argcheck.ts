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
