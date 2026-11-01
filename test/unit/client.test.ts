import { Readable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { C3InvocationError, invokeAgent, invokeAgentStream, parseEvents } from '../../src/client';

const ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/agent-abc';

function fakeClient(body: string | string[], seen: unknown[] = []) {
  const chunks = Array.isArray(body) ? body : [body];
  return {
    seen,
    client: {
      send: async (command: { input: unknown }) => {
        seen.push(command.input);
        return { response: Readable.from(chunks.map((c) => Buffer.from(c))) };
      },
    } as never,
  };
}

describe('invokeAgent', () => {
  test('sends the prompt and returns the parsed result', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { client } = fakeClient(
      JSON.stringify({ status: 'success', response: 'hi', totalCostUsd: 0.01, numTurns: 1 }),
      seen,
    );
    const result = await invokeAgent({ agentRuntimeArn: ARN, prompt: 'hello', client });
    expect(result).toMatchObject({ status: 'success', response: 'hi', totalCostUsd: 0.01 });
    expect(result.sessionId.length).toBeGreaterThanOrEqual(33);
    const input = seen[0] as { runtimeSessionId: string; payload: Buffer; accept: string };
    expect(input.runtimeSessionId).toBe(result.sessionId);
    expect(input.accept).toBe('application/json');
    expect(JSON.parse(input.payload.toString())).toEqual({ prompt: 'hello', stream: false });
  });

  test('throws C3InvocationError with the partial result', async () => {
    const { client } = fakeClient(JSON.stringify({ status: 'error', error: 'budget' }));
    const error = await invokeAgent({ agentRuntimeArn: ARN, prompt: 'x', client }).catch((e) => e);
    expect(error).toBeInstanceOf(C3InvocationError);
    expect(error.message).toContain('budget');
    expect(error.result.status).toBe('error');
  });

  test('validates input before calling AWS', async () => {
    const { client } = fakeClient('{}');
    await expect(invokeAgent({ agentRuntimeArn: 'nope', prompt: 'x', client })).rejects.toThrow(
      /runtime ARN/,
    );
    await expect(invokeAgent({ agentRuntimeArn: ARN, prompt: ' ', client })).rejects.toThrow(
      /prompt/,
    );
    await expect(
      invokeAgent({ agentRuntimeArn: ARN, prompt: 'x', sessionId: 'short', client }),
    ).rejects.toThrow(/33 characters/);
  });
});

describe('invokeAgentStream', () => {
  test('yields events split across chunks', async () => {
    const { client } = fakeClient([
      'data: {"type":"assistant"}\n\ndata: {"ty',
      'pe":"c3.result","status":"success"}\n\n',
    ]);
    const types: string[] = [];
    for await (const event of invokeAgentStream({ agentRuntimeArn: ARN, prompt: 'x', client })) {
      types.push(event.type);
    }
    expect(types).toEqual(['assistant', 'c3.result']);
  });

  test('skips malformed frames', async () => {
    async function* chunks() {
      yield 'data: not-json\n\ndata: {"type":"ok"}\n';
    }
    const events = [];
    for await (const event of parseEvents(chunks())) events.push(event.type);
    expect(events).toEqual(['ok']);
  });
});
