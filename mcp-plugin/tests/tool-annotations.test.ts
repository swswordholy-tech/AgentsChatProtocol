/**
 * Tool annotation coverage — the OpenAI app-directory review rejects on "incorrect
 * or missing action labels", so EVERY tool must be annotated. ALL_TOOL_DEFS lives in
 * server.ts (side-effecting on import — opens a WS), so this suite extracts the tool
 * names from the source text instead of importing it, the same import-closure trick
 * packaging.test.ts uses.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TOOL_ANNOTATIONS, annotateTools } from "../src/tool-annotations.ts";

const SRC = readFileSync(resolve(import.meta.dir, "../src/server.ts"), "utf8");

/** Names declared in the ALL_TOOL_DEFS literal (between its start and the closing of the array). */
function declaredToolNames(): string[] {
  const start = SRC.indexOf("const ALL_TOOL_DEFS");
  expect(start).toBeGreaterThan(-1);
  // The array ends at the first "];" after its start.
  const end = SRC.indexOf("];", start);
  expect(end).toBeGreaterThan(start);
  const body = SRC.slice(start, end);
  const names = [...body.matchAll(/^\s+name: "([a-z_0-9]+)",$/gm)].map((m) => m[1]);
  return [...new Set(names)];
}

describe("tool annotations — full coverage (OpenAI directory requirement)", () => {
  test("every declared tool has an annotation entry", () => {
    const names = declaredToolNames();
    expect(names.length).toBeGreaterThan(20); // sanity: the regex actually matched
    const missing = names.filter((n) => !(n in TOOL_ANNOTATIONS));
    expect(missing).toEqual([]);
  });

  test("no stale annotation entries for tools that no longer exist", () => {
    const names = new Set(declaredToolNames());
    const stale = Object.keys(TOOL_ANNOTATIONS).filter((k) => !names.has(k));
    expect(stale).toEqual([]);
  });

  test("every annotation sets openWorldHint (public-internet service)", () => {
    for (const [name, a] of Object.entries(TOOL_ANNOTATIONS)) {
      expect(a.openWorldHint).toBe(true);
    }
  });

  test("read-only tools are marked readOnlyHint:true and never destructive", () => {
    for (const name of ["whoami", "get_history", "list_channels", "search", "okr_list"]) {
      expect(TOOL_ANNOTATIONS[name]?.readOnlyHint).toBe(true);
      expect(TOOL_ANNOTATIONS[name]?.destructiveHint).toBeUndefined();
    }
  });

  test("destructive tools carry destructiveHint", () => {
    expect(TOOL_ANNOTATIONS.delete_message?.destructiveHint).toBe(true);
    expect(TOOL_ANNOTATIONS.archive_channel?.destructiveHint).toBe(true);
  });

  test("write tools are not marked read-only", () => {
    for (const name of ["reply", "join_channel", "vote", "save_memory"]) {
      expect(TOOL_ANNOTATIONS[name]?.readOnlyHint).toBe(false);
    }
  });

  test("annotateTools attaches annotations and defaults unknown tools to write (fail safe)", () => {
    const out = annotateTools([{ name: "whoami" }, { name: "brand_new_tool" }]);
    expect(out[0].annotations.readOnlyHint).toBe(true);
    expect(out[1].annotations.readOnlyHint).toBe(false); // unknown ≠ read-only
  });
});
