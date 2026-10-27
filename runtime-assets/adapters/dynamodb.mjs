// Narrow DynamoDB tools: GetItem and Query on one table and its declared
// indexes, optionally restricted to approved partition key prefixes and a
// fixed attribute projection. IAM enforces the same restrictions.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  ToolInputError,
  decodeToken,
  dispatch,
  encodeToken,
  loadConfig,
  optionalInteger,
} from './common.mjs';

const config = loadConfig();
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const OPERATORS = { '=': '=', '<': '<', '<=': '<=', '>': '>', '>=': '>=' };

export function keyValue(input, field, attribute, optional = false) {
  const value = input[field];
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new ToolInputError(`"${field}" is required.`);
  }
  if (attribute.type === 'N') {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) throw new ToolInputError(`"${field}" must be a number.`);
    return number;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new ToolInputError(`"${field}" must be a non-empty string.`);
  }
  return value;
}

export function checkPartitionPrefix(value, prefixes) {
  if (!prefixes || prefixes.length === 0) return;
  if (typeof value !== 'string' || !prefixes.some((prefix) => value.startsWith(prefix))) {
    throw new ToolInputError(`Partition key must start with one of: ${prefixes.join(', ')}`);
  }
}

function projection() {
  if (!config.projection) return {};
  const names = {};
  const parts = config.projection.map((attribute, index) => {
    names[`#p${index}`] = attribute;
    return `#p${index}`;
  });
  return { ProjectionExpression: parts.join(', '), ExpressionAttributeNames: names };
}

export const tools = {
  async get_item(input) {
    const pk = keyValue(input, 'partitionKey', config.partitionKey);
    checkPartitionPrefix(pk, config.partitionKeyPrefixes);
    const key = { [config.partitionKey.name]: pk };
    if (config.sortKey) key[config.sortKey.name] = keyValue(input, 'sortKey', config.sortKey);
    const result = await client.send(
      new GetCommand({ TableName: config.tableName, Key: key, ...projection() }),
    );
    return { found: result.Item !== undefined, item: result.Item };
  },

  async query(input) {
    const indexName = input.indexName ?? undefined;
    const schema = indexName === undefined ? config : config.indexes[indexName];
    if (!schema) {
      throw new ToolInputError(
        `Index "${indexName}" is not allowed. Allowed indexes: ${Object.keys(config.indexes).join(', ') || 'none'}`,
      );
    }
    const pk = keyValue(input, 'partitionKey', schema.partitionKey);
    if (indexName !== undefined && config.partitionKeyPrefixes?.length) {
      throw new ToolInputError(
        'Index queries are disabled when partition key prefixes are enforced.',
      );
    }
    checkPartitionPrefix(pk, config.partitionKeyPrefixes);

    const { ProjectionExpression, ExpressionAttributeNames = {} } = projection();
    const names = { ...ExpressionAttributeNames, '#pk': schema.partitionKey.name };
    const values = { ':pk': pk };
    let condition = '#pk = :pk';

    const sk = input.sortKeyCondition;
    if (sk !== undefined && sk !== null) {
      if (!schema.sortKey) throw new ToolInputError('This key schema has no sort key.');
      names['#sk'] = schema.sortKey.name;
      values[':sk1'] = keyValue(sk, 'value', schema.sortKey);
      if (sk.operator === 'begins_with') {
        condition += ' AND begins_with(#sk, :sk1)';
      } else if (sk.operator === 'between') {
        values[':sk2'] = keyValue(sk, 'value2', schema.sortKey);
        condition += ' AND #sk BETWEEN :sk1 AND :sk2';
      } else if (OPERATORS[sk.operator]) {
        condition += ` AND #sk ${OPERATORS[sk.operator]} :sk1`;
      } else {
        throw new ToolInputError(
          '"sortKeyCondition.operator" must be one of =, <, <=, >, >=, begins_with, between.',
        );
      }
    }

    const limit = optionalInteger(input, 'limit', {
      min: 1,
      max: config.maxItems,
      fallback: config.maxItems,
    });
    const result = await client.send(
      new QueryCommand({
        TableName: config.tableName,
        IndexName: indexName,
        KeyConditionExpression: condition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ProjectionExpression,
        Limit: limit,
        ExclusiveStartKey: decodeToken(input.nextToken),
        ScanIndexForward: input.descending !== true,
      }),
    );
    return { items: result.Items ?? [], nextToken: encodeToken(result.LastEvaluatedKey) };
  },
};

export const handler = (event, context) => dispatch(tools, event, context);
