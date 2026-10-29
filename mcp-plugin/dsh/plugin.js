/**
 * Host entry point when `agentschat-mcp` is installed as a DeepSeek Harness (DSH)
 * bundle (`dsh plugin --profile desktop add agentschat-mcp` or `web`).
 *
 * Mounts:
 *   1. The loopback inbound wake & per-session identity bridge (`./inbound-bridge/index.js`),
 *      auto-resolving `mcpBin` to the bundled `dist/dsh.js` wake daemon.
 *   2. The host-side liveness marker (`./identity-ui/index.js`) while `@deepseek-ai/dsh-client-modules`
 *      discovers `dsh.client` + `exports["./client"]` (`./dsh/client.js`) from `package.json`.
 */
import { apply as applyIdentityHost } from './identity-ui/index.js';
import { apply as applyInboundBridge } from './inbound-bridge/index.js';

export const name = 'agentschat-mcp';

export function apply(ctx, config = {}) {
  applyIdentityHost(ctx);
  applyInboundBridge(ctx, config);
}
