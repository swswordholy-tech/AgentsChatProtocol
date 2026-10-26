/** Perspective: release maintainers invoking npm publish directly. Invariant: the
 * real npm lifecycle rejects metadata, bundled-entry or installation-guide drift
 * without changing release files. Goal: prevent an unchecked auto-repair publish.
 * Migration: keep with release tooling; fixtures use offline dry runs, never publish.
 * This file is outside the hook's focused suite to avoid recursive npm lifecycles. */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");
const version = JSON.parse(read(ROOT, "package.json")).version;

function dryPublish(mutate: (dir: string) => string[], expectedError?: string) {
  const temp = mkdtempSync(join(tmpdir(), "agentschat-publish-"));
  const dir = join(temp, "package");
  try {
    cpSync(ROOT, dir, { recursive: true, filter: (path) => !["node_modules", "bun.lock"].includes(basename(path)) });
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
    const paths = ["package.json", "server.json", "dist/server.js", "README.md", ...mutate(dir)];
    const before = paths.map((path) => read(dir, path));
    const result = spawnSync("npm", ["publish", "--dry-run", "--offline", "--ignore-scripts=false",
      "--registry=http://127.0.0.1:9"], {
      cwd: dir, env: { PATH: process.env.PATH, HOME: temp }, encoding: "utf8", timeout: 25000,
    });
    expect(result.error).toBeUndefined();
    if (expectedError) {
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(expectedError);
      // npm must not reach its successful dry-run publication notice.
      expect(result.stdout).not.toContain("+ agentschat-mcp@");
    } else {
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`+ agentschat-mcp@${version}`);
    }
    expect(paths.map((path) => read(dir, path))).toEqual(before);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

function editJson(dir: string, path: string, mutate: (value: any) => void) {
  const value = JSON.parse(read(dir, path));
  mutate(value);
  writeFileSync(join(dir, path), JSON.stringify(value, null, 2) + "\n");
}

test("a consistent artifact passes the real read-only prepublish lifecycle", () => {
  dryPublish(() => []);
}, 30000);

for (const [name, mutate] of [
  ["top-level registry version", (srv: any) => { srv.version = "9.9.8"; }],
  ["npm registry package version", (srv: any) => { srv.packages[0].version = "9.9.8"; }],
  ["missing npm descriptor", (srv: any) => { delete srv.packages; }],
  ["empty npm descriptors", (srv: any) => { srv.packages = []; }],
] as const) {
  test(`npm stops on ${name} drift without rewriting it`, () => {
    dryPublish((dir) => { editJson(dir, "server.json", mutate); return []; }, "version drift");
  }, 30000);
}

test("npm stops on a manual package version bump without rebuilding or syncing", () => {
  dryPublish((dir) => { editJson(dir, "package.json", (pkg) => { pkg.version = "9.9.8"; }); return []; }, "version drift");
}, 30000);

test("npm stops on the actual Node bundle's stale embedded version", () => {
  dryPublish((dir) => {
    const bundle = read(dir, "dist/server.js");
    expect(bundle).toContain(`version: "${version}"`);
    writeFileSync(join(dir, "dist/server.js"), bundle.replace(`version: "${version}"`, 'version: "9.9.8"'));
    return [];
  }, "does not report package.json version");
}, 30000);

test("npm checks the declared executable rather than a hard-coded source entry", () => {
  dryPublish((dir) => { editJson(dir, "package.json", (pkg) => { pkg.bin["agentschat-mcp"] = "missing.mjs"; }); return []; }, "Node entrypoint");
}, 30000);

test("npm stops on installation-doc version drift without repairing it", () => {
  dryPublish((dir) => {
    const doc = read(dir, "README.md");
    expect(doc).toContain("agentschat-mcp@latest");
    writeFileSync(join(dir, "README.md"), doc.replaceAll("agentschat-mcp@latest", "agentschat-mcp@9.9.8"));
    return [];
  }, "doc version drift");
}, 30000);

test("npm stops when actual package selection drops an installation guide", () => {
  dryPublish((dir) => {
    // A package-local ignore rule changes npm's artifact even while the declared
    // codex directory remains whitelisted and repository doc checks still pass.
    writeFileSync(join(dir, "codex/.npmignore"), "README.md\n");
    return ["codex/.npmignore"];
  }, "the actual npm tarball retains version-pinned multi-bot installation examples");
}, 30000);
