import * as iam from 'aws-cdk-lib/aws-iam';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as events from 'aws-cdk-lib/aws-events';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as sns from 'aws-cdk-lib/aws-sns';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import { C3ValidationError } from '../errors';
import { normalizePrefixes } from '../connections/s3';

/** Resources `ClaudeCodeAgent.grant()` understands. */
export type GrantableResource =
  s3.IBucket | dynamodb.ITable | lambda.IFunction | sqs.IQueue | sns.ITopic | events.IEventBus;

export interface GrantOptions {
  /**
   * Exact IAM actions, for example `['s3:GetObject']`. Wildcards are rejected
   * unless `allowWildcardActions` is set.
   */
  readonly actions: readonly string[];
  /**
   * S3 only: object key prefixes the actions apply to. Bucket-level actions
   * such as `s3:ListBucket` get an `s3:prefix` condition.
   * Required for buckets; use `['*']` for the whole bucket.
   */
  readonly prefixes?: readonly string[];
  /** DynamoDB only: index names that index-level actions may use. @default - none */
  readonly indexes?: readonly string[];
  /** Permit actions containing `*`. @default false */
  readonly allowWildcardActions?: boolean;
}

/** S3 actions that apply to the bucket ARN rather than object ARNs. */
const S3_BUCKET_LEVEL_ACTIONS = new Set([
  's3:ListBucket',
  's3:ListBucketVersions',
  's3:ListBucketMultipartUploads',
  's3:GetBucketLocation',
]);

const S3_PREFIX_CONDITION_ACTIONS = new Set(['s3:ListBucket', 's3:ListBucketVersions']);

const KMS_DECRYPT = ['kms:Decrypt', 'kms:DescribeKey'];
const KMS_ENCRYPT = ['kms:Encrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*'];

function has<K extends string>(value: object, key: K): value is Record<K, unknown> {
  return key in value;
}

function checkActions(
  actions: readonly string[],
  service: string | readonly string[],
  options: GrantOptions,
  label: string,
): void {
  if (actions.length === 0) {
    throw new C3ValidationError(`${label}: "actions" must list at least one IAM action.`);
  }
  const services = typeof service === 'string' ? [service] : service;
  for (const action of actions) {
    const [prefix] = action.split(':');
    if (!prefix || !services.includes(prefix)) {
      throw new C3ValidationError(
        `${label}: action "${action}" does not belong to ${services.join('/')}.`,
      );
    }
    if (action.includes('*') && !options.allowWildcardActions) {
      throw new C3ValidationError(
        `${label}: wildcard action "${action}" is not allowed. List exact actions or set allowWildcardActions.`,
      );
    }
  }
}

/**
 * Build least-privilege statements that let `grantee` call `actions` on
 * `resource`. Returns the statements that were added.
 */
export function grantResource(
  grantee: iam.IGrantable,
  resource: GrantableResource,
  options: GrantOptions,
): iam.PolicyStatement[] {
  const statements: iam.PolicyStatement[] = [];
  const add = (statement: iam.PolicyStatement) => {
    grantee.grantPrincipal.addToPrincipalPolicy(statement);
    statements.push(statement);
  };
  const actions = [...options.actions];

  if (has(resource, 'bucketArn')) {
    const bucket = resource as s3.IBucket;
    checkActions(actions, 's3', options, 'grant(bucket)');
    if (!options.prefixes) {
      throw new C3ValidationError(
        'grant(bucket): "prefixes" is required. Use [\'*\'] to grant on the whole bucket.',
      );
    }
    const prefixes = normalizePrefixes(options.prefixes, 'grant(bucket)');
    const wholeBucket = prefixes.includes('');
    const bucketActions = actions.filter((a) => S3_BUCKET_LEVEL_ACTIONS.has(a));
    const objectActions = actions.filter((a) => !S3_BUCKET_LEVEL_ACTIONS.has(a));
    const prefixed = bucketActions.filter((a) => S3_PREFIX_CONDITION_ACTIONS.has(a));
    const unprefixed = bucketActions.filter((a) => !S3_PREFIX_CONDITION_ACTIONS.has(a));
    if (prefixed.length > 0) {
      add(
        new iam.PolicyStatement({
          actions: prefixed,
          resources: [bucket.bucketArn],
          conditions: wholeBucket
            ? undefined
            : { StringLike: { 's3:prefix': prefixes.map((p) => `${p}*`) } },
        }),
      );
    }
    if (unprefixed.length > 0) {
      add(new iam.PolicyStatement({ actions: unprefixed, resources: [bucket.bucketArn] }));
    }
    if (objectActions.length > 0) {
      add(
        new iam.PolicyStatement({
          actions: objectActions,
          resources: prefixes.map((p) => bucket.arnForObjects(`${p}*`)),
        }),
      );
      if (bucket.encryptionKey) {
        const writes = objectActions.some((a) => a.startsWith('s3:Put'));
        bucket.encryptionKey.grant(grantee, ...KMS_DECRYPT, ...(writes ? KMS_ENCRYPT : []));
      }
    }
    return statements;
  }

  if (has(resource, 'tableArn')) {
    const table = resource as dynamodb.ITable;
    checkActions(actions, 'dynamodb', options, 'grant(table)');
    add(new iam.PolicyStatement({ actions, resources: [table.tableArn] }));
    if (options.indexes && options.indexes.length > 0) {
      add(
        new iam.PolicyStatement({
          actions,
          resources: options.indexes.map((name) => `${table.tableArn}/index/${name}`),
        }),
      );
    }
    if (table.encryptionKey) {
      const writes = actions.some((a) => /:(Put|Update|Delete|BatchWrite)/.test(a));
      table.encryptionKey.grant(grantee, ...KMS_DECRYPT, ...(writes ? KMS_ENCRYPT : []));
    }
    return statements;
  }

  if (has(resource, 'functionArn')) {
    const fn = resource as lambda.IFunction;
    checkActions(actions, 'lambda', options, 'grant(function)');
    add(new iam.PolicyStatement({ actions, resources: [fn.functionArn, `${fn.functionArn}:*`] }));
    return statements;
  }

  if (has(resource, 'queueArn')) {
    const queue = resource as sqs.IQueue;
    checkActions(actions, 'sqs', options, 'grant(queue)');
    add(new iam.PolicyStatement({ actions, resources: [queue.queueArn] }));
    if (queue.encryptionMasterKey) {
      const sends = actions.includes('sqs:SendMessage');
      queue.encryptionMasterKey.grant(grantee, ...KMS_DECRYPT, ...(sends ? KMS_ENCRYPT : []));
    }
    return statements;
  }

  if (has(resource, 'topicArn')) {
    const topic = resource as sns.ITopic;
    checkActions(actions, 'sns', options, 'grant(topic)');
    add(new iam.PolicyStatement({ actions, resources: [topic.topicArn] }));
    return statements;
  }

  if (has(resource, 'eventBusArn')) {
    const bus = resource as events.IEventBus;
    checkActions(actions, 'events', options, 'grant(eventBus)');
    add(new iam.PolicyStatement({ actions, resources: [bus.eventBusArn] }));
    return statements;
  }

  throw new C3ValidationError(
    "grant() supports S3 buckets, DynamoDB tables, Lambda functions, SQS queues, SNS topics and EventBridge buses. For other resources use the resource's own grant methods with the agent as grantee.",
  );
}
