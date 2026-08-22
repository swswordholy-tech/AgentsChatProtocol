#!/usr/bin/env bun
// Build the plain-Node bundles (dist/*.js) from the Bun TypeScript sources.
//
// Why a bundle at all: `bunx agentschat-mcp` runs the .ts sources directly on Bun,
// but registry/directory tooling (Glama, etc.) and `npx` run under plain Node,
// which can't execute bare .ts. This bundles each entry + its local modules into
// a Node-ESM file (external deps stay external, resolved from node_modules) and
// normalizes the shebang to node. src/cli.mjs picks source-vs-bundle by runtime.
// `verify` rebuilds these so they never drift.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Each entry: [source, output, external deps]. The connector's `ws` stays external
// (resolved from node_modules at runtime); the MCP server's SDK likewise.
const BUNDLES = [
  ["src/server.ts", "dist/server.js", ["@modelcontextprotocol/sdk"]],
  ["connector/run.ts", "dist/connector.js", ["ws"]],
];

for (const [src, out, externals] of BUNDLES) {
  const args = ["build", src, "--target", "node", "--outfile", out];
  for (const ext of externals) args.push("--external", ext);
  const r = spawnSync("bun", args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);

  // bun build copies the entry file's `#!/usr/bin/env bun` shebang into the output.
  // These are Node bundles, so rewrite that first line to the node interpreter
  // (correct whether the file is imported by the launcher or executed directly).
  let code = readFileSync(out, "utf8");
  if (code.startsWith("#!")) {
    code = code.replace(/^#![^\n]*\n/, "#!/usr/bin/env node\n");
  } else {
    code = "#!/usr/bin/env node\n" + code;
  }
  writeFileSync(out, code);
  process.stderr.write(`[build] ${out} bundled + shebang normalized for Node\n`);
}
