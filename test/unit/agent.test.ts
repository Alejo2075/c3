import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { PlatformVersion } from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { ClaudeCodeAgent, PermissionMode } from 'c3-aws';
import { actionsOf, makeStack, makeWorkspace, statementsForRole } from '../helpers';

describe('ClaudeCodeAgent', () => {
  test('synthesizes an HTTP AgentCore runtime with safe defaults', () => {
    const stack = makeStack();
    const agent = new ClaudeCodeAgent(stack, 'Agent', { source: makeWorkspace() });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::BedrockAgentCore::Runtime', 1);
    template.resourceCountIs('AWS::BedrockAgentCore::Gateway', 0);
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      ProtocolConfiguration: 'HTTP',
      NetworkConfiguration: { NetworkMode: 'PUBLIC' },
      EnvironmentVariables: {
        ANTHROPIC_MODEL: 'sonnet',
        C3_PERMISSION_MODE: 'dontAsk',
        C3_GATEWAY_URL: 'none',
        C3_AWS_REGION: 'us-east-1',
        C3_INVOCATION_TIMEOUT_SECONDS: '900',
      },
    });
    expect(agent.role).toBe(agent.runtime.role);
    expect(agent.grantPrincipal).toBe(agent.runtime.grantPrincipal);
  });

  test('stages a deterministic ARM64 Docker build context', () => {
    const ws = makeWorkspace({ 'CLAUDE.md': '# hi', '.env': 'NOPE=1' });
    const a = new ClaudeCodeAgent(makeStack(), 'Agent', { source: ws });
    const b = new ClaudeCodeAgent(makeStack(), 'Agent', { source: ws });
    expect(a.buildContextDir).toBe(b.buildContextDir);
    const dir = a.buildContextDir!;
    expect(fs.existsSync(path.join(dir, 'Dockerfile'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'entrypoint', 'server.mjs'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'workspace', 'CLAUDE.md'), 'utf8')).toBe('# hi');
    expect(fs.existsSync(path.join(dir, 'workspace', '.env'))).toBe(false);
  });

  test('runtime role only gets model access plus AgentCore defaults; no wildcard actions', () => {
    const stack = makeStack();
    new ClaudeCodeAgent(stack, 'Agent', { source: makeWorkspace() });
    const statements = statementsForRole(
      Template.fromStack(stack).toJSON(),
      'AgentRuntimeExecutionRole',
    );
    const actions = actionsOf(statements);
    expect(actions).toEqual(
      expect.arrayContaining(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']),
    );
    expect(actions.some((a) => a === '*' || a.endsWith(':*'))).toBe(false);
    expect(
      actions.some(
        (a) => a.startsWith('s3:') || a.startsWith('dynamodb:') || a.startsWith('lambda:'),
      ),
    ).toBe(false);
    const invoke = statements.find((s) => actionsOf([s]).includes('bedrock:InvokeModel'));
    expect(JSON.stringify(invoke?.Resource)).toContain('anthropic.claude-*');
  });

  test('passes Claude Code options through environment variables', () => {
    const stack = makeStack();
    new ClaudeCodeAgent(stack, 'Agent', {
      source: makeWorkspace(),
      model: 'opus',
      permissionMode: PermissionMode.ACCEPT_EDITS,
      allowedTools: ['Read', 'Bash(git log:*)'],
      disallowedTools: ['WebFetch'],
      maxBudgetUsd: 2.5,
      invocationTimeout: Duration.minutes(30),
      environment: { LOG_LEVEL: 'debug' },
      platformVersion: PlatformVersion.V2,
    });
    Template.fromStack(stack).hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      PlatformVersion: 'V2',
      EnvironmentVariables: {
        ANTHROPIC_MODEL: 'opus',
        C3_PERMISSION_MODE: 'acceptEdits',
        C3_ALLOWED_TOOLS: 'Read,Bash(git log:*)',
        C3_DISALLOWED_TOOLS: 'WebFetch',
        C3_MAX_BUDGET_USD: '2.5',
        C3_INVOCATION_TIMEOUT_SECONDS: '1800',
        LOG_LEVEL: 'debug',
      },
    });
  });

  test('rejects secret-looking and reserved environment variables', () => {
    expect(
      () =>
        new ClaudeCodeAgent(makeStack(), 'A', {
          source: makeWorkspace(),
          environment: { GITHUB_TOKEN: 'x' },
        }),
    ).toThrow(/looks like a secret/);
    expect(
      () =>
        new ClaudeCodeAgent(makeStack(), 'A', {
          source: makeWorkspace(),
          environment: { C3_GATEWAY_URL: 'x' },
        }),
    ).toThrow(/managed by C3/);
    expect(
      () => new ClaudeCodeAgent(makeStack(), 'A', { source: makeWorkspace(), maxBudgetUsd: 0 }),
    ).toThrow(/positive/);
    expect(
      () =>
        new ClaudeCodeAgent(makeStack(), 'A', {
          source: makeWorkspace(),
          invocationTimeout: Duration.hours(9),
        }),
    ).toThrow(/invocationTimeout/);
  });

  test('surfaces workspace warnings as CDK annotations', () => {
    const stack = makeStack();
    new ClaudeCodeAgent(stack, 'Agent', {
      source: makeWorkspace({ 'README.md': 'no claude files' }),
    });
    Annotations.fromStack(stack).hasWarning(
      '/TestStack/Agent',
      Match.stringLikeRegexp('neither CLAUDE.md'),
    );
  });

  test('optional observability, endpoint and session storage', () => {
    const stack = makeStack();
    const bucket = new s3.Bucket(stack, 'Sessions');
    const agent = new ClaudeCodeAgent(stack, 'Agent', {
      source: makeWorkspace(),
      tracing: true,
      applicationLogs: { removalPolicy: RemovalPolicy.DESTROY },
      endpointName: 'live',
      sessionStorage: { bucket, prefix: 'sessions/' },
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::BedrockAgentCore::RuntimeEndpoint', 1);
    template.hasResource('AWS::Logs::LogGroup', { DeletionPolicy: 'Delete' });
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      EnvironmentVariables: Match.objectLike({
        C3_SESSION_PREFIX: 'sessions/',
        C3_SESSION_BUCKET: { Ref: Match.anyValue() },
      }),
    });
    const statements = statementsForRole(template.toJSON(), 'AgentRuntimeExecutionRole');
    const s3Statement = statements.find((s) => actionsOf([s]).includes('s3:PutObject'));
    expect(JSON.stringify(s3Statement?.Resource)).toContain('/sessions/*');
    expect(agent.endpoint).toBeDefined();
    expect(agent.logGroup).toBeDefined();
  });

  test('grantInvoke lets a caller invoke the runtime', () => {
    const stack = makeStack();
    const agent = new ClaudeCodeAgent(stack, 'Agent', { source: makeWorkspace() });
    const caller = new iam.Role(stack, 'Caller', { assumedBy: new iam.AccountRootPrincipal() });
    agent.grantInvoke(caller);
    const actions = actionsOf(statementsForRole(Template.fromStack(stack).toJSON(), 'Caller'));
    expect(actions).toContain('bedrock-agentcore:InvokeAgentRuntime');
  });
});
