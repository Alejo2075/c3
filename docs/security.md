# Security

C3 treats security as part of its public API. This page lists what C3 enforces, what it leaves to
you, and the risks that remain.

## What C3 enforces

- **No implicit resource access.** The runtime role starts with AgentCore's default runtime
  permissions (its own logs, X-Ray, CloudWatch metrics in the `bedrock-agentcore` namespace,
  workload identity tokens, ECR pull of its image) plus Bedrock invoke on Anthropic Claude models.
  It gets nothing else unless you call `grant()` or `connect()`.
- **Exact actions.** `grant()` rejects wildcard actions (unless you set `allowWildcardActions`) and
  actions from the wrong service. S3 grants require `prefixes`.
- **Separate identities for tools.** Connected resources are accessed by the Gateway role (for
  invoking functions) and by per-connection adapter roles. The runtime role only gets
  `bedrock-agentcore:InvokeGateway` on its own gateway.
- **Inbound auth on the gateway.** Every gateway uses `AWS_IAM` (SigV4). C3 never creates gateways
  with `NONE` authorization.
- **Headless permissions.** Claude Code runs with `--permission-mode dontAsk` by default: a tool
  runs only if your `.claude/settings.json` or `allowedTools` pre-approves it. `bypassPermissions`
  has to be set explicitly.
- **Non-root container.** Claude Code runs as the `node` user.
- **Secrets.**
  - The construct rejects environment variable names that look like credentials, because
    runtime environment variables are visible in CloudFormation.
  - Workspace packaging always excludes `.env*`, `*.pem`, `*.key` and `.claude/settings.local.json`.
  - The entrypoint never logs prompts or model output.

## Your responsibilities

- **Prompt injection.** Repository contents, S3 objects, DynamoDB items and tool outputs are all
  untrusted input to the model. Keep write-capable tools narrow, and say in `CLAUDE.md` that data
  is data. Use Bedrock Guardrails if you need content filtering.
- **Network egress.** By default the runtime runs in AgentCore's public network mode, so Claude
  Code can reach the internet (`WebFetch`, `git clone`, package installs) wherever your permission
  rules allow it. Deny those tools, or use `network: RuntimeNetworkConfiguration.usingVpc(...)`
  with egress controls.
- **Who can invoke the agent.** Grant `agent.grantInvoke(principal)` to specific roles only. Every
  invocation spends Bedrock tokens: set `maxBudgetUsd`.
- **Secrets the agent needs.** Use AgentCore Identity credential providers for Gateway targets.
  Do not return secrets as tool output, where the model would see them.
- **Hooks and project MCP servers.** These run inside the container with the runtime role's
  credentials. Review them like any other code you deploy.
- **Session storage.** Archives include the workspace and conversation history. Use a private,
  encrypted bucket with lifecycle rules. All sessions of one agent share the runtime role, so IAM
  cannot stop one session from overwriting another session's archive. The entrypoint only
  extracts members inside `/workspace` and `~/.claude/projects` (no absolute paths, no `..`), but
  you should treat every session of an agent as one trust domain.

## Reporting vulnerabilities

See [SECURITY.md](../SECURITY.md).
