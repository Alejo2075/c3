# c3-aws

## 0.1.0

### Minor Changes

- f4abf31: The runtime entrypoint now uses the official Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) instead of spawning the Claude Code CLI. The `claudeCodeVersion` prop is replaced by `agentSdkVersion`, and timeouts interrupt the turn before aborting it.
- 92a0f20: Add `c3-aws/client` (`invokeAgent`, `invokeAgentStream`), the `outputSchema` prop for structured output, and `auditToolCalls` (on by default) to log tool names and outcomes without inputs or outputs.
- 7698838: First public release: `C3Agent` with native Claude Code workspace packaging, an AgentCore Runtime HTTP adapter, Bedrock model access, `grant()`, and `connect()` for Lambda, S3, DynamoDB, SQS and EventBridge through AgentCore Gateway.

### Patch Changes

- d237f6e: DynamoDB connections reject `indexes` together with `partitionKeyPrefixes` (IAM leading-key conditions do not cover index queries), and session restore validates archive members before extracting.
