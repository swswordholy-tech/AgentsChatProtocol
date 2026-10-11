// Guards the "remember to bump server.json on every publish" footgun (coordinator's
// note): server.json's version is hand-maintained (it's the MCP-registry submission
// artifact, not shipped in the npm tarball), so it silently drifts from package.json.
// Also probe the declared Node entrypoint before any rebuild can hide a stale bundle.
// Both `verify` and the read-only `prepublishOnly` gate use this check.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const dir = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(dir, "..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const srv = JSON.parse(readFileSync(join(pkgDir, "server.json"), "utf8"));

const drift = [];
if (typeof pkg.version !== "string" || !pkg.version.trim()) drift.push("package.json .version is missing");
if (srv.version !== pkg.version) drift.push(`server.json .version=${srv.version}`);
const packages = Array.isArray(srv.packages) ? srv.packages : [];
if (!packages.some((p) => p?.registryType === "npm" && p.identifier === pkg.name)) {
  drift.push(`server.json has no npm package descriptor for ${pkg.name}`);
}
for (const p of packages) {
  if (!p) { drift.push("server.json has an invalid package descriptor"); continue; }
  if (p.version !== pkg.version) drift.push(`server.json packages[].version=${p.version}`);
}
const entry = pkg.bin?.[pkg.name];
if (typeof entry !== "string" || !entry) {
  drift.push(`package.json has no executable for ${pkg.name}`);
} else if (!drift.length) {
  // Help exits before identity lookup, registration, or network activity. A private
  // temporary home and a minimal environment keep local operator state out of it.
  const home = mkdtempSync(join(tmpdir(), "agentschat-version-"));
  try {
    const result = spawnSync("node", [entry, "--help"], {
      cwd: pkgDir, env: { PATH: process.env.PATH, HOME: home },
      encoding: "utf8", timeout: 10000,
    });
    if (result.error || result.status !== 0) {
      drift.push(`Node entrypoint ${entry} --help failed (${result.error?.message ?? result.status})`);
    } else if (!result.stdout.includes(`npx -y ${pkg.name}@${pkg.version} --profile <Bot>`)) {
      drift.push(`Node entrypoint ${entry} does not report package.json version ${pkg.version}; rebuild and review dist before publishing`);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
}
if (drift.length) {
  console.error(`✗ version drift vs package.json ${pkg.version}: ${drift.join(", ")} — fix and review before publishing.`);
  process.exit(1);
}
console.log(`✓ version sync ok (${pkg.version})`);
