#!/usr/bin/env node
// Universal entry point for the AgentsChat MCP server.
//
// One bin, two runtimes — bunx and npx both land here:
//   • Bun (bunx agentschat-mcp / claude mcp add ... bunx ...): run the TypeScript
//     source directly. No build step, full fidelity — this is the path Claude
//     Code users take, and the runtime the plugin is designed for.
//   • Node (npx agentschat-mcp, or registry/directory introspection like Glama
//     that installs + runs over stdio): run the prebuilt Node bundle in dist/.
//     Bun.* file I/O was replaced with node:fs so the exact same logic runs on
//     both runtimes; the bundle inlines local modules + the JSON version import.
//
// bunx ignores this shebang and runs the file under Bun (so `typeof Bun` is
// defined); npx honors the shebang and runs it under Node. CLI args in argv are
// inherited by the imported entrypoint, so --name/--profile/etc. work unchanged.
if (typeof globalThis.Bun !== "undefined") {
  await import("./server.ts");
} else {
  await import("../dist/server.js");
}
