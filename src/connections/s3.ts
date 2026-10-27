import { Token } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { C3ValidationError } from '../errors';
import { toTargetName, type AgentToolGateway } from '../gateway/agent-gateway';
import type { ToolSpec } from '../gateway/tool-schema';
import { ToolAdapterFunction, connectAdapter } from './adapter';
import type { ConnectionOptions, ToolConnection } from './types';

const DEFAULT_MAX_OBJECT_BYTES = 256 * 1024;
const MAX_OBJECT_BYTES = 4 * 1024 * 1024;

/** Read-only S3 tools: `list_objects` and `get_object`. */
export interface S3ToolOptions extends ConnectionOptions {
  /**
   * Key prefixes the agent may read, for example `['documents/']`.
   * A trailing `*` is accepted (`documents/*`). Use `['*']` to allow the whole
   * bucket explicitly.
   */
  readonly prefixes: readonly string[];
  /** Largest number of bytes `get_object` returns. @default 256 KiB */
  readonly maxObjectBytes?: number;
  /** Largest page `list_objects` returns. @default 100 */
  readonly maxKeys?: number;
}

/** Normalize user prefixes; `'*'` becomes the empty prefix (whole bucket). */
export function normalizePrefixes(prefixes: readonly string[], label: string): string[] {
  if (prefixes.length === 0) {
    throw new C3ValidationError(
      `${label}: "prefixes" must list at least one prefix. Use ['*'] to allow the whole bucket.`,
    );
  }
  return prefixes.map((prefix) => {
    if (Token.isUnresolved(prefix)) {
      throw new C3ValidationError(`${label}: prefixes must be literal strings.`);
    }
    const trimmed = prefix.endsWith('*') ? prefix.slice(0, -1) : prefix;
    if (trimmed.includes('*') || trimmed.includes('?')) {
      throw new C3ValidationError(
        `${label}: prefix "${prefix}" may only contain a single trailing "*".`,
      );
    }
    if (trimmed.startsWith('/')) {
      throw new C3ValidationError(
        `${label}: prefix "${prefix}" must not start with "/"; S3 keys have no leading slash.`,
      );
    }
    return trimmed;
  });
}

/**
 * Least-privilege read statements for a bucket: object reads limited to the
 * prefixes and ListBucket limited with an `s3:prefix` condition.
 */
export function s3ReadStatements(
  bucket: s3.IBucket,
  prefixes: readonly string[],
  actions = ['s3:GetObject'],
): iam.PolicyStatement[] {
  const wholeBucket = prefixes.includes('');
  return [
    new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [bucket.bucketArn],
      conditions: wholeBucket
        ? undefined
        : { StringLike: { 's3:prefix': prefixes.map((prefix) => `${prefix}*`) } },
    }),
    new iam.PolicyStatement({
      actions,
      resources: prefixes.map((prefix) => bucket.arnForObjects(`${prefix}*`)),
    }),
  ];
}

export function connectS3(
  scope: Construct,
  gateway: AgentToolGateway,
  bucket: s3.IBucket,
  options: S3ToolOptions,
): ToolConnection {
  const prefixes = normalizePrefixes(options.prefixes, `S3 connection "${options.name}"`);
  const maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
  if (maxObjectBytes < 1 || maxObjectBytes > MAX_OBJECT_BYTES) {
    throw new C3ValidationError(
      `S3 connection "${options.name}": maxObjectBytes must be between 1 and ${MAX_OBJECT_BYTES}.`,
    );
  }
  const maxKeys = options.maxKeys ?? 100;
  if (maxKeys < 1 || maxKeys > 1000) {
    throw new C3ValidationError(
      `S3 connection "${options.name}": maxKeys must be between 1 and 1000.`,
    );
  }
  const targetName = toTargetName(options.name);
  gateway.reserveTargetName(targetName);

  const adapter = new ToolAdapterFunction(scope, `${targetName}Adapter`, {
    kind: 's3',
    config: { bucket: bucket.bucketName, prefixes, maxObjectBytes, maxKeys },
  }).function;
  for (const statement of s3ReadStatements(bucket, prefixes)) {
    adapter.addToRolePolicy(statement);
  }
  bucket.encryptionKey?.grantDecrypt(adapter);

  const allowed = prefixes.map((prefix) => (prefix === '' ? '(entire bucket)' : prefix)).join(', ');
  const tools: ToolSpec[] = [
    {
      name: 'list_objects',
      description: `List objects in the S3 bucket under an allowed prefix (${allowed}).`,
      inputSchema: {
        type: 'object',
        properties: {
          prefix: {
            type: 'string',
            description: 'Key prefix to list. Must start with an allowed prefix.',
          },
          maxKeys: { type: 'integer', description: `Page size, at most ${maxKeys}.` },
          nextToken: { type: 'string', description: 'Token from a previous page.' },
        },
      },
    },
    {
      name: 'get_object',
      description: `Read an S3 object as text (first ${maxObjectBytes} bytes). Keys must start with an allowed prefix (${allowed}).`,
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Full object key.' },
          maxBytes: { type: 'integer', description: `Bytes to read, at most ${maxObjectBytes}.` },
        },
        required: ['key'],
      },
    },
  ];
  return connectAdapter(gateway, targetName, adapter, tools, options.description);
}
