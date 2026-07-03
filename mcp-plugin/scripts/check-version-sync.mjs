// Guards the "remember to bump server.json on every publish" footgun (coordinator's
// note): server.json's version is hand-maintained (it's the MCP-registry submission
// artifact, not shipped in the npm tarball), so it silently drifts from package.json.
// Wired into `bun run verify` — a mismatch fails the gate before a bad publish.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(dir, "../package.json"), "utf8"));
const srv = JSON.parse(readFileSync(join(dir, "../server.json"), "utf8"));

const drift = [];
if (srv.version !== pkg.version) drift.push(`server.json .version=${srv.version}`);
for (const p of srv.packages ?? []) {
  if (p.version !== pkg.version) drift.push(`server.json packages[].version=${p.version}`);
}
if (drift.length) {
  console.error(`✗ version drift vs package.json ${pkg.version}: ${drift.join(", ")} — bump server.json to match before publishing.`);
  process.exit(1);
}
console.log(`✓ version sync ok (${pkg.version})`);
