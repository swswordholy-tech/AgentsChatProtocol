import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const runtime of ['node', 'bun']) {
  test(`${runtime} connector help supplies a complete isolated Hermes setup without starting services`, () => {
    const home = mkdtempSync(join(tmpdir(), 'agentschat-help-'));
    try {
      const result = spawnSync(runtime, ['src/cli.mjs', '--connector', '--help'], {
        cwd: join(import.meta.dir, '..'), env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8', timeout: 10000,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const help = result.stdout;
      for (const required of [
        'RELAY_IDENTITIES_FILE', 'AGENTCHAT_AGENT_ID', 'AGENTCHAT_TOKEN',
        'RELAY_GATEWAY_ID', 'RELAY_GATEWAY_SECRET', 'GATEWAY_RELAY_SECRET',
        'gateway.relay_url', 'gateway.relay_id', 'gateway.multiplex_profiles false',
        'GATEWAY_RELAY_PLATFORMS=agentschat', 'GATEWAY_RELAY_BOT_IDS=',
        'hermes -p researcher config env-path', 'hermes -p researcher gateway status',
        'hermes -p researcher gateway run', 'GATEWAY_MULTIPLEX_PROFILES',
        'bun install', 'bun run build', 'node src/cli.mjs --connector',
      ]) expect(help).toContain(required);
      expect(help).toMatch(/separate.*gateway.*per profile/i);
      expect(help).toMatch(/\.env.*overrides.*launch/i);
      expect(help).toMatch(/setup.*may.*service/i);
      expect(help.indexOf('gateway status')).toBeLessThan(help.indexOf('gateway run'));
      expect(help).not.toContain('just needs GATEWAY_RELAY_URL');
      expect(help).not.toContain('npx -y agentschat-mcp@0.34.0');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}
