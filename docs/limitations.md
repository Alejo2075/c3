# Status and limitations

Each item is marked **implemented** (code and unit tests exist), **unverified** (implemented but
not yet proven against real AWS) or **planned**.

## Implemented

- `ClaudeCodeAgent` with workspace validation, exclusion, deterministic packaging and CDK
  annotations for unsupported features.
- Model selection (aliases, inference profiles, application inference profiles) and the IAM for it.
- `grant()` for S3, DynamoDB, Lambda, SQS, SNS and EventBridge.
- `connect()` for Lambda, S3, DynamoDB, SQS and EventBridge. `connectOpenApi()` and
  `connectMcpServer()` wrap the official targets.
- Runtime options: permission mode, allowed and disallowed tools, budget, timeout, VPC, lifecycle,
  platform version, tracing, application logs, named endpoint.
- The opt-in integration test (`test/integration`).

## Unverified (run the integration test to verify)

- Building the ARM64 image and running Claude Code inside AgentCore Runtime.
- Claude Code reaching the Gateway through `mcp-proxy-for-aws-cli` with the runtime role's
  credentials.
- `--resume` continuity across invocations of the same runtime session.
- `sessionStorage` restore and save across microVMs (**experimental**).
- `PlatformVersion.V2`: availability depends on account and region.
- That the `AWS_REGION` and credentials are available inside the container the way the entrypoint
  expects. It falls back to `C3_AWS_REGION`.

## Known limitations

- One invocation at a time per runtime session. A concurrent request gets HTTP 409.
- Streaming responses use SSE over `/invocations`. The WebSocket `/ws` endpoint is not implemented.
- Without `sessionStorage`, files written by the agent last only as long as the microVM.
- The WebSearch tool is not available on Amazon Bedrock.
- Plugins and project MCP servers that need extra binaries or network access may not work in the
  container. C3 warns about them but does not install anything.
- DynamoDB connections do not support binary or multi-attribute keys, or `Scan`.
- Gateway semantic search uses the CDK default protocol configuration.

## Planned (after real-world demand)

- WebSocket support, richer streaming clients and an async/background invocation pattern.
- Additional connectors only where Gateway has no suitable direct target.
- Upgrade tests across Claude Code and AgentCore versions.
