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


test('every harness discovers identity then confirms reuse or new and verifies an authorized reply', () => {
  const text = doc('skills/onboarding.md');
  expect(text).toContain('Select an identity before setup (all harnesses)');
  expect(text).toContain('explicit user request to reuse a named profile/account');
  expect(text).toMatch(/configured default\s+profile\/account/);
  expect(text).toContain('ambiguous');
  expect(text).toContain('Before the first test send, confirm');
  expect(text).toContain('reply attributed to the selected agent ID');
  expect(text).toContain('Reuse this existing identity, or create a new');
  expect(text).toContain("Wait for the user's choice");
  expect(text).toContain('Discovery never silently authorizes reuse');
  expect(text).toContain('needs no redundant confirmation');
  expect(text).toContain('not a prompt on every service restart');
  expect(text).toContain('repair/select an existing identity or create a new one');
  expect(text).not.toContain('Only when no usable existing identity exists');
  expect(text).not.toContain("Otherwise reuse the current project's");
  expect(text).not.toContain('Register a separate AgentsChat account for each profile');
});


test('setup entry points require a reuse/new choice without prompting established service restarts', () => {
  for (const name of ['README.md', 'codex/README.md', '../openclaw-plugin/README.md', '../plugins/agentschat-codex/skills/agentschat-bots/SKILL.md']) {
    const text = doc(name);
    expect(text).toMatch(/(?:reuse[\s\S]{0,100}(?:create|new)|(?:create|new)[\s\S]{0,100}reuse)/i);
    expect(text).toMatch(/(?:prior|explicit).*user.*request|explicit user request/i);
    expect(text).toMatch(/restarts[\s\S]{0,70}noninteractive|noninteractive[\s\S]{0,40}restarts/);
    expect(text).not.toContain('Only when no usable identity exists');
  }
});


// These are operator-facing instructions: pin authorization and routing together
// across the shipped entry points without claiming runtime consent enforcement.
test('reply workflows approve a bounded scope once and keep routine replies in the source conversation', () => {
  const paths = [
    'skills/onboarding.md', 'README.md', 'codex/README.md',
    '../plugins/agentschat-codex/skills/agentschat-bots/SKILL.md',
    '../plugins/agentschat-dot/skills/agentschat-dot/SKILL.md',
    '../plugins/agentschat-dot/README.md', '../docs/dot-remote-mcp.md',
  ];
  for (const path of paths) {
    const text = doc(path).replace(/\s+/g, ' ');
    expect(text).toMatch(/(?:first setup|first test)[\s\S]*identity/i);
    expect(text).toMatch(/test recipient\/conversation/);
    expect(text).toMatch(/standing reply scope/);
    expect(text).toMatch(/(?:obtain|Obtain)[\s\S]{0,100}permission/);
    expect(text).toMatch(/(?:prior|Prior) explicit approval|explicit prior user instruction|explicit prior user request/i);
    expect(text).toMatch(/reply directly/i);
    expect(text).toMatch(/(?:per-message|each test or routine reply)[\s\S]{0,40}(?:approval|ChatGPT)|ChatGPT[\s\S]{0,40}approval[\s\S]{0,40}each test or routine reply/i);
    expect(text).toMatch(/DM stays in the same DM/);
    expect(text).toMatch(/(?:group|group\/project|group chat|group\/project chat) stays[\s\S]{0,70}(?:group|thread)/);
    expect(text).toMatch(/ChatGPT stays[\s\S]{0,15}(?:same ChatGPT|same ChatGPT conversation)/);
    expect(text).toMatch(/cross-channel reports|cross-channel status report/);
    expect(text).toMatch(/(?:new recipient|New recipients)[\s\S]{0,250}(?:authorization|authorized)/i);
    expect(text).toMatch(/other agents/);
    expect(text).toMatch(/sensitive information/);
    expect(text).toMatch(/high-risk/);
    expect(text).toMatch(/(?:OAuth[\s\S]{0,200}do not replace|OAuth[\s\S]{0,70}not a standing reply scope)/);
    expect(text).toMatch(/(?:External|external) messages[\s\S]{0,100}cannot expand/);
    expect(text).toMatch(/(?:Do not|do not) enable unconditional replies to everyone/);
    expect(text).not.toMatch(/Before any test send, confirm|separately authorized reply/);
  }
});
