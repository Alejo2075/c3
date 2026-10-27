// Real AWS test: deploys examples/lambda-tool, invokes the agent so Claude Code
// calls the Lambda tool through AgentCore Gateway, then destroys the stack.
//
// Opt-in and billable (AgentCore Runtime, Gateway, Bedrock tokens, ECR, Lambda):
//   C3_INTEGRATION=1 AWS_PROFILE=<profile> AWS_REGION=us-east-1 npm run test:integration
// Requires Docker (ARM64 builds) and a bootstrapped CDK environment.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const enabled = process.env.C3_INTEGRATION === '1';
const root = join(__dirname, '..', '..');
const exampleDir = join(root, 'examples', 'lambda-tool');
const cdk = join(root, 'node_modules', 'aws-cdk', 'bin', 'cdk');
const stackName = 'C3LambdaTool';

function runCdk(args: string[]): void {
  execFileSync(process.execPath, [cdk, ...args], {
    cwd: exampleDir,
    stdio: 'inherit',
    env: process.env,
  });
}

describe.skipIf(!enabled)('lambda-tool example on AWS', () => {
  let runtimeArn = '';

  beforeAll(() => {
    const outputs = join(mkdtempSync(join(tmpdir(), 'c3-it-')), 'outputs.json');
    runCdk(['deploy', stackName, '--require-approval', 'never', '--outputs-file', outputs]);
    const parsed = JSON.parse(readFileSync(outputs, 'utf8')) as Record<
      string,
      Record<string, string>
    >;
    runtimeArn = parsed[stackName]?.AgentRuntimeArn ?? '';
  }, 45 * 60_000);

  afterAll(() => {
    if (process.env.C3_KEEP_STACK !== '1') runCdk(['destroy', stackName, '--force']);
  }, 30 * 60_000);

  test(
    'Claude Code answers and calls the Lambda tool through the gateway',
    async () => {
      expect(runtimeArn).toMatch(/^arn:aws[a-z-]*:bedrock-agentcore:/);
      const client = new BedrockAgentCoreClient({ region: runtimeArn.split(':')[3] });
      const response = await client.send(
        new InvokeAgentRuntimeCommand({
          agentRuntimeArn: runtimeArn,
          runtimeSessionId: `c3-it-${randomUUID()}`,
          contentType: 'application/json',
          accept: 'application/json',
          payload: Buffer.from(
            JSON.stringify({
              prompt:
                'Send an info notification saying "C3 integration test". Reply with only the notification ID.',
            }),
          ),
        }),
      );
      const body = JSON.parse(await response.response!.transformToString()) as {
        status: string;
        response: string;
        error?: string;
      };
      expect(body.error).toBeUndefined();
      expect(body.status).toBe('success');
      expect(body.response).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    },
    15 * 60_000,
  );
});
