#!/usr/bin/env node
import * as path from 'node:path';
import { App, CfnOutput, Stack } from 'aws-cdk-lib';
import { ClaudeCodeAgent, PermissionMode } from 'c3-aws';

const app = new App();
const stack = new Stack(app, 'C3HelloAgent');

const agent = new ClaudeCodeAgent(stack, 'Hello', {
  source: path.join(__dirname, '..', 'agents', 'hello'),
  model: 'sonnet',
  // Read-only tools plus the permissions in agents/hello/.claude/settings.json.
  permissionMode: PermissionMode.DONT_ASK,
  maxBudgetUsd: 1,
});

new CfnOutput(stack, 'AgentRuntimeArn', { value: agent.runtime.agentRuntimeArn });
