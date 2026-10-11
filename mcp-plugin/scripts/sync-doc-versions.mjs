#!/usr/bin/env node
// Keep the version pins in the docs shipped INSIDE the npm package equal to
// package.json's version, so a configured connection copied from a guide never
// drifts (`agentschat-mcp@latest` silently changes the code a bot runs).
//
// Policy:
//   - In-package docs pin THIS package version: `agentschat-mcp@<package.json version>`.
//   - `@latest` is allowed only on the first-install / discovery lines the public
//     join page points at (ALLOWED_LATEST below). Everything else is drift.
//   - Repo-level docs outside the package (root README, /join page) are not checked:
//     they intentionally use `@latest` for first install.
//
// Usage:
//   node scripts/sync-doc-versions.mjs --check            exit 1 on drift (CI / verify / tests)
//   node scripts/sync-doc-versions.mjs --write [--git-add] rewrite pins (+ server.json) to package.json
// Wired into `npm version` via the package.json "version" lifecycle hook, which runs
// after package.json is bumped and before npm's commit.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

export const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `agentschat-mcp@1.2.3` / `@1.2.3-rc.1` (also the legacy `agentchat-mcp` bin name). */
export const PINNED_RE = /\b(agents?chat-mcp)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/g;
const LATEST_RE = /\bagents?chat-mcp@latest\b/g;

/**
 * `@latest` is intentional only where the guide bootstraps / discovers the newest
 * published release (the join page → unpkg@latest guide → `--help`). Matched per line.
 */
export const ALLOWED_LATEST = [
  /npx -y agentschat-mcp@latest --help\b/,
  /npm pack agentschat-mcp@latest\b/,
  /npm view agentschat-mcp@latest version\b/,
  /unpkg\.com\/agentschat-mcp@latest\/skills\/onboarding\.md/,
];

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

/** Rewrite every pinned version in `text` to `version`. */
export function rewritePins(text, version) {
  return text.replace(PINNED_RE, (_m, name) => `${name}@${version}`);
}

/** Problems in one file's text: wrong pins and non-allowlisted @latest. */
export function findDrift(text, version, file = "<text>") {
  const problems = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(PINNED_RE)) {
      if (m[2] !== version) problems.push(`${file}:${i + 1}: ${m[0]} (package.json is ${version})`);
    }
    if (LATEST_RE.test(line) && !ALLOWED_LATEST.some((re) => re.test(line))) {
      problems.push(`${file}:${i + 1}: @latest in an in-package doc — pin agentschat-mcp@${version} (only first-install/discovery lines may use @latest)`);
    }
    LATEST_RE.lastIndex = 0;
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
    const after = rewritePins(before, version);
    if (after !== before) { writeFileSync(abs, after); changed.push(f); }
  }
  // server.json is the MCP-registry artifact; keep it in step too (check-version-sync guards it).
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
    console.log(`sync-doc-versions: pinned agentschat-mcp@${version} in ${changed.length} file(s)${changed.length ? ": " + changed.join(", ") : ""}`);
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
    console.error(`✗ doc version drift vs package.json ${version}:\n  ${problems.join("\n  ")}\n  Fix: node scripts/sync-doc-versions.mjs --write`);
    process.exit(1);
  }
  console.log(`✓ doc versions ok (agentschat-mcp@${version})`);
}
