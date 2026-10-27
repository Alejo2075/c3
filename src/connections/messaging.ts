import * as iam from 'aws-cdk-lib/aws-iam';
import type * as events from 'aws-cdk-lib/aws-events';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { C3ValidationError } from '../errors';
import { toTargetName, type AgentToolGateway } from '../gateway/agent-gateway';
import { ToolAdapterFunction, connectAdapter } from './adapter';
import type { ConnectionOptions, ToolConnection } from './types';

/** A `send_message` tool for one SQS queue. Connecting is the opt-in to writes. */
export interface SqsToolOptions extends ConnectionOptions {
  /** Largest message body in bytes. @default 64 KiB */
  readonly maxBodyBytes?: number;
}

export function connectSqs(
  scope: Construct,
  gateway: AgentToolGateway,
  queue: sqs.IQueue,
  options: SqsToolOptions,
): ToolConnection {
  const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;
  if (maxBodyBytes < 1 || maxBodyBytes > 256 * 1024) {
    throw new C3ValidationError(
      `SQS connection "${options.name}": maxBodyBytes must be between 1 and 262144.`,
    );
  }
  const targetName = toTargetName(options.name);
  gateway.reserveTargetName(targetName);
  const adapter = new ToolAdapterFunction(scope, `${targetName}Adapter`, {
    kind: 'sqs',
    config: { queueUrl: queue.queueUrl, fifo: queue.fifo, maxBodyBytes },
  }).function;
  queue.grantSendMessages(adapter);

  return connectAdapter(
    gateway,
    targetName,
    adapter,
    [
      {
        name: 'send_message',
        description: `Send a message to the SQS queue (body up to ${maxBodyBytes} bytes).`,
        inputSchema: {
          type: 'object',
          properties: {
            body: { type: 'string', description: 'Message body.' },
            ...(queue.fifo
              ? { messageGroupId: { type: 'string', description: 'FIFO message group ID.' } }
              : {}),
          },
          required: queue.fifo ? ['body', 'messageGroupId'] : ['body'],
        },
      },
    ],
    options.description,
  );
}

/** A `put_event` tool for one event bus, with a fixed source and allowed detail types. */
export interface EventBridgeToolOptions extends ConnectionOptions {
  /** Event `source` for every event the agent publishes, for example `my.app.agent`. */
  readonly source: string;
  /** Detail types the agent may publish. */
  readonly detailTypes: readonly string[];
  /** Largest `detail` JSON in bytes. @default 32 KiB */
  readonly maxDetailBytes?: number;
}

export function connectEventBridge(
  scope: Construct,
  gateway: AgentToolGateway,
  bus: events.IEventBus,
  options: EventBridgeToolOptions,
): ToolConnection {
  const label = `EventBridge connection "${options.name}"`;
  if (!options.source || options.source.startsWith('aws.')) {
    throw new C3ValidationError(`${label}: "source" is required and must not start with "aws.".`);
  }
  if (options.detailTypes.length === 0) {
    throw new C3ValidationError(`${label}: "detailTypes" must list at least one detail type.`);
  }
  const maxDetailBytes = options.maxDetailBytes ?? 32 * 1024;
  if (maxDetailBytes < 2 || maxDetailBytes > 256 * 1024) {
    throw new C3ValidationError(`${label}: maxDetailBytes must be between 2 and 262144.`);
  }
  const targetName = toTargetName(options.name);
  gateway.reserveTargetName(targetName);
  const adapter = new ToolAdapterFunction(scope, `${targetName}Adapter`, {
    kind: 'eventbridge',
    config: {
      eventBusName: bus.eventBusName,
      source: options.source,
      detailTypes: [...options.detailTypes],
      maxDetailBytes,
    },
  }).function;
  adapter.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['events:PutEvents'],
      resources: [bus.eventBusArn],
      conditions: {
        StringEquals: { 'events:source': options.source },
        'ForAllValues:StringEquals': { 'events:detail-type': [...options.detailTypes] },
      },
    }),
  );

  return connectAdapter(
    gateway,
    targetName,
    adapter,
    [
      {
        name: 'put_event',
        description: `Publish an event with source "${options.source}". Allowed detail types: ${options.detailTypes.join(', ')}.`,
        inputSchema: {
          type: 'object',
          properties: {
            detailType: { type: 'string', description: 'One of the allowed detail types.' },
            detail: { type: 'string', description: 'Event detail as a JSON object string.' },
          },
          required: ['detailType', 'detail'],
        },
      },
    ],
    options.description,
  );
}
