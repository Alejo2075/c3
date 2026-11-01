import { describe, expect, test } from 'vitest';
// @ts-expect-error - plain ESM module shipped inside the runtime image
import * as lib from '../../runtime-assets/entrypoint/lib.mjs';

const base = lib.readConfig({});

describe('runtime entrypoint helpers', () => {
  test('reads safe defaults', () => {
    expect(base).toMatchObject({
      workspaceDir: '/workspace',
      permissionMode: 'dontAsk',
      gatewayUrl: undefined,
      timeoutSeconds: 900,
    });
    expect(lib.readConfig({ C3_GATEWAY_URL: 'none' }).gatewayUrl).toBeUndefined();
    expect(lib.readConfig({ C3_AWS_REGION: 'eu-west-1' }).region).toBe('eu-west-1');
    expect(() => lib.readConfig({ C3_PERMISSION_MODE: 'yolo' })).toThrow(/Unsupported/);
  });

  test('builds Agent SDK query options', () => {
    const config = lib.readConfig({
      ANTHROPIC_MODEL: 'sonnet',
      C3_ALLOWED_TOOLS: 'Read,Bash(git log:*)',
      C3_MAX_BUDGET_USD: '1.5',
      C3_GATEWAY_URL: 'https://gw.example/mcp',
      AWS_REGION: 'us-east-1',
    });
    const options = lib.buildQueryOptions(config, {
      sessionId: 'abc',
      resume: false,
      env: { A: '1' },
      stream: true,
    });
    expect(options).toMatchObject({
      cwd: '/workspace',
      env: { A: '1' },
      model: 'sonnet',
      permissionMode: 'dontAsk',
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      includePartialMessages: true,
      maxBudgetUsd: 1.5,
      sessionId: 'abc',
      allowedTools: ['Read', 'Bash(git log:*)', 'mcp__c3-gateway'],
      mcpServers: {
        'c3-gateway': {
          type: 'stdio',
          command: 'mcp-proxy-for-aws-cli',
          args: [
            'https://gw.example/mcp',
            '--service',
            'bedrock-agentcore',
            '--region',
            'us-east-1',
          ],
        },
      },
    });
    expect(options.resume).toBeUndefined();
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();

    const resumed = lib.buildQueryOptions(base, { sessionId: 'abc', resume: true, env: {} });
    expect(resumed.resume).toBe('abc');
    expect(resumed.sessionId).toBeUndefined();
    expect(resumed.mcpServers).toBeUndefined();
    expect(resumed.allowedTools).toBeUndefined();
  });

  test('maps permission modes to the SDK', () => {
    const bypass = lib.buildQueryOptions(
      lib.readConfig({ C3_PERMISSION_MODE: 'bypassPermissions' }),
      {
        env: {},
      },
    );
    expect(bypass.permissionMode).toBe('bypassPermissions');
    expect(bypass.allowDangerouslySkipPermissions).toBe(true);
    const manual = lib.buildQueryOptions(lib.readConfig({ C3_PERMISSION_MODE: 'manual' }), {
      env: {},
    });
    expect(manual.permissionMode).toBe('default');
  });

  test('derives a stable RFC 4122 UUID from AgentCore session IDs', () => {
    const id = lib.sessionUuid('session-1234567890-1234567890-1234567890');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(lib.sessionUuid('session-1234567890-1234567890-1234567890')).toBe(id);
    expect(lib.sessionUuid('other')).not.toBe(id);
  });

  test('validates invocation payloads', () => {
    expect(lib.parseInvocation({ prompt: 'Review this' })).toEqual({
      prompt: 'Review this',
      stream: false,
    });
    expect(lib.parseInvocation({ prompt: 'x', stream: true }).stream).toBe(true);
    expect(() => lib.parseInvocation({})).toThrow(/prompt/);
    expect(() => lib.parseInvocation([])).toThrow(/JSON object/);
    expect(() => lib.parseInvocation({ prompt: 'x'.repeat(lib.MAX_PROMPT_BYTES + 1) })).toThrow(
      /exceeds/,
    );
  });

  test('gateway MCP config uses the AWS SigV4 proxy', () => {
    expect(lib.gatewayMcpServers('https://gw.example/mcp', 'us-east-1')).toEqual({
      'c3-gateway': {
        type: 'stdio',
        command: 'mcp-proxy-for-aws-cli',
        args: ['https://gw.example/mcp', '--service', 'bedrock-agentcore', '--region', 'us-east-1'],
      },
    });
  });

  test('summarizes the Agent SDK result message', () => {
    const summary = lib.summarize([
      { type: 'system', subtype: 'init' },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Done',
        session_id: 's',
        num_turns: 2,
        total_cost_usd: 0.01,
      },
    ]);
    expect(summary).toMatchObject({
      status: 'success',
      response: 'Done',
      sessionId: 's',
      numTurns: 2,
    });
    expect(lib.summarize([]).status).toBe('error');
    const stopped = lib.summarize([
      { type: 'result', subtype: 'error_max_turns', is_error: false, session_id: 's' },
    ]);
    expect(stopped).toMatchObject({
      status: 'error',
      error: expect.stringContaining('error_max_turns'),
    });
  });
});
