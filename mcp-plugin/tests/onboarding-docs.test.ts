/** Perspective: operators copying onboarding commands. Invariant: documented launch
 * paths use existing private identities, without implicit registration. Goal: prevent
 * credential/consent regressions and obsolete fork-only Codex setup. Migration: keep
 * with onboarding docs; assertions pin user-visible entry points and exclusions. */
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
  // Inline launch config may refer to a private profile, but it must not carry
  // credentials or an environment block that can accidentally inline them.
  const containsCredentials = (value: unknown): boolean => {
    if (typeof value === 'string') return /--token|AGENTS?CHAT_TOKEN|ac_[A-Za-z0-9]{6,}|Bearer\s+\S+/i.test(value);
    if (Array.isArray(value)) return value.some(containsCredentials);
    if (value && typeof value === 'object') return Object.entries(value).some(([key, nested]) =>
      /^(?:env|key|token|secret|password|authorization|api[_-]?key|access[_-]?token)$/i.test(key) || containsCredentials(nested));
    return false;
  };
  for (const match of text.matchAll(/--mcp-config\s+'(\{[^\n]*\})'/g)) {
    expect(containsCredentials(JSON.parse(match[1]!))).toBe(false);
  }
  // Controls keep this boundary check honest without pinning a launch payload.
  expect(containsCredentials({ env: { AGENTCHAT_TOKEN: 'example' } })).toBe(true);
  expect(containsCredentials({ args: ['--token', 'example'] })).toBe(true);
  expect(containsCredentials({ nested: { api_key: 'example' } })).toBe(true);
  expect(containsCredentials({ args: ['--profile', 'Existing-Agent'] })).toBe(false);
  expect(text).not.toContain('First run registers');
  const codex = text.split('## 2. Codex')[1]!.split('## 3. OpenClaw')[0]!;
  expect(codex).toContain('--codex-bridge --cwd /absolute/path/my-project --check');
  expect(codex).toContain('.codex/config.toml');
  expect(codex).not.toContain('git clone https://github.com/swswordholy-tech/codex');
  expect(codex).not.toMatch(/node .*--(?:name|register|accept-terms)/);
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
