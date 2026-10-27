import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { copyWorkspace, inspectWorkspace, isExcluded } from '../../src/workspace/workspace';
import { makeWorkspace } from '../helpers';

describe('inspectWorkspace', () => {
  test('packages native Claude Code files and excludes secrets and local settings', () => {
    const dir = makeWorkspace({
      'CLAUDE.md': '# Agent',
      '.claude/settings.json': '{"permissions":{"allow":["Read"]}}',
      '.claude/settings.local.json': '{}',
      '.claude/agents/reviewer.md': 'reviewer',
      '.claude/skills/review/SKILL.md': 'skill',
      '.env': 'SECRET=1',
      'keys/server.pem': 'pem',
      'node_modules/pkg/index.js': '',
      '.git/HEAD': 'ref',
    });
    const result = inspectWorkspace(dir);
    expect(result.files.map((f) => f.relativePath)).toEqual([
      '.claude/agents/reviewer.md',
      '.claude/settings.json',
      '.claude/skills/review/SKILL.md',
      'CLAUDE.md',
    ]);
    expect(result.excluded).toEqual(
      expect.arrayContaining([
        '.env',
        '.git',
        'node_modules',
        'keys/server.pem',
        '.claude/settings.local.json',
      ]),
    );
    expect(result.warnings.join('\n')).toContain('settings.local.json');
  });

  test('fingerprint is stable and changes with content', () => {
    const dir = makeWorkspace({ 'CLAUDE.md': 'a' });
    const first = inspectWorkspace(dir).fingerprint;
    expect(inspectWorkspace(dir).fingerprint).toBe(first);
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'b');
    expect(inspectWorkspace(dir).fingerprint).not.toBe(first);
  });

  test('rejects missing paths, files and malformed JSON', () => {
    expect(() => inspectWorkspace('/definitely/not/here')).toThrow(/does not exist/);
    const dir = makeWorkspace({ 'CLAUDE.md': 'x' });
    expect(() => inspectWorkspace(path.join(dir, 'CLAUDE.md'))).toThrow(/must be a directory/);
    expect(() => inspectWorkspace(makeWorkspace({ '.claude/settings.json': '{nope' }))).toThrow(
      /not valid JSON/,
    );
    expect(() =>
      inspectWorkspace(makeWorkspace({ '.mcp.json': '{"mcpServers":{"c3-gateway":{}}}' })),
    ).toThrow(/reserved/);
  });

  test('warns about unsupported features without failing', () => {
    const dir = makeWorkspace({
      '.claude/settings.json': JSON.stringify({
        hooks: {},
        enabledPlugins: {},
        env: { GITHUB_TOKEN: 'x' },
      }),
      '.mcp.json': JSON.stringify({ mcpServers: { local: { command: 'docker', args: [] } } }),
    });
    const warnings = inspectWorkspace(dir).warnings.join('\n');
    expect(warnings).toContain('Hooks');
    expect(warnings).toContain('Plugins');
    expect(warnings).toContain('GITHUB_TOKEN');
    expect(warnings).toContain('"docker"');
  });

  test('never modifies the source workspace', () => {
    const dir = makeWorkspace({ 'CLAUDE.md': 'x', '.claude/settings.json': '{}' });
    const before = fs.readdirSync(dir, { recursive: true }).sort();
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-copy-'));
    copyWorkspace(inspectWorkspace(dir), out);
    expect(fs.readdirSync(dir, { recursive: true }).sort()).toEqual(before);
    expect(fs.readFileSync(path.join(out, 'CLAUDE.md'), 'utf8')).toBe('x');
  });
});

test('isExcluded matches names, segments and paths', () => {
  expect(isExcluded('a/node_modules/b.js', ['node_modules'])).toBe(true);
  expect(isExcluded('.env.production', ['.env.*'])).toBe(true);
  expect(isExcluded('.claude/settings.local.json', ['.claude/settings.local.json'])).toBe(true);
  expect(isExcluded('docs/settings.local.json', ['.claude/settings.local.json'])).toBe(false);
  expect(isExcluded('src/app.ts', ['*.pem'])).toBe(false);
});
