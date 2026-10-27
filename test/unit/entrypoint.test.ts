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

  test('builds a noninteractive Claude Code command line', () => {
    const config = lib.readConfig({
      ANTHROPIC_MODEL: 'sonnet',
      C3_ALLOWED_TOOLS: 'Read,Bash(git log:*)',
      C3_MAX_BUDGET_USD: '1.5',
    });
    const args = lib.buildClaudeArgs(config, {
      prompt: 'hi',
      sessionId: 'abc',
      resume: false,
      mcpConfigPath: '/m.json',
    });
    expect(args.slice(0, 5)).toEqual(['-p', 'hi', '--output-format', 'stream-json', '--verbose']);
    expect(args).toEqual(
      expect.arrayContaining([
        '--permission-mode',
        'dontAsk',
        '--model',
        'sonnet',
        '--mcp-config',
        '/m.json',
      ]),
    );
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Bash(git log:*),mcp__c3-gateway');
    expect(args).toEqual(
      expect.arrayContaining(['--max-budget-usd', '1.5', '--session-id', 'abc']),
    );
    const resumed = lib.buildClaudeArgs(config, {
      prompt: 'again',
      sessionId: 'abc',
      resume: true,
    });
    expect(resumed).toEqual(expect.arrayContaining(['--resume', 'abc']));
    expect(resumed).not.toContain('--mcp-config');
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
    expect(lib.gatewayMcpConfig('https://gw.example/mcp', 'us-east-1')).toEqual({
      mcpServers: {
        'c3-gateway': {
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
  });

  test('summarizes stream-json output and splits lines', () => {
    const summary = lib.summarize([
      { type: 'system', subtype: 'init' },
      {
        type: 'result',
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
    expect(lib.splitLines('{"a"', ':1}\n{"b":2}\n{"c"')).toEqual({
      lines: ['{"a":1}', '{"b":2}'],
      rest: '{"c"',
    });
  });
});
