import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { describe, expect, test } from 'vitest';
import { ClaudeCodeAgent } from 'c3-aws';
import { actionsOf, makeStack, makeWorkspace, statementsForRole } from '../helpers';

describe('grant()', () => {
  test('scopes S3 object actions to prefixes and ListBucket with a condition, without creating tools', () => {
    const stack = makeStack();
    const agent = new ClaudeCodeAgent(stack, 'Agent', { source: makeWorkspace() });
    const bucket = new s3.Bucket(stack, 'Documents');
    agent.grant(bucket, { actions: ['s3:ListBucket', 's3:GetObject'], prefixes: ['documents/*'] });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::BedrockAgentCore::Gateway', 0);
    const statements = statementsForRole(template.toJSON(), 'AgentRuntimeExecutionRole');
    const list = statements.find((s) => actionsOf([s]).includes('s3:ListBucket'));
    expect(list?.Condition).toEqual({ StringLike: { 's3:prefix': ['documents/*'] } });
    const get = statements.find((s) => actionsOf([s]).includes('s3:GetObject'));
    expect(JSON.stringify(get?.Resource)).toContain('/documents/*');
    expect(actionsOf(statements)).not.toContain('s3:PutObject');
  });

  test('rejects wildcards, wrong services and missing prefixes', () => {
    const stack = makeStack();
    const agent = new ClaudeCodeAgent(stack, 'Agent', { source: makeWorkspace() });
    const bucket = new s3.Bucket(stack, 'B');
    expect(() => agent.grant(bucket, { actions: ['s3:*'], prefixes: ['*'] })).toThrow(/wildcard/);
    expect(() => agent.grant(bucket, { actions: ['dynamodb:GetItem'], prefixes: ['*'] })).toThrow(
      /does not belong/,
    );
    expect(() => agent.grant(bucket, { actions: ['s3:GetObject'] })).toThrow(
      /"prefixes" is required/,
    );
    expect(() => agent.grant(bucket, { actions: [], prefixes: ['*'] })).toThrow(/at least one/);
  });

  test('table, function and queue grants are resource scoped', () => {
    const stack = makeStack();
    const agent = new ClaudeCodeAgent(stack, 'Agent', { source: makeWorkspace() });
    const table = new dynamodb.Table(stack, 'T', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    });
    const fn = new lambda.Function(stack, 'F', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler=async()=>1'),
    });
    const queue = new sqs.Queue(stack, 'Q');
    agent.grant(table, { actions: ['dynamodb:GetItem', 'dynamodb:Query'], indexes: ['gsi1'] });
    agent.grant(fn, { actions: ['lambda:InvokeFunction'] });
    agent.grant(queue, { actions: ['sqs:SendMessage'] });

    const statements = statementsForRole(
      Template.fromStack(stack).toJSON(),
      'AgentRuntimeExecutionRole',
    );
    const resources = JSON.stringify(
      statements.filter(
        (s) =>
          !actionsOf([s]).some(
            (a) =>
              a.startsWith('bedrock') ||
              a.startsWith('logs') ||
              a.startsWith('xray') ||
              a.startsWith('cloudwatch') ||
              a.startsWith('bedrock-agentcore') ||
              a.startsWith('ecr:'),
          ),
      ),
    );
    expect(resources).not.toContain('"Resource":"*"');
    expect(resources).toContain('/index/gsi1');
  });
});
