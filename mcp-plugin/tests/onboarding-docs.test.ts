import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const doc = (name: string) => readFileSync(join(import.meta.dir, '..', name), 'utf8');

test('release draft instructions offer local build and do not promise unpublished npm install', () => {
  for (const name of ['README.md', 'connector/README.md', 'skills/onboarding.md', 'CHANGELOG.md']) {
    const text = doc(name);
    expect(text).toMatch(/unpublished/i);
    expect(text).not.toContain('npx -y agentschat-mcp@0.34.0');
    expect(text).toMatch(/bun install|local build/i);
  }
});

test('onboarding separates human consent, persistent profile launches, and private credentials', () => {
  const text = doc('skills/onboarding.md');
  expect(text).not.toMatch(/claude .*AGENTCHAT_TOKEN=/);
  expect(text).not.toMatch(/claude --mcp-config '\{/);
  expect(text).not.toContain('First run registers');
  expect(text).toContain('"--profile", "My-Codex-Agent"');
  expect(text).toContain('~/.agentschat/');
  expect(text).toMatch(/human.*consent/i);
  expect(text).toMatch(/matching.*agent ID/i);
  expect(doc('README.md')).not.toMatch(/claude mcp add .*--accept-terms/);
  expect(doc('README.md')).toContain('default profile');
});

test('Hermes instructions account for overrides and service lifecycle before foreground start', () => {
  const text = doc('skills/onboarding.md');
  expect(text).toMatch(/\.env.*overrides.*launch/);
  expect(text).toContain('GATEWAY_MULTIPLEX_PROFILES');
  expect(text).toContain('EnvironmentFile');
  expect(text).toContain('gateway status');
  expect(text.indexOf('gateway status')).toBeLessThan(text.indexOf('gateway run'));
  expect(text).toMatch(/setup.*may.*service/i);
  expect(text).toMatch(/401[\s\S]*403[\s\S]*429/);
  expect(text).not.toContain('actually works on\nproduction today');
});
