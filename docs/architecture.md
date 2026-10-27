# Architecture

C3 composes official AWS CDK constructs from `aws-cdk-lib/aws-bedrockagentcore` with the official
Claude Code CLI. C3's own code covers three things: packaging, the glue that turns an HTTP request
into a CLI call, and the IAM and tool wiring.

## Components

| Component | Source | Notes |
|---|---|---|
| `ClaudeCodeAgent` | `src/claude-code-agent.ts` | Public construct. Composes everything below. |
| Workspace inspection | `src/workspace/` | Reads the workspace (never writes to it), applies excludes, emits warnings, fingerprints the contents. |
| Runtime artifact | `src/runtime/artifact.ts`, `runtime-assets/Dockerfile` | Deterministic Docker build context → `AgentRuntimeArtifact.fromAsset` (ARM64). |
| Entrypoint | `runtime-assets/entrypoint/` | HTTP server on `0.0.0.0:8080`: `POST /invocations`, `GET /ping`. Spawns `claude -p`. |
| Model access | `src/runtime/models.ts` | `ANTHROPIC_MODEL` plus IAM for Bedrock invoke and inference profiles. |
| Tool gateway | `src/gateway/` | One AgentCore Gateway per agent, `AWS_IAM` inbound auth, only created by `connect()`. |
| Connectors | `src/connections/`, `runtime-assets/adapters/` | Lambda targets, plus small audited adapters for S3, DynamoDB, SQS and EventBridge. |
| Grants | `src/security/grants.ts` | Least-privilege IAM for `grant()`. |

## Request flow

1. A caller with `bedrock-agentcore:InvokeAgentRuntime` invokes the runtime, passing a
   `runtimeSessionId` and a JSON payload `{ "prompt": "…", "stream": false }`.
2. AgentCore routes the request to a microVM that runs the C3 image. The entrypoint:
   - derives a stable UUID from the AgentCore session ID;
   - runs `claude -p <prompt> --output-format stream-json --verbose --permission-mode <mode>`
     in `/workspace`, adding `--session-id` on the first call and `--resume` on later calls in the
     same microVM;
   - when tools are connected, passes `--mcp-config` with one stdio server, `c3-gateway`. That
     server runs `mcp-proxy-for-aws-cli`, which signs MCP requests to the Gateway with SigV4 using
     the runtime role.
3. Claude Code calls Claude on Amazon Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`) with the execution
   role's credentials.
4. The entrypoint returns `{ status, response, sessionId, totalCostUsd, usage }` as JSON. If the
   request set `"stream": true`, it instead relays every stream-json event as Server-Sent Events,
   followed by a final `c3.result` event.

## Identities

| Identity | Can do |
|---|---|
| Runtime execution role | Invoke Claude models, write runtime logs and metrics (AgentCore defaults), `InvokeGateway` on its own gateway, plus whatever you `grant()`. |
| Gateway service role | `lambda:InvokeFunction` on connected functions and adapters only. |
| Adapter function roles | Exactly the resource actions of their connection. |

Keeping these identities separate means the runtime role never reads your table or bucket
directly through `connect()`. All of that access goes through a tool with a fixed schema.

## Determinism

The Docker build context is keyed by a SHA-256 over the workspace files (paths and contents) and
the C3 runtime files. If neither changes, the asset hash stays the same and CloudFormation has
nothing to update. Base images, `uv`, `mcp-proxy-for-aws-cli` and Claude Code are all
version-pinned. Debian packages are not pinned: they come from the pinned base image's suite.

## Why the CLI and not the Agent SDK?

The CLI in headless mode loads the workspace's own `CLAUDE.md`, settings, permissions, hooks,
skills, subagents and MCP configuration, exactly as on a developer machine. That is the core
promise of C3. The Agent SDK is a reasonable alternative, but it would need extra configuration to
reach the same behavior.
