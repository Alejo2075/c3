import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Stack } from 'aws-cdk-lib';
import { describe, expect, test } from 'vitest';
import { ClaudeCodeAgent } from 'c3-aws';
import { actionsOf, makeStack, makeWorkspace, statementsForRole } from '../helpers';

function setup(): { stack: Stack; agent: ClaudeCodeAgent; fn: lambda.Function } {
  const stack = makeStack();
  const agent = new ClaudeCodeAgent(stack, 'Agent', { source: makeWorkspace() });
  const fn = new lambda.Function(stack, 'Notify', {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({ ok: true });'),
  });
  return { stack, agent, fn };
}

const messageSchema = {
  type: 'object',
  properties: { message: { type: 'string', description: 'Text to send' } },
  required: ['message'],
} as const;

describe('connect(lambda)', () => {
  test('creates one IAM-authorized gateway, a Lambda target and wires the runtime to it', () => {
    const { stack, agent, fn } = setup();
    const connection = agent.connect(fn, {
      name: 'send_notification',
      description: 'Send a user notification',
      inputSchema: messageSchema,
    });
    expect(connection.targetName).toBe('send-notification');
    expect(connection.toolNames).toEqual([
      'mcp__c3-gateway__send-notification___send_notification',
    ]);

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::BedrockAgentCore::Gateway', 1);
    template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
      AuthorizerType: 'AWS_IAM',
      ProtocolType: 'MCP',
    });
    template.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', {
      Name: 'send-notification',
      CredentialProviderConfigurations: [{ CredentialProviderType: 'GATEWAY_IAM_ROLE' }],
      TargetConfiguration: {
        Mcp: {
          Lambda: {
            ToolSchema: {
              InlinePayload: [
                Match.objectLike({
                  Name: 'send_notification',
                  InputSchema: {
                    Type: 'object',
                    Properties: { message: { Type: 'string', Description: 'Text to send' } },
                    Required: ['message'],
                  },
                }),
              ],
            },
          },
        },
      },
    });
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      EnvironmentVariables: Match.objectLike({
        C3_GATEWAY_URL: {
          'Fn::GetAtt': [Match.stringLikeRegexp('AgentToolsGateway'), 'GatewayUrl'],
        },
      }),
    });

    const json = template.toJSON();
    const runtimeActions = actionsOf(statementsForRole(json, 'AgentRuntimeExecutionRole'));
    expect(runtimeActions).toContain('bedrock-agentcore:InvokeGateway');
    // The runtime calls tools through the gateway, never the function directly.
    expect(runtimeActions).not.toContain('lambda:InvokeFunction');
    const gatewayActions = actionsOf(statementsForRole(json, 'AgentToolsGatewayServiceRole'));
    expect(gatewayActions).toEqual(['lambda:InvokeFunction']);
  });

  test('supports several tools on one function and reuses the gateway', () => {
    const { stack, agent, fn } = setup();
    agent.connect(fn, {
      name: 'notify',
      tools: [
        { name: 'send', description: 'Send', inputSchema: messageSchema },
        { name: 'status', description: 'Status', inputSchema: { type: 'object', properties: {} } },
      ],
    });
    agent.connect(fn, { name: 'other', description: 'Other', inputSchema: messageSchema });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::BedrockAgentCore::Gateway', 1);
    template.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', 2);
  });

  test('validates names and schemas', () => {
    const { agent, fn } = setup();
    expect(() => agent.connect(fn, { name: 'x', description: 'd' })).toThrow(
      /explicit "inputSchema"/,
    );
    expect(() =>
      agent.connect(fn, { name: 'bad name', description: 'd', inputSchema: messageSchema }),
    ).toThrow(/target name/);
    expect(() =>
      agent.connect(fn, { name: '_x', description: 'd', inputSchema: messageSchema }),
    ).toThrow(/target name/);
    expect(() =>
      agent.connect(fn, {
        name: 'arr',
        description: 'd',
        inputSchema: { type: 'object', properties: { list: { type: 'array' } } },
      }),
    ).toThrow(/must define "items"/);
    expect(() =>
      agent.connect(fn, {
        name: 'req',
        description: 'd',
        inputSchema: { type: 'object', required: ['missing'] },
      }),
    ).toThrow(/requires "missing"/);
    expect(() =>
      agent.connect(fn, {
        name: 'dup',
        tools: [
          { name: 't', description: 'd', inputSchema: messageSchema },
          { name: 't', description: 'd', inputSchema: messageSchema },
        ],
      }),
    ).toThrow(/more than once/);
    agent.connect(fn, { name: 'once', description: 'd', inputSchema: messageSchema });
    expect(() =>
      agent.connect(fn, { name: 'once', description: 'd', inputSchema: messageSchema }),
    ).toThrow(/already used/);
  });

  test('warns about tool names that are too long for clients', () => {
    const { stack, agent, fn } = setup();
    agent.connect(fn, {
      name: 'a_rather_long_target_name',
      description: 'd',
      inputSchema: messageSchema,
    });
    Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp('characters long'));
  });
});

describe('connect(bucket)', () => {
  test('read-only adapter scoped to prefixes, including KMS decrypt', () => {
    const { stack, agent } = setup();
    const key = new kms.Key(stack, 'Key');
    const bucket = new s3.Bucket(stack, 'Docs', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
    });
    const connection = agent.connect(bucket, {
      name: 'docs',
      prefixes: ['documents/*', 'shared/'],
    });
    expect(connection.toolNames).toEqual([
      'mcp__c3-gateway__docs___list_objects',
      'mcp__c3-gateway__docs___get_object',
    ]);

    const json = Template.fromStack(stack).toJSON();
    const statements = statementsForRole(json, 'AgentdocsAdapterFunctionServiceRole');
    const actions = actionsOf(statements);
    expect(actions).toEqual(
      expect.arrayContaining(['s3:ListBucket', 's3:GetObject', 'kms:Decrypt']),
    );
    expect(actions.some((a) => a.startsWith('s3:Put') || a.startsWith('s3:Delete'))).toBe(false);
    const list = statements.find((s) => actionsOf([s]).includes('s3:ListBucket'));
    expect(list?.Condition).toEqual({ StringLike: { 's3:prefix': ['documents/*', 'shared/*'] } });
    const get = statements.find((s) => actionsOf([s]).includes('s3:GetObject'));
    expect(JSON.stringify(get?.Resource)).toContain('/documents/*');
    expect(JSON.stringify(get?.Resource)).toContain('/shared/*');
    // The agent runtime itself gets no S3 access from connect().
    expect(
      actionsOf(statementsForRole(json, 'AgentRuntimeExecutionRole')).some((a) =>
        a.startsWith('s3:'),
      ),
    ).toBe(false);
  });

  test('requires explicit prefixes', () => {
    const { stack, agent } = setup();
    const bucket = new s3.Bucket(stack, 'Docs');
    expect(() => agent.connect(bucket, { name: 'docs', prefixes: [] })).toThrow(
      /at least one prefix/,
    );
    expect(() => agent.connect(bucket, { name: 'docs2', prefixes: ['a/*/b'] })).toThrow(
      /single trailing/,
    );
  });

  test("['*'] grants the whole bucket explicitly", () => {
    const { stack, agent } = setup();
    agent.connect(new s3.Bucket(stack, 'Docs'), { name: 'all', prefixes: ['*'] });
    const statements = statementsForRole(
      Template.fromStack(stack).toJSON(),
      'AgentallAdapterFunctionServiceRole',
    );
    expect(
      statements.find((s) => actionsOf([s]).includes('s3:ListBucket'))?.Condition,
    ).toBeUndefined();
  });
});

describe('connect(table)', () => {
  test('GetItem/Query only, with leading-key and attribute conditions', () => {
    const { stack, agent } = setup();
    const table = new dynamodb.Table(stack, 'Orders', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    });
    agent.connect(table, {
      name: 'orders',
      partitionKeyPrefixes: ['TENANT#acme'],
      attributes: ['total'],
    });
    const statements = statementsForRole(
      Template.fromStack(stack).toJSON(),
      'AgentordersAdapterFunctionServiceRole',
    );
    expect([...new Set(actionsOf(statements))].sort()).toEqual([
      'dynamodb:GetItem',
      'dynamodb:Query',
    ]);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.Condition).toMatchObject({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['TENANT#acme*'] },
      'ForAllValues:StringEquals': {
        'dynamodb:Attributes': expect.arrayContaining(['pk', 'sk', 'total']),
      },
    });
  });

  test('declared indexes get Query on the index ARN only', () => {
    const { stack, agent } = setup();
    const table = new dynamodb.Table(stack, 'Orders', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    });
    table.addGlobalSecondaryIndex({
      indexName: 'byStatus',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
    });
    agent.connect(table, { name: 'orders', indexes: ['byStatus'] });
    const statements = statementsForRole(
      Template.fromStack(stack).toJSON(),
      'AgentordersAdapterFunctionServiceRole',
    );
    const indexStatement = statements.find((s) => !actionsOf([s]).includes('dynamodb:GetItem'));
    expect(actionsOf(indexStatement ? [indexStatement] : [])).toEqual(['dynamodb:Query']);
    expect(JSON.stringify(indexStatement?.Resource)).toContain('/index/byStatus');
  });

  test('indexes cannot bypass partition key prefixes', () => {
    const { stack, agent } = setup();
    const table = new dynamodb.Table(stack, 'Orders', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    });
    table.addGlobalSecondaryIndex({
      indexName: 'byStatus',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
    });
    expect(() =>
      agent.connect(table, { name: 'orders', indexes: ['byStatus'], partitionKeyPrefixes: ['T#'] }),
    ).toThrow(/cannot be combined/);
  });

  test('imported tables need an explicit key schema', () => {
    const { stack, agent } = setup();
    const table = dynamodb.Table.fromTableName(stack, 'Imported', 'orders');
    expect(() => agent.connect(table, { name: 'orders' })).toThrow(/keySchema/);
    const connection = agent.connect(table, {
      name: 'orders2',
      keySchema: { partitionKey: { name: 'id', type: 'S' } },
    });
    expect(connection.toolNames).toHaveLength(2);
  });
});

describe('connect(queue / event bus)', () => {
  test('SQS send is limited to the queue', () => {
    const { stack, agent } = setup();
    agent.connect(new sqs.Queue(stack, 'Jobs'), { name: 'jobs' });
    const actions = actionsOf(
      statementsForRole(Template.fromStack(stack).toJSON(), 'AgentjobsAdapterFunctionServiceRole'),
    );
    expect(
      actions.every(
        (a) =>
          a.startsWith('sqs:Send') || a === 'sqs:GetQueueAttributes' || a === 'sqs:GetQueueUrl',
      ),
    ).toBe(true);
  });

  test('EventBridge put is conditioned on source and detail types', () => {
    const { stack, agent } = setup();
    agent.connect(new events.EventBus(stack, 'Bus'), {
      name: 'events',
      source: 'my.agent',
      detailTypes: ['ReviewDone'],
    });
    const statements = statementsForRole(
      Template.fromStack(stack).toJSON(),
      'AgenteventsAdapterFunctionServiceRole',
    );
    expect(statements[0]?.Condition).toEqual({
      StringEquals: { 'events:source': 'my.agent' },
      'ForAllValues:StringEquals': { 'events:detail-type': ['ReviewDone'] },
    });
    expect(() =>
      agent.connect(new events.EventBus(stack, 'Bus2'), {
        name: 'e2',
        source: 'aws.s3',
        detailTypes: ['x'],
      }),
    ).toThrow(/must not start with "aws."/);
  });
});
