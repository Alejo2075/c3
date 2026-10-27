import { describe, expect, test } from 'vitest';
// @ts-expect-error - plain ESM module shipped inside the runtime image
import { isSafeArchiveListing } from '../../runtime-assets/entrypoint/sessions.mjs';

const allowed = ['workspace', 'home/node/.claude/projects'];

describe('session archive validation', () => {
  test('accepts members inside the workspace and session history', () => {
    expect(
      isSafeArchiveListing(
        'workspace/\nworkspace/CLAUDE.md\nhome/node/.claude/projects/-workspace/abc.jsonl\n',
        allowed,
      ),
    ).toBe(true);
  });

  test('rejects absolute paths, traversal and other trees', () => {
    expect(isSafeArchiveListing('/etc/passwd\n', allowed)).toBe(false);
    expect(isSafeArchiveListing('workspace/../etc/cron.d/x\n', allowed)).toBe(false);
    expect(isSafeArchiveListing('home/node/.bashrc\n', allowed)).toBe(false);
    expect(isSafeArchiveListing('workspace-evil/x\n', allowed)).toBe(false);
  });
});
