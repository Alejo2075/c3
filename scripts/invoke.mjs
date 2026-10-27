#!/usr/bin/env node
// Invoke a deployed C3 agent once and print Claude Code's answer.
//
//   node scripts/invoke.mjs <agentRuntimeArn> "<prompt>" [sessionId]
//
// Uses your normal AWS credentials (for example AWS_PROFILE). Reuse the same
// sessionId (33+ characters) to continue a conversation.
import { randomUUID } from 'node:crypto';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';

const [agentRuntimeArn, prompt, sessionId = `c3-${randomUUID()}`] = process.argv.slice(2);
if (!agentRuntimeArn || !prompt) {
  console.error('Usage: node scripts/invoke.mjs <agentRuntimeArn> "<prompt>" [sessionId]');
  process.exit(1);
}

const region = agentRuntimeArn.split(':')[3];
const client = new BedrockAgentCoreClient({ region });
const response = await client.send(
  new InvokeAgentRuntimeCommand({
    agentRuntimeArn,
    runtimeSessionId: sessionId,
    contentType: 'application/json',
    accept: 'application/json',
    payload: Buffer.from(JSON.stringify({ prompt })),
  }),
);
const body = JSON.parse(await response.response.transformToString());
console.error(`session: ${sessionId}`);
if (body.status !== 'success') {
  console.error(`error: ${body.error ?? 'unknown error'}`);
  process.exitCode = 1;
}
console.log(body.response ?? '');
