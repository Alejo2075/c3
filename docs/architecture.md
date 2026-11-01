# Architecture

C3 composes official AWS CDK constructs from `aws-cdk-lib/aws-bedrockagentcore` with the official
Claude Agent SDK, which runs Claude Code. C3's own code covers three things: packaging, the glue
that turns an HTTP request into an SDK `query()` call, and the IAM and tool wiring.

## Components

| Component            | Source                                                 | Notes                                                                                                                   |
| -------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `C3Agent`            | `src/agent.ts`                                         | Public construct. Composes everything below.                                                                            |
| Workspace inspection | `src/workspace/`                                       | Reads the workspace (never writes to it), applies excludes, emits warnings, fingerprints the contents.                  |
| Runtime artifact     | `src/runtime/artifact.ts`, `runtime-assets/Dockerfile` | Deterministic Docker build context → `AgentRuntimeArtifact.fromAsset` (ARM64).                                          |
| Entrypoint           | `runtime-assets/entrypoint/`                           | HTTP server on `0.0.0.0:8080`: `POST /invocations`, `GET /ping`. Calls `query()` from `@anthropic-ai/claude-agent-sdk`. |
| Model access         | `src/runtime/models.ts`                                | `ANTHROPIC_MODEL` plus IAM for Bedrock invoke and inference profiles.                                                   |
| Tool gateway         | `src/gateway/`                                         | One AgentCore Gateway per agent, `AWS_IAM` inbound auth, only created by `connect()`.                                   |
| Connectors           | `src/connections/`, `runtime-assets/adapters/`         | Lambda targets, plus small audited adapters for S3, DynamoDB, SQS and EventBridge.                                      |
| Grants               | `src/security/grants.ts`                               | Least-privilege IAM for `grant()`.                                                                                      |

## Request flow

1. A caller with `bedrock-agentcore:InvokeAgentRuntime` invokes the runtime, passing a
   `runtimeSessionId` and a JSON payload `{ "prompt": "…", "stream": false }`.
2. AgentCore routes the request to a microVM that runs the C3 image. The entrypoint:
   - derives a stable UUID from the AgentCore session ID;
   - calls `query({ prompt, options })` with `cwd: /workspace`, the configured `permissionMode`,
     `allowedTools`, `disallowedTools`, `maxBudgetUsd` and `model`, and `settingSources: ['user',
'project', 'local']` plus the `claude_code` system prompt preset so the workspace behaves as
     on a developer machine. It sets `sessionId` on the first call and `resume` on later calls in
     the same microVM;
   - when tools are connected, passes `mcpServers` with one stdio server, `c3-gateway`. That
     server runs `mcp-proxy-for-aws-cli`, which signs MCP requests to the Gateway with SigV4 using
     the runtime role;
   - on timeout, calls `interrupt()` so the turn ends with a result and its cost, and aborts the
     process only after a 10 second grace period.
3. Claude Code calls Claude on Amazon Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`) with the execution
   role's credentials.
4. The entrypoint returns `{ status, response, sessionId, totalCostUsd, usage }` as JSON. If the
   request set `"stream": true`, it instead relays every SDK message (including partial messages) as Server-Sent Events,
   followed by a final `c3.result` event.

## Identities

| Identity               | Can do                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime execution role | Invoke Claude models, write runtime logs and metrics (AgentCore defaults), `InvokeGateway` on its own gateway, plus whatever you `grant()`. |
| Gateway service role   | `lambda:InvokeFunction` on connected functions and adapters only.                                                                           |
| Adapter function roles | Exactly the resource actions of their connection.                                                                                           |

Keeping these identities separate means the runtime role never reads your table or bucket
directly through `connect()`. All of that access goes through a tool with a fixed schema.

## Determinism

The Docker build context is keyed by a SHA-256 over the workspace files (paths and contents) and
the C3 runtime files. If neither changes, the asset hash stays the same and CloudFormation has
nothing to update. Base images, `uv`, `mcp-proxy-for-aws-cli` and the Claude Agent SDK (and the Claude Code binary it bundles) are all
version-pinned. Debian packages are not pinned: they come from the pinned base image's suite.

## Why the Agent SDK?

The [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) is the official,
supported way to run Claude Code programmatically. It runs the same Claude Code binary as the CLI
(the npm package ships it), so C3 does not reimplement an agent loop. With `settingSources` set to
`user`, `project` and `local` it loads the workspace's own `CLAUDE.md`, settings, permissions,
hooks, skills, subagents and MCP configuration, which is the core promise of C3. Compared with
spawning the CLI, it gives typed messages, `interrupt()` and `AbortController` for orderly
timeouts, and room for later features such as `canUseTool` approval callbacks.

Two details matter when changing the entrypoint:

- The SDK's default system prompt is minimal. C3 requests the `claude_code` preset so behavior
  matches a developer machine.
- `env` replaces the subprocess environment, so C3 passes `{ ...process.env }` to keep
  `CLAUDE_CODE_USE_BEDROCK` and the runtime role's credentials.
