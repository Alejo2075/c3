import { describe, expect, test } from 'vitest';
import { toToolDefinition } from '../../src/gateway/tool-schema';

describe('toToolDefinition', () => {
  test('converts nested schemas', () => {
    const def = toToolDefinition({
      name: 'create_ticket',
      description: 'Create a ticket',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } },
          meta: {
            type: 'object',
            properties: { priority: { type: 'integer' } },
            required: ['priority'],
          },
        },
        required: ['title'],
      },
    });
    expect(def.inputSchema.properties?.labels?.items?.type.value).toBe('string');
    expect(def.inputSchema.properties?.meta?.required).toEqual(['priority']);
  });

  test('rejects invalid definitions', () => {
    const input = { type: 'object' } as const;
    expect(() => toToolDefinition({ name: '1bad', description: 'd', inputSchema: input })).toThrow(
      /Tool name/,
    );
    expect(() => toToolDefinition({ name: 'a___b', description: 'd', inputSchema: input })).toThrow(
      /Tool name/,
    );
    expect(() => toToolDefinition({ name: 'ok', description: ' ', inputSchema: input })).toThrow(
      /description/,
    );
    expect(() =>
      toToolDefinition({
        name: 'ok',
        description: 'd',
        inputSchema: { type: 'string' } as unknown as typeof input,
      }),
    ).toThrow(/must have type "object"/);
    expect(() =>
      toToolDefinition({
        name: 'ok',
        description: 'd',
        inputSchema: { type: 'object', properties: { x: { type: 'date' as never } } },
      }),
    ).toThrow(/unsupported type/);
  });
});
