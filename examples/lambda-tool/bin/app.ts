#!/usr/bin/env node
import * as path from 'node:path';
import { App, CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { ClaudeCodeAgent } from 'c3-aws';

const app = new App();
const stack = new Stack(app, 'C3LambdaTool');

// An ordinary Lambda function you already own.
const notify = new lambda.Function(stack, 'Notify', {
  runtime: lambda.Runtime.NODEJS_22_X,
  architecture: lambda.Architecture.ARM_64,
  handler: 'index.handler',
  code: lambda.Code.fromAsset(path.join(__dirname, '..', 'functions', 'notify')),
  timeout: Duration.seconds(10),
});

const agent = new ClaudeCodeAgent(stack, 'Notifier', {
  source: path.join(__dirname, '..', 'agents', 'notifier'),
  model: 'sonnet',
  maxBudgetUsd: 1,
});

// Exposed to Claude Code as mcp__c3-gateway__send-notification___send_notification.
agent.connect(notify, {
  name: 'send_notification',
  description: 'Send a short notification to the on-call channel.',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Notification text, at most 280 characters.' },
      severity: { type: 'string', description: 'One of info, warning, critical.' },
    },
    required: ['message'],
  },
  outputSchema: {
    type: 'object',
    properties: { delivered: { type: 'boolean' }, id: { type: 'string' } },
  },
});

new CfnOutput(stack, 'AgentRuntimeArn', { value: agent.runtime.agentRuntimeArn });
new CfnOutput(stack, 'NotifyFunctionName', { value: notify.functionName });
