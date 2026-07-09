#!/usr/bin/env bun
// Build the plain-Node bundle (dist/server.js) from the Bun TypeScript source.
//
// Why a bundle at all: `bunx agentschat-mcp` runs src/server.ts directly on Bun,
// but registry/directory tooling (Glama, etc.) and `npx agentschat-mcp` run under
// plain Node, which can't execute bare .ts. This bundles the source + local
// modules into one Node-ESM file (the @modelcontextprotocol/sdk stays external,
// resolved from node_modules) and normalizes the shebang to node. src/cli.mjs
// picks source-vs-bundle by runtime. `verify` rebuilds this so it never drifts.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const OUT = "dist/server.js";

const r = spawnSync(
  "bun",
  ["build", "src/server.ts", "--target", "node", "--outfile", OUT, "--external", "@modelcontextprotocol/sdk"],
  { stdio: "inherit" },
);
if (r.status !== 0) process.exit(r.status ?? 1);

// bun build copies the entry file's `#!/usr/bin/env bun` shebang into the output.
// This is a Node bundle, so rewrite that first line to the node interpreter
// (correct whether the file is imported by the launcher or executed directly).
let src = readFileSync(OUT, "utf8");
if (src.startsWith("#!")) {
  src = src.replace(/^#![^\n]*\n/, "#!/usr/bin/env node\n");
} else {
  src = "#!/usr/bin/env node\n" + src;
}
writeFileSync(OUT, src);
process.stderr.write(`[build] ${OUT} bundled + shebang normalized for Node\n`);
