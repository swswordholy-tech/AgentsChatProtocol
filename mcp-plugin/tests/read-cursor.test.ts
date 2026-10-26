import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flushCursor, loadCursor, persistCursor } from "../src/read-cursor.ts";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cursor-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("flushCursor clears dirty only after the write lands", () => {
  /**
   * The bug: the old flush set `dirty = false` before writing. A failed write therefore
   * discarded the cursor AND disabled its own retry — the shutdown fallback flush sees
   * `!dirty` and returns immediately. Both assertions below fail on the old semantics.
   */
  test("a failed write keeps the cursor dirty, so the fallback flush actually retries", () => {
    const state = { dirty: true };
    let attempts = 0;
    const failingWrite = () => { attempts++; return false; };

    expect(flushCursor(state, failingWrite)).toBe(false);
    expect(state.dirty).toBe(true); // old: false — cursor silently dropped

    flushCursor(state, failingWrite); // the shutdown fallback
    expect(attempts).toBe(2); // old: 1 — the fallback early-returned on !dirty
  });

  test("a landed write clears dirty; the fallback flush is then a no-op", () => {
    const state = { dirty: true };
    let attempts = 0;
    const goodWrite = () => { attempts++; return true; };

    expect(flushCursor(state, goodWrite)).toBe(true);
    expect(state.dirty).toBe(false);
    expect(flushCursor(state, goodWrite)).toBe(false);
    expect(attempts).toBe(1); // no redundant write on shutdown
  });

  test("control: a clean cursor never touches disk", () => {
    // Without this, `attempts` assertions above could pass on a flush that always writes.
    let attempts = 0;
    expect(flushCursor({ dirty: false }, () => { attempts++; return true; })).toBe(false);
    expect(attempts).toBe(0);
  });
});

describe("loadCursor distinguishes 'never existed' from 'we just lost it'", () => {
  /**
   * This runs ONCE at startup — there is no second attempt that could notice the failure.
   * A corrupt/unreadable file silently reset remembered state on the old implementation.
   */
  test("a corrupt file reports the reset instead of pretending it was empty", () => {
    const file = join(dir, "c.json");
    writeFileSync(file, "{ this is not json");
    const warnings: string[] = [];

    expect(loadCursor(file, (m) => warnings.push(m)).size).toBe(0);
    expect(warnings.join("")).toMatch(/could not read/); // old: silent
    expect(warnings.join("")).toContain(file);
  });

  test("control: a missing file is the normal first run and stays quiet", () => {
    // Without this, the assertion above could pass on a warn that always fires.
    const warnings: string[] = [];
    expect(loadCursor(join(dir, "absent.json"), (m) => warnings.push(m)).size).toBe(0);
    expect(warnings).toEqual([]);
  });

  test("control: a valid file round-trips quietly", () => {
    const file = join(dir, "c.json");
    writeFileSync(file, JSON.stringify({ chan: "ts" }));
    const warnings: string[] = [];
    expect(loadCursor(file, (m) => warnings.push(m))).toEqual(new Map([["chan", "ts"]]));
    expect(warnings).toEqual([]);
  });
});

describe("persistCursor reports failures instead of swallowing them", () => {
  test("an unwritable path returns false and names the file", () => {
    const warnings: string[] = [];
    const ok = persistCursor(join(dir, "no-such-dir", "c.json"), new Map([["chan", "ts"]]), (m) => warnings.push(m));

    expect(ok).toBe(false); // old: returned void, caller could not tell
    expect(warnings.join("")).toMatch(/failed to persist read cursor/); // old: silent
  });

  test("control: a successful write returns true, stays quiet, and round-trips", () => {
    const file = join(dir, "c.json");
    const warnings: string[] = [];
    const ok = persistCursor(file, new Map([["chan", "2026-07-10T00:00:00Z"]]), (m) => warnings.push(m));

    expect(ok).toBe(true);
    expect(warnings).toEqual([]); // proves the warn assertion above isn't vacuous
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ chan: "2026-07-10T00:00:00Z" });
  });
});
