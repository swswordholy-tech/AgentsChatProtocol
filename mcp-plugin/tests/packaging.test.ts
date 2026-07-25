/**
 * The published tarball must contain every module the entrypoint imports.
 *
 * 0.30.1 shipped `src/server.ts` importing `./terms.ts` while package.json's `files`
 * whitelist never listed it. `npx` survived (it runs the bundled `dist/server.js`,
 * where the bundler had inlined terms), but `bunx` — documented as an equally
 * supported runtime, and what `src/cli.mjs` selects under Bun — died on import:
 *
 *   error: Cannot find module './terms.ts'
 *
 * No runtime test in this repo could have caught it: they all execute inside the
 * worktree, where src/terms.ts obviously exists. Packaging replaces the filesystem,
 * and nothing observed that replacement.
 *
 * This check does not need to. It compares two pieces of *declared* data — the import
 * graph in the source, and the `files` whitelist — so it runs anywhere and fails in
 * the worktree exactly when the tarball would be incomplete. Transitive by design: a
 * whitelisted module that imports a non-whitelisted one is the same defect.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

/**
 * npm ships these no matter what `files` says, so importing them is not a defect.
 * Confirmed empirically, not from documentation: server.ts imports `../package.json`
 * for its version string, and the packed-then-installed tarball boots under both
 * runtimes — which it could not do if package.json had been omitted.
 */
const ALWAYS_PACKED = ["package.json"];
const whitelist: string[] = [...pkg.files, ...ALWAYS_PACKED];

/** Relative import specifiers in a source file (`import ... from "./x.ts"`). */
function localImports(file: string): string[] {
  const src = readFileSync(join(ROOT, file), "utf-8");
  const out: string[] = [];
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
    out.push(m[1]);
  }
  return out;
}

/** Every module reachable from the packaged entrypoints, as repo-relative paths. */
function reachable(): Map<string, string> {
  const seen = new Map<string, string>(); // module -> importer
  const queue = whitelist.filter((f) => f.endsWith(".ts") || f.endsWith(".mjs"));
  const start = new Set(queue);
  while (queue.length) {
    const file = queue.shift()!;
    for (const spec of localImports(file)) {
      const target = relative(ROOT, resolve(join(ROOT, dirname(file)), spec));
      if (seen.has(target) || start.has(target)) continue;
      seen.set(target, file);
      if (target.endsWith(".ts") || target.endsWith(".mjs")) queue.push(target);
    }
  }
  return seen;
}

describe("package `files` covers the whole import graph", () => {
  test("no module the entrypoint imports is missing from the tarball", () => {
    const missing: string[] = [];
    for (const [mod, importer] of reachable()) {
      if (!whitelist.includes(mod)) missing.push(`${mod} (imported by ${importer})`);
    }
    // Fails today on src/terms.ts; would have failed on the day it was introduced.
    expect(missing).toEqual([]);
  });

  test("the check can say no (control group)", () => {
    // Without this, the assertion above would also pass if `reachable()` silently
    // returned nothing — an empty graph trivially has no missing members.
    const graph = reachable();
    expect(graph.size).toBeGreaterThan(0);
    // And a module that is genuinely absent must be reported as missing.
    const bogus = new Map(graph);
    bogus.set("src/__definitely-not-packaged.ts", "src/server.ts");
    const missing = [...bogus.keys()].filter((m) => !whitelist.includes(m));
    expect(missing).toContain("src/__definitely-not-packaged.ts");
  });

  test("dist bundle and cli entrypoint are both shipped", () => {
    // The two runtimes the README promises: npx runs dist/server.js, bunx runs cli.mjs.
    expect(whitelist).toContain("dist/server.js");
    expect(whitelist).toContain("src/cli.mjs");
    expect(pkg.bin).toBeTruthy();
  });
});
