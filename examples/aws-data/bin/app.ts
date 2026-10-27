#!/usr/bin/env node
import * as path from 'node:path';
import { App, CfnOutput, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { ClaudeCodeAgent } from 'c3-aws';

const app = new App();
const stack = new Stack(app, 'C3AwsData');

const documents = new s3.Bucket(stack, 'Documents', {
  encryption: s3.BucketEncryption.S3_MANAGED,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  enforceSSL: true,
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

const orders = new dynamodb.Table(stack, 'Orders', {
  partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  removalPolicy: RemovalPolicy.DESTROY,
});

const analyst = new ClaudeCodeAgent(stack, 'Analyst', {
  source: path.join(__dirname, '..', 'agents', 'analyst'),
  model: 'sonnet',
  maxBudgetUsd: 2,
});

// MCP tools (read-only, through AgentCore Gateway and audited adapters):
analyst.connect(documents, { name: 'docs', prefixes: ['reports/'] });
analyst.connect(orders, {
  name: 'orders',
  partitionKeyPrefixes: ['TENANT#acme'],
  attributes: ['status', 'total', 'createdAt'],
});

// Plain IAM for scripts the agent runs itself (no tool is created):
analyst.grant(documents, { actions: ['s3:GetObject'], prefixes: ['reports/public/'] });

new CfnOutput(stack, 'AgentRuntimeArn', { value: analyst.runtime.agentRuntimeArn });
new CfnOutput(stack, 'DocumentsBucket', { value: documents.bucketName });
new CfnOutput(stack, 'OrdersTable', { value: orders.tableName });
