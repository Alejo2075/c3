import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { C3ValidationError } from '../errors';
import { toTargetName, type AgentToolGateway } from '../gateway/agent-gateway';
import type { JsonSchemaType, ToolSpec } from '../gateway/tool-schema';
import { ToolAdapterFunction, connectAdapter } from './adapter';
import type { ConnectionOptions, ToolConnection } from './types';

export interface KeyAttribute {
  readonly name: string;
  /** `S` (string) or `N` (number). Binary keys are not supported. */
  readonly type: 'S' | 'N';
}

export interface KeySchema {
  readonly partitionKey: KeyAttribute;
  readonly sortKey?: KeyAttribute;
}

/** Narrow DynamoDB tools: `get_item` and `query`. Read-only. */
export interface DynamoDbToolOptions extends ConnectionOptions {
  /**
   * Table key schema. Read from the table when it is a `Table` defined in this
   * app; required for imported tables.
   */
  readonly keySchema?: KeySchema;
  /**
   * Indexes `query` may use. For imported tables, give each index's key
   * schema. @default - no indexes
   */
  readonly indexes?: readonly string[] | Record<string, KeySchema>;
  /**
   * Restrict reads to string partition keys that start with one of these
   * prefixes (enforced by IAM `dynamodb:LeadingKeys`), for example
   * `['TENANT#acme']`. Cannot be combined with `indexes`.
   * @default - any partition key
   */
  readonly partitionKeyPrefixes?: readonly string[];
  /**
   * Only return these attributes (enforced by IAM `dynamodb:Attributes`). Key
   * attributes are added automatically.
   * @default - all attributes
   */
  readonly attributes?: readonly string[];
  /** Largest page `query` returns. @default 25 */
  readonly maxItems?: number;
}

function fromCdkAttribute(
  attribute: dynamodb.Attribute | undefined,
  label: string,
): KeyAttribute | undefined {
  if (!attribute) return undefined;
  if (attribute.type === dynamodb.AttributeType.BINARY) {
    throw new C3ValidationError(`${label}: binary key "${attribute.name}" is not supported.`);
  }
  return {
    name: attribute.name,
    type: attribute.type === dynamodb.AttributeType.NUMBER ? 'N' : 'S',
  };
}

function schemaOf(
  table: dynamodb.ITable,
  label: string,
  indexName?: string,
): KeySchema | undefined {
  if (!(table instanceof dynamodb.Table)) return undefined;
  const schema = table.schemaV2(indexName);
  if (schema.partitionKeys.length > 1 || schema.sortKeys.length > 1) {
    throw new C3ValidationError(
      `${label}: multi-attribute keys${indexName ? ` on index "${indexName}"` : ''} are not supported.`,
    );
  }
  const partitionKey = fromCdkAttribute(schema.partitionKeys[0], label);
  if (!partitionKey) return undefined;
  return { partitionKey, sortKey: fromCdkAttribute(schema.sortKeys[0], label) };
}

export function connectDynamoDb(
  scope: Construct,
  gateway: AgentToolGateway,
  table: dynamodb.ITable,
  options: DynamoDbToolOptions,
): ToolConnection {
  const label = `DynamoDB connection "${options.name}"`;
  const keySchema = options.keySchema ?? schemaOf(table, label);
  if (!keySchema) {
    throw new C3ValidationError(`${label}: "keySchema" is required for imported tables.`);
  }
  const indexes: Record<string, KeySchema> = {};
  if (Array.isArray(options.indexes)) {
    for (const indexName of options.indexes as readonly string[]) {
      const schema = schemaOf(table, label, indexName);
      if (!schema) {
        throw new C3ValidationError(
          `${label}: pass the key schema of index "${indexName}" for imported tables.`,
        );
      }
      indexes[indexName] = schema;
    }
  } else if (options.indexes) {
    Object.assign(indexes, options.indexes);
  }
  const prefixes = options.partitionKeyPrefixes ? [...options.partitionKeyPrefixes] : undefined;
  if (prefixes && (prefixes.length === 0 || keySchema.partitionKey.type !== 'S')) {
    throw new C3ValidationError(
      `${label}: partitionKeyPrefixes needs a string partition key and at least one prefix.`,
    );
  }
  if (prefixes && Object.keys(indexes).length > 0) {
    // dynamodb:LeadingKeys constrains the base table key only; an index query
    // would bypass the tenant restriction.
    throw new C3ValidationError(
      `${label}: "indexes" cannot be combined with "partitionKeyPrefixes" because IAM leading-key conditions do not restrict index queries.`,
    );
  }
  const maxItems = options.maxItems ?? 25;
  if (maxItems < 1 || maxItems > 100) {
    throw new C3ValidationError(`${label}: maxItems must be between 1 and 100.`);
  }

  const keyNames = new Set<string>();
  for (const schema of [keySchema, ...Object.values(indexes)]) {
    keyNames.add(schema.partitionKey.name);
    if (schema.sortKey) keyNames.add(schema.sortKey.name);
  }
  const projection = options.attributes
    ? [...new Set([...keyNames, ...options.attributes])]
    : undefined;

  const targetName = toTargetName(options.name);
  gateway.reserveTargetName(targetName);
  const adapter = new ToolAdapterFunction(scope, `${targetName}Adapter`, {
    kind: 'dynamodb',
    config: {
      tableName: table.tableName,
      partitionKey: keySchema.partitionKey,
      sortKey: keySchema.sortKey,
      indexes,
      partitionKeyPrefixes: prefixes,
      projection,
      maxItems,
    },
  }).function;
  for (const statement of dynamoDbReadStatements(
    table,
    Object.keys(indexes),
    prefixes,
    projection,
  )) {
    adapter.addToRolePolicy(statement);
  }
  table.encryptionKey?.grantDecrypt(adapter);

  return connectAdapter(
    gateway,
    targetName,
    adapter,
    dynamoDbTools(keySchema, indexes, prefixes, maxItems),
    options.description,
  );
}

/** GetItem/Query statements scoped to the table, declared indexes and conditions. */
export function dynamoDbReadStatements(
  table: dynamodb.ITable,
  indexNames: readonly string[],
  partitionKeyPrefixes?: readonly string[],
  projection?: readonly string[],
): iam.PolicyStatement[] {
  const conditions: Record<string, Record<string, unknown>> = {};
  if (projection) {
    conditions['ForAllValues:StringEquals'] = { 'dynamodb:Attributes': [...projection] };
    conditions.StringEqualsIfExists = { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' };
  }
  const tableConditions = { ...conditions };
  if (partitionKeyPrefixes) {
    tableConditions['ForAllValues:StringLike'] = {
      'dynamodb:LeadingKeys': partitionKeyPrefixes.map((p) => `${p}*`),
    };
  }
  const statements = [
    new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:Query'],
      resources: [table.tableArn],
      conditions: Object.keys(tableConditions).length > 0 ? tableConditions : undefined,
    }),
  ];
  if (indexNames.length > 0) {
    statements.push(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: indexNames.map((name) => `${table.tableArn}/index/${name}`),
        conditions: Object.keys(conditions).length > 0 ? conditions : undefined,
      }),
    );
  }
  return statements;
}

function keyType(attribute: KeyAttribute): JsonSchemaType {
  return attribute.type === 'N' ? 'number' : 'string';
}

function dynamoDbTools(
  keySchema: KeySchema,
  indexes: Record<string, KeySchema>,
  prefixes: readonly string[] | undefined,
  maxItems: number,
): ToolSpec[] {
  const prefixNote = prefixes ? ` Partition keys must start with ${prefixes.join(' or ')}.` : '';
  const indexNote =
    Object.keys(indexes).length > 0 ? ` Allowed indexes: ${Object.keys(indexes).join(', ')}.` : '';
  const getItemRequired = keySchema.sortKey ? ['partitionKey', 'sortKey'] : ['partitionKey'];
  return [
    {
      name: 'get_item',
      description: `Get one item by its key (${keySchema.partitionKey.name}${keySchema.sortKey ? `, ${keySchema.sortKey.name}` : ''}).${prefixNote}`,
      inputSchema: {
        type: 'object',
        properties: {
          partitionKey: {
            type: keyType(keySchema.partitionKey),
            description: `Value of ${keySchema.partitionKey.name}.`,
          },
          ...(keySchema.sortKey
            ? {
                sortKey: {
                  type: keyType(keySchema.sortKey),
                  description: `Value of ${keySchema.sortKey.name}.`,
                },
              }
            : {}),
        },
        required: getItemRequired,
      },
    },
    {
      name: 'query',
      description: `Query items by partition key, optionally with a sort key condition.${prefixNote}${indexNote} Returns at most ${maxItems} items per page.`,
      inputSchema: {
        type: 'object',
        properties: {
          partitionKey: {
            type: 'string',
            description: 'Partition key value (numbers are passed as strings).',
          },
          sortKeyCondition: {
            type: 'object',
            description: 'Optional sort key condition.',
            properties: {
              operator: {
                type: 'string',
                description: 'One of =, <, <=, >, >=, begins_with, between.',
              },
              value: { type: 'string', description: 'Sort key value.' },
              value2: { type: 'string', description: 'Upper bound for between.' },
            },
            required: ['operator', 'value'],
          },
          indexName: { type: 'string', description: 'Optional index name.' },
          limit: { type: 'integer', description: `Page size, at most ${maxItems}.` },
          descending: {
            type: 'boolean',
            description: 'Return items in descending sort key order.',
          },
          nextToken: { type: 'string', description: 'Token from a previous page.' },
        },
        required: ['partitionKey'],
      },
    },
  ];
}
