#!/usr/bin/env node
// Keep package specifiers in the docs shipped INSIDE the npm package consistent
// on `agentschat-mcp@latest` (no stale hardcoded version pins) and keep
// `server.json` aligned with `package.json` version.
//
// Policy:
//   - In-package docs use `agentschat-mcp@latest` for npx / npm commands so
//     operators and agents never copy stale hardcoded version numbers.
//   - Bare unpinned `npx agentschat-mcp` or hardcoded semver/range tags in docs
//     are flagged as drift.
//   - `server.json` version fields stay synced to `package.json` version.
//
// Usage:
//   node scripts/sync-doc-versions.mjs --check            exit 1 on drift (CI / verify / tests)
//   node scripts/sync-doc-versions.mjs --write [--git-add] rewrite pins to @latest (+ server.json to pkg.version)
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

export const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `agentschat-mcp@1.2.3` / `@1.2.3-rc.1` (also the legacy `agentchat-mcp` bin name). */
export const PINNED_RE = /\b(agents?chat-mcp)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/g;
// Check complete package specs too: tags/ranges must not evade the numeric-pin
// matcher. Angle-bracket placeholders such as @<version> are not launch specs.
const SPEC_RE = /\bagents?chat-mcp@([^\s`'"<>()\[\]{},;|&/]+)/g;
const UNPINNED_RUNNER_RE = /\b(?:npx|bunx)\s+(?:(?:-y|--yes)\s+)?agents?chat-mcp(?=$|[\s`])/g;

/** Text files shipped in the tarball (package.json "files"), minus history + code. */
export function docFiles(pkgDir = PKG_DIR) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const out = new Set();
  const want = (p) => /\.(md|sh|mjs)$/.test(p)
    && !/(^|\/)CHANGELOG\.md$/.test(p)            // release history keeps old versions
    && p !== "scripts/sync-doc-versions.mjs"
    && !p.startsWith("src/") && !p.startsWith("dist/");
  const walk = (rel) => {
    const abs = join(pkgDir, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const e of readdirSync(abs)) walk(join(rel, e));
    } else if (want(rel)) out.add(rel);
  };
  for (const f of pkg.files ?? []) walk(f.replace(/\/$/, ""));
  return [...out].sort();
}

/** Rewrite every hardcoded semver pin in `text` to `targetTag` (defaults to `latest`). */
export function rewritePins(text, targetTag = "latest") {
  return text.replace(PINNED_RE, (_m, name) => `${name}@${targetTag}`);
}

/** Problems in one file's text: unpinned runners or non-@latest specs. */
export function findDrift(text, _version = "latest", file = "<text>") {
  const problems = [];
  text.split("\n").forEach((line, i) => {
    for (const command of line.matchAll(UNPINNED_RUNNER_RE)) {
      problems.push(`${file}:${i + 1}: ${command[0]} omits @latest; use agentschat-mcp@latest`);
    }
    for (const spec of line.matchAll(SPEC_RE)) {
      if (spec[1] !== "latest") {
        problems.push(`${file}:${i + 1}: ${spec[0]} (hardcoded or non-latest version; use agentschat-mcp@latest)`);
      }
    }
  });
  return problems;
}

export function check(pkgDir = PKG_DIR) {
  const { version } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const problems = [];
  for (const f of docFiles(pkgDir)) problems.push(...findDrift(readFileSync(join(pkgDir, f), "utf8"), version, f));
  return { version, problems };
}

export function write(pkgDir = PKG_DIR) {
  const { version } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const changed = [];
  for (const f of docFiles(pkgDir)) {
    const abs = join(pkgDir, f);
    const before = readFileSync(abs, "utf8");
    const after = rewritePins(before, "latest");
    if (after !== before) { writeFileSync(abs, after); changed.push(f); }
  }
  // server.json is the MCP-registry artifact; keep it in step with package.json version.
  const srvPath = join(pkgDir, "server.json");
  if (existsSync(srvPath)) {
    const raw = readFileSync(srvPath, "utf8");
    const srv = JSON.parse(raw);
    srv.version = version;
    for (const p of srv.packages ?? []) p.version = version;
    const next = JSON.stringify(srv, null, 2) + "\n";
    if (next !== raw) { writeFileSync(srvPath, next); changed.push("server.json"); }
  }
  return { version, changed };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("sync-doc-versions.mjs")) {
  const args = process.argv.slice(2);
  if (args.includes("--write")) {
    const { version, changed } = write();
    console.log(`sync-doc-versions: synced @latest in docs and ${version} in server.json (${changed.length} file(s)${changed.length ? ": " + changed.join(", ") : ""})`);
    if (args.includes("--git-add")) {
      const inGit = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: PKG_DIR, encoding: "utf8" });
      if (inGit.status === 0) {
        const paths = [...changed, "dist"].filter((p) => existsSync(join(PKG_DIR, p)));
        const r = spawnSync("git", ["add", "--", ...paths], { cwd: PKG_DIR, stdio: "inherit" });
        if (r.status !== 0) process.exit(r.status ?? 1);
      }
    }
  }
  const { version, problems } = check();
  if (problems.length) {
    console.error(`✗ doc version drift vs @latest (package.json ${version}):\n  ${problems.join("\n  ")}\n  Fix: node scripts/sync-doc-versions.mjs --write`);
    process.exit(1);
  }
  console.log(`✓ doc versions ok (agentschat-mcp@latest, package.json ${version})`);
}
