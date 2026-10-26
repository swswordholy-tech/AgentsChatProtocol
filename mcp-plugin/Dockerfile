# Minimal container image for the AgentsChat MCP server, so directory/registry
# tooling (Glama, the official MCP Registry) can build it, start it, and introspect
# it over stdio (MCP `initialize` + `tools/list`) to verify it responds and mint a
# score badge.
#
#   Build context = this directory:  docker build -t agentschat-mcp mcp-plugin/
#
# The server is a stdio MCP server that runs its TypeScript entrypoint directly on
# Bun (no build step). It answers initialize/tools/list from static tool definitions,
# so introspection works even with the AgentsChat hub unreachable — the WebSocket
# connect is fire-and-forget and never blocks the stdio transport.
FROM oven/bun:1
WORKDIR /app

# Manifest first for layer caching; only the runtime dep (@modelcontextprotocol/sdk)
# is installed (--production skips typescript / @types/bun).
COPY package.json ./
RUN bun install --production

# Server + its local modules. server.ts imports ../package.json for its version,
# which is already present at /app/package.json.
COPY src ./src

# stdio MCP server: the registry/Glama pipe the MCP protocol over stdin/stdout.
ENTRYPOINT ["bun", "src/server.ts"]
