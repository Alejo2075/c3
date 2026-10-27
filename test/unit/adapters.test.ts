import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const send = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = send;
  },
  ListObjectsV2Command: class {
    constructor(public input: unknown) {}
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }));
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send }) },
  GetCommand: class {
    constructor(public input: unknown) {}
  },
  QueryCommand: class {
    constructor(public input: unknown) {}
  },
}));

function context(tool: string) {
  return { clientContext: { custom: { bedrockAgentCoreToolName: `target___${tool}` } } };
}

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe('S3 adapter', () => {
  async function load() {
    vi.stubEnv(
      'C3_ADAPTER_CONFIG',
      JSON.stringify({ bucket: 'docs', prefixes: ['documents/'], maxObjectBytes: 10, maxKeys: 5 }),
    );
    // @ts-expect-error - plain ESM module
    return import('../../runtime-assets/adapters/s3.mjs');
  }

  test('rejects keys outside the allowed prefixes before calling S3', async () => {
    const { handler } = await load();
    const result = await handler({ key: 'secrets/passwords.txt' }, context('get_object'));
    expect(result.error).toMatch(/outside the allowed prefixes/);
    expect(send).not.toHaveBeenCalled();
  });

  test('reads text with a byte range and reports truncation', async () => {
    const { handler } = await load();
    send.mockResolvedValue({
      ContentType: 'text/plain',
      ContentRange: 'bytes 0-9/42',
      Body: { transformToByteArray: async () => Buffer.from('0123456789') },
    });
    const result = await handler({ key: 'documents/a.txt' }, context('get_object'));
    expect(result).toMatchObject({
      key: 'documents/a.txt',
      text: '0123456789',
      size: 42,
      truncated: true,
      binary: false,
    });
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      Bucket: 'docs',
      Key: 'documents/a.txt',
      Range: 'bytes=0-9',
    });
  });

  test('lists the single allowed prefix by default and caps page size', async () => {
    const { handler } = await load();
    send.mockResolvedValue({ Contents: [{ Key: 'documents/a.txt', Size: 1 }], IsTruncated: false });
    const result = await handler({}, context('list_objects'));
    expect(result.objects).toEqual([{ key: 'documents/a.txt', size: 1, lastModified: undefined }]);
    expect(send.mock.calls[0]?.[0].input).toMatchObject({ Prefix: 'documents/', MaxKeys: 5 });
    expect((await handler({ maxKeys: 50 }, context('list_objects'))).error).toMatch(
      /between 1 and 5/,
    );
  });

  test('unknown tools and SDK failures do not leak details', async () => {
    const { handler } = await load();
    expect((await handler({}, context('delete_object'))).error).toMatch(/Unknown tool/);
    send.mockRejectedValue(Object.assign(new Error('internal detail'), { name: 'AccessDenied' }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await handler({ key: 'documents/x' }, context('get_object'))).toEqual({
      error: 'Access denied by IAM for this resource.',
    });
    spy.mockRestore();
  });
});

describe('DynamoDB adapter', () => {
  async function load() {
    vi.stubEnv(
      'C3_ADAPTER_CONFIG',
      JSON.stringify({
        tableName: 'orders',
        partitionKey: { name: 'pk', type: 'S' },
        sortKey: { name: 'sk', type: 'S' },
        indexes: {},
        partitionKeyPrefixes: ['TENANT#acme'],
        projection: ['pk', 'sk', 'total'],
        maxItems: 10,
      }),
    );
    // @ts-expect-error - plain ESM module
    return import('../../runtime-assets/adapters/dynamodb.mjs');
  }

  test('enforces partition key prefixes and projections', async () => {
    const { handler } = await load();
    expect(
      (await handler({ partitionKey: 'TENANT#other', sortKey: 'x' }, context('get_item'))).error,
    ).toMatch(/must start with/);
    send.mockResolvedValue({ Item: { pk: 'TENANT#acme', sk: 'o1', total: 3 } });
    const result = await handler(
      { partitionKey: 'TENANT#acme', sortKey: 'o1' },
      context('get_item'),
    );
    expect(result).toEqual({ found: true, item: { pk: 'TENANT#acme', sk: 'o1', total: 3 } });
    expect(send.mock.calls[0]?.[0].input).toMatchObject({ ProjectionExpression: '#p0, #p1, #p2' });
  });

  test('builds key conditions and rejects undeclared indexes', async () => {
    const { handler } = await load();
    send.mockResolvedValue({ Items: [], LastEvaluatedKey: { pk: 'a' } });
    const result = await handler(
      {
        partitionKey: 'TENANT#acme',
        sortKeyCondition: { operator: 'begins_with', value: 'ORDER#' },
      },
      context('query'),
    );
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :sk1)',
      Limit: 10,
    });
    expect(typeof result.nextToken).toBe('string');
    expect(
      (await handler({ partitionKey: 'TENANT#acme', indexName: 'secret' }, context('query'))).error,
    ).toMatch(/not allowed/);
  });
});
