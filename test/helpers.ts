import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, Stack } from 'aws-cdk-lib';

/** Create a throwaway Claude Code workspace with the given files. */
export function makeWorkspace(
  files: Record<string, string> = { 'CLAUDE.md': '# Test agent\n' },
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-ws-'));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

export function makeStack(): Stack {
  const app = new App();
  return new Stack(app, 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } });
}

type Statement = {
  Action: string | string[];
  Resource: unknown;
  Condition?: unknown;
  Effect: string;
};

/** All IAM statements attached to policies whose roles match `roleLogicalIdPrefix`. */
export function statementsForRole(
  template: Record<string, unknown>,
  roleLogicalIdPrefix: string,
): Statement[] {
  const resources = (template.Resources ?? {}) as Record<
    string,
    { Type: string; Properties: Record<string, unknown> }
  >;
  const statements: Statement[] = [];
  for (const resource of Object.values(resources)) {
    if (resource.Type !== 'AWS::IAM::Policy') continue;
    const roles = (resource.Properties.Roles ?? []) as Array<{ Ref?: string }>;
    if (!roles.some((role) => role.Ref?.startsWith(roleLogicalIdPrefix))) continue;
    const doc = resource.Properties.PolicyDocument as { Statement: Statement[] };
    statements.push(...doc.Statement);
  }
  return statements;
}

export function actionsOf(statements: Statement[]): string[] {
  return statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
}
