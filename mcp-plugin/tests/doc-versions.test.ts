/** Perspective: operators copying launch commands out of the docs shipped in the npm
 * package. Invariant: every npx/npm command in docs uses `agentschat-mcp@latest`
 * (never stale hardcoded semver pins), while `server.json` stays aligned with
 * `package.json` version. */
import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-ignore — plain ESM script shared with the npm `version` hook
import { check, docFiles, findDrift, rewritePins, write } from '../scripts/sync-doc-versions.mjs';

const pkgDir = join(import.meta.dir, '..');
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

test('in-package docs use agentschat-mcp@latest without hardcoded semver drift', () => {
  const { version, problems } = check(pkgDir);
  expect(version).toBe(pkg.version);
  expect(problems).toEqual([]);
});

test('the checked file set covers the shipped onboarding docs and example scripts', () => {
  const files = docFiles(pkgDir);
  for (const f of ['README.md', 'skills/onboarding.md', 'skills/grok-wake-keepalive.md',
    'skills/hermes-host-keepalive.md', 'skills/url-wake-keepalive.md', 'codex/README.md',
    'connector/README.md', 'scripts/example-agy-mcp-wrapper.sh']) expect(files).toContain(f);
  expect(files).not.toContain('CHANGELOG.md');
  expect(files.some((f: string) => f.startsWith('dist/') || f.startsWith('src/'))).toBe(false);
});

test('onboarding uses @latest in configuration and discovery commands', () => {
  const text = readFileSync(join(pkgDir, 'skills/onboarding.md'), 'utf8');
  expect(text).toContain('claude mcp add agentschat -- npx -y agentschat-mcp@latest --profile My-Agent');
  expect(text).toContain('npx -y agentschat-mcp@latest --profile Jack');
  expect(text).toContain('npx -y agentschat-mcp@latest --help');
});

test('findDrift flags hardcoded semver pins and unpinned runners while allowing @latest', () => {
  const doc = [
    'npx -y agentschat-mcp@latest --help',
    'npm view agentschat-mcp@latest version',
    'https://unpkg.com/agentschat-mcp@latest/skills/onboarding.md',
    'claude mcp add a -- npx -y agentschat-mcp@1.2.3 --profile A',
    'claude mcp add b -- npx -y agentschat-mcp@1.2.2 --profile B',
    'claude mcp add c -- npx -y agentschat-mcp@latest --profile C',
  ].join('\n');
  const problems = findDrift(doc, '1.2.3', 'x.md');
  expect(problems).toHaveLength(2);
  expect(problems[0]).toContain('x.md:4: agentschat-mcp@1.2.3');
  expect(problems[1]).toContain('x.md:5: agentschat-mcp@1.2.2');
});

test('configured connections reject hardcoded semver, ranges and non-latest tags', () => {
  for (const spec of ['1.2.3', '^1.2.3', '~1.2.3', '1.x', '*', 'next', '1.2.3+local']) {
    expect(findDrift(`npx -y agentschat-mcp@${spec} --profile Bot-A`, '1.2.3')).toHaveLength(1);
  }
  expect(findDrift('npx -y agentschat-mcp@latest --profile Bot-A', '1.2.3')).toEqual([]);
  expect(findDrift('agentschat-mcp@<version>', '1.2.3')).toEqual([]);
  expect(rewritePins('agentschat-mcp@1.2.3+local')).toBe('agentschat-mcp@latest');
});

test('npm runners require @latest while an already-installed executable is allowed', () => {
  for (const runner of ['npx', 'npx -y', 'npx --yes', 'bunx']) {
    expect(findDrift(`${runner} agentschat-mcp --profile Bot-A`, '1.2.3')).toHaveLength(1);
    expect(findDrift(`${runner} agentschat-mcp@latest --profile Bot-A`, '1.2.3')).toEqual([]);
  }
  expect(findDrift('agentschat-mcp --profile Bot-A', '1.2.3')).toEqual([]);
});

test('rewritePins moves every hardcoded semver pin (incl. prerelease) to @latest', () => {
  const out = rewritePins('a agentschat-mcp@0.1.0 b agentschat-mcp@0.36.12-rc.1 c agentschat-mcp@latest d agentschat-mcp@<version>');
  expect(out).toBe('a agentschat-mcp@latest b agentschat-mcp@latest c agentschat-mcp@latest d agentschat-mcp@<version>');
});

test('write() syncs docs to @latest and server.json to package.json version, leaving CHANGELOG history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doc-versions-'));
  try {
    mkdirSync(join(dir, 'skills'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '2.0.0', files: ['skills/', 'README.md', 'CHANGELOG.md'] }));
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ version: '1.0.0', packages: [{ version: '1.0.0' }] }, null, 2) + '\n');
    writeFileSync(join(dir, 'skills/onboarding.md'), 'npx -y agentschat-mcp@1.0.0 --profile X\n');
    writeFileSync(join(dir, 'README.md'), 'npm i -g agentschat-mcp@1.0.0\n');
    writeFileSync(join(dir, 'CHANGELOG.md'), '## 1.0.0 agentschat-mcp@1.0.0\n');
    expect(check(dir).problems).toHaveLength(2);
    const { changed } = write(dir);
    expect(changed.sort()).toEqual(['README.md', 'server.json', 'skills/onboarding.md']);
    expect(readFileSync(join(dir, 'skills/onboarding.md'), 'utf8')).toBe('npx -y agentschat-mcp@latest --profile X\n');
    expect(JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8')).packages[0].version).toBe('2.0.0');
    expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).toContain('agentschat-mcp@1.0.0');
    expect(check(dir).problems).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('package wires the sync into npm version and verify', () => {
  expect(pkg.scripts.version).toContain('sync-doc-versions.mjs --write');
  expect(pkg.scripts.verify).toContain('sync-doc-versions.mjs --check');
});
