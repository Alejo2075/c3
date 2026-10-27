# c3-aws

## 0.1.0

### Minor Changes

- 7698838: First public release: `ClaudeCodeAgent` with native Claude Code workspace packaging, an AgentCore Runtime HTTP adapter, Bedrock model access, `grant()`, and `connect()` for Lambda, S3, DynamoDB, SQS and EventBridge through AgentCore Gateway.

### Patch Changes

- d237f6e: DynamoDB connections reject `indexes` together with `partitionKeyPrefixes` (IAM leading-key conditions do not cover index queries), and session restore validates archive members before extracting.
