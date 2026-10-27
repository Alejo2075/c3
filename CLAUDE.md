# C3 — Claude Code Cloud

## Purpose of this file

This document is the primary engineering context for AI coding agents working on **C3**. Read it before proposing architectural changes or implementing features. Follow the decisions below; do not silently expand the project into a generic agent framework.

**Project status:** v0.x is implemented in `src/` and unit-tested with CDK assertions, but it has not yet been verified end to end on AWS (see `docs/limitations.md`). Snippets in this document describe the intended developer experience; the README documents the shipped API. Validate upstream APIs and service availability before changing them.

## 1. Vision

**C3 is an open-source, TypeScript-first framework to create, configure, connect, and deploy Claude Code agents to Amazon Bedrock AgentCore, using AWS CDK underneath.**

Short positioning: **Build Claude Code agents. Connect AWS services. Deploy with CDK.**

The framework should feel like a purpose-built, higher-level CDK construct—not a general-purpose agent SDK, code generator, pattern gallery, hosted platform, or replacement for Claude Code.

A developer should be able to:

1. Reuse an existing Claude Code workspace, including `CLAUDE.md`, `.claude/agents`, `.claude/skills`, `.claude/settings.json`, hooks, plugins, and MCP configuration as supported by Claude Code.
2. Declare a `ClaudeCodeAgent` inside a normal TypeScript CDK application.
3. Give the agent access to selected AWS resources with a small, explicit, least-privilege API.
4. Expose selected resource operations as discoverable agent tools when appropriate.
5. Deploy and manage the AWS infrastructure with standard CDK commands.
6. Retain access to the underlying CDK constructs for advanced customization.

**The main product promise is simplicity at the boundary between Claude Code and AWS.**

## 2. Firm product decisions

- **Name:** C3 (Claude Code Cloud).
- **Category:** Open-source, code-first AWS infrastructure framework.
- **Primary language:** TypeScript, targeting Node.js.
- **Infrastructure engine:** AWS CDK v2 (`aws-cdk-lib`, `constructs`).
- **Execution target:** Amazon Bedrock AgentCore **Runtime**, preferably Runtime V2 where supported and verified.
- **Coding-agent engine:** The existing official Claude Code executable / supported programmatic invocation. Preserve its native behavior and configuration.
- **Model access:** Amazon Bedrock for Claude models by default; avoid embedding static AWS keys or provider keys.
- **Tools:** Native Claude Code tooling and MCP; Amazon Bedrock AgentCore Gateway when suitable for managed MCP tools.
- **Deployment:** Regular `cdk synth`, `cdk diff`, and `cdk deploy`. Do not create a separate deployment CLI for the MVP.
- **Packaging:** One npm package, `c3-aws`. The `@c3` npm scope belongs to an unrelated publisher, so `@c3/cloud` cannot be used.
- **Target user:** Developers with existing AWS accounts who want Claude Code agents in their own infrastructure.

## 3. Non-goals — do not build these

- A new Claude Agent SDK, agent loop, reasoning engine, prompt abstraction, or `Agent.run()` SDK.
- A new model router, MCP protocol implementation, custom tool-calling engine, or custom persistent memory engine.
- A standalone web dashboard, proprietary hosted control plane, SaaS backend, or separate account system.
- A generic AI-agent framework for every model and provider.
- A repository scaffolder as the core product.
- A gallery of unrelated AWS architectural patterns.
- A duplicate of the AWS AgentCore CLI or official CDK L2 constructs.
- Automatic or excessively broad access to arbitrary AWS resources.

Use official AWS SDKs, CDK libraries, AWS services, and Claude Code conventions wherever possible. Write C3-owned code **only for integration gaps and ergonomic orchestration**.

## 4. Primary abstraction

Expose a high-level **`ClaudeCodeAgent`** construct built from official CDK constructs and native Claude Code artifacts.

Proposed public interface (DESIGN TARGET; not implemented):

```ts
import { App, Stack } from 'aws-cdk-lib';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import { ClaudeCodeAgent } from 'c3-aws';

const app = new App();
const stack = new Stack(app, 'Agents');

const bucket = new Bucket(stack, 'Documents');
const notification = /* an existing Lambda function */ {} as LambdaFunction;

const reviewer = new ClaudeCodeAgent(stack, 'Reviewer', {
  source: './agents/reviewer',
  model: 'sonnet', // Resolve and validate the actual Bedrock model ID per region.
});

// IAM permissions for AWS SDK, CLI or scripts running inside Claude Code:
reviewer.grant(bucket, {
  actions: ['s3:ListBucket', 's3:GetObject'],
  prefixes: ['documents/*'],
});

// An agent-discoverable tool via AgentCore Gateway:
reviewer.connect(notification, {
  name: 'send_notification',
  description: 'Send a user notification',
  // Provide an explicit, validated input/output schema.
  inputSchema: notificationSchema,
});

app.synth();
```

The snippet deliberately illustrates ergonomics. It is not compile-ready until the final public types, schemas, and adapters exist. Avoid inventing unsupported methods on upstream CDK classes; implement them in C3 as needed.

**Important separation:**

- `agent.grant(resource, ...)` = allow the agent's AWS identity to call certain AWS APIs. It does **not** create a Claude tool.
- `agent.connect(resource, ...)` = make specified resource operations **available as tools**, preferably through AgentCore Gateway and its documented target types. It must also arrange the necessary authentication and IAM permissions.
- A user must opt in to the exact actions exposed. An imported resource does not grant implicit write permissions.

## 5. Native Claude Code project format

Keep the source directory a normal Claude Code workspace. Do not invent a parallel C3 agent-definition DSL.

Suggested example layout:

```text
sample-app/
├── bin/
│   └── app.ts                 # Ordinary AWS CDK app
├── agents/
│   └── reviewer/
│       ├── CLAUDE.md         # Native Claude Code instructions
│       ├── .claude/
│       │   ├── agents/       # Native subagents
│       │   ├── skills/       # Native skills
│       │   └── settings.json
│       └── .mcp.json         # When applicable
├── cdk.json
└── package.json
```

One `ClaudeCodeAgent` construct represents **one deployed Claude Code execution environment**. A workspace can contain several native Claude Code subagents; do not confuse those subagents with independently deployed AgentCore runtimes.

Preserve Claude Code file semantics, support optional custom workspace paths, and avoid mutating user source files during packaging. Warn about unsupported platform dependencies rather than silently ignoring them.

## 6. System architecture

```text
Developer's TypeScript CDK application
  └── C3 ClaudeCodeAgent (high-level construct)
        ├── Workspace/artifact preparation
        │     └── Existing Claude Code installation and configuration
        ├── AWS CDK L2 constructs
        │     ├── AgentCore Runtime + endpoint (as required)
        │     ├── IAM execution role + scoped policies
        │     ├── ECR/S3 assets, depending on runtime packaging
        │     └── CloudWatch/observability integration
        ├── Optional AgentCore Gateway + targets
        │     └── Lambda/OpenAPI/Smithy/MCP, as supported
        └── Optional AWS-resource-specific adapters
              └── Only where Gateway has no suitable direct target

AgentCore Runtime -> Claude Code -> Claude on Amazon Bedrock
                           └── MCP tools / permitted AWS SDK actions
```

Use official `aws-cdk-lib/aws-bedrockagentcore` constructs when possible, especially `Runtime`, `RuntimeEndpoint`, `Gateway`, `GatewayTarget`, and `AgentRuntimeArtifact`. Prefer composition over wrapping or reimplementing every upstream feature.

### Runtime integration

- Runtime is the hosting environment; **do not replace Claude Code with AgentCore Harness**.
- Start with a minimal AgentCore-compatible entrypoint that forwards requests to the official Claude Code executable using its supported noninteractive mechanism. This entrypoint is integration glue, not a new agent loop.
- Package Git, shell utilities, required language runtimes, and the user's workspace in a reproducible, version-pinned artifact.
- Prefer an official AgentCore-supported deployment artifact. Use a container when dependencies or the Claude executable cannot reliably be packaged into a direct code asset.
- Do not assume AgentCore's session isolation automatically provides durable source files or permanent conversational memory. Treat session, storage, and recovery as separately verified capabilities.
- Use Runtime V2 only after checking availability, account/region support, and the current CDK API.
- Expose generated runtime/endpoint/CDK resources for extensions and troubleshooting.

## 7. AWS service connections: the differentiator

C3 must make AWS resource connections exceptionally straightforward **without claiming that any AWS resource is automatically an MCP tool**.

### Two distinct capabilities

**A. Direct AWS permissions (`grant`)**

For Claude Code's shell commands, AWS CLI, and existing SDKs. Use CDK resource grant methods where appropriate or narrowly scoped IAM policies. Distinguish resource-level actions from bucket/list and other account-level permissions. Never default to `*`.

**B. Agent-discoverable tools (`connect`)**

For actions Claude can discover with MCP. Reuse **AgentCore Gateway**:

- Lambda: first-class Lambda target with explicitly defined tool schemas.
- OpenAPI endpoints: Gateway OpenAPI target when supported.
- Smithy-modeled operations: Gateway Smithy target when the selected protocol/operation is actually supported.
- Existing MCP servers: Gateway MCP target when appropriate.
- S3/DynamoDB/SQS/EventBridge: investigate supported direct targets; where unavailable or impractical, use a *small, audited Lambda adapter* that calls the official AWS SDK. Do not promise generic automatic MCP exposure for every AWS resource.

Each connector must describe: supported operations, IAM permissions, tool names, input/output schemas, authorization, error handling, resource scope, and limitations.

### Proposed priority order

1. Lambda tool connection (MVP): prove real Gateway integration end to end.
2. S3 connection, starting with list/read operations restricted to specified buckets and prefixes.
3. DynamoDB connection, starting with GetItem/Query restricted to declared tables and approved key patterns.
4. SQS and EventBridge integrations, after validating security and semantics.
5. Advanced targets: remote MCP, OpenAPI, other AgentCore agents, and additional services.

`connect` and `grant` should support resources already defined in the developer's CDK application and imports when CDK grants are supported. Avoid recreating existing resources.

## 8. Security requirements

Security is part of the public API, not an afterthought:

- AWS IAM is the final authority for AWS resource access; Claude Code tool permissions do not replace IAM.
- Default to **no access** except the narrow permissions needed for model invocation and runtime operation.
- Default connected tools to **read-only** where meaningful.
- Require explicit opt-in for modifications, deletion, arbitrary shell command access, network egress, and privileged tools.
- Scope S3 actions by bucket/object ARN and prefix; scope DynamoDB actions by table/index and query constraints; scope Lambda invocation to explicit functions.
- Avoid exposing Secrets Manager values as ordinary LLM-visible tool output. Use authorized secret injection or brokered credentials instead.
- Do not put credentials, access tokens, or secrets in source code, CloudFormation outputs, logs, prompt text, or generated MCP configuration.
- Use AWS credentials through IAM roles/AgentCore Identity/approved auth mechanisms; use the developer's existing AWS SSO/profile for CDK commands.
- Separate runtime identity from Gateway target execution identity where feasible. Evaluate both ingress and egress authentication.
- Sanitize logs, validate tool schemas, constrain filesystem/network access, and document prompt-injection risks from untrusted repositories and tool outputs.
- Require explicit approval gates for any feature that could modify infrastructure or repositories at scale.

## 9. Developer experience

C3 should feel like normal AWS CDK:

```bash
npm install c3-aws aws-cdk-lib constructs
npx cdk synth
npx cdk diff
npx cdk deploy
```

Standard `cdk` tooling handles deployment; C3 does not need a custom deployment CLI in v0.1.

Design preferences:

- One primary construct (`ClaudeCodeAgent`), minimum required props, safe defaults.
- Prefer first-class TypeScript types and IntelliSense over YAML or magic strings.
- Prefer resource object references to hand-entered ARNs.
- Keep all generated infrastructure inside the application's CDK construct tree.
- Generate deterministic asset inputs so unchanged code produces stable deployments.
- Expose resources, roles, and endpoints for power users; do not conceal them.
- Produce actionable errors for unsupported regions, missing model access, invalid workspace paths, unsupported tools, and connector schemas.
- Avoid hidden AWS charges: document which services provision and bill.

## 10. Suggested repository layout

```text
c3/
├── src/
│   ├── claude-code-agent.ts         # Main high-level CDK construct
│   ├── workspace/                  # Source discovery, validation, assets
│   ├── runtime/                    # AgentCore runtime/entrypoint integration
│   ├── connections/                # Explicit resource-to-tool integrations
│   │   ├── lambda.ts
│   │   ├── s3.ts
│   │   └── dynamodb.ts
│   ├── gateway/                    # Composition of official Gateway constructs
│   ├── security/                   # IAM grants and safety checks
│   └── index.ts                    # Minimal public exports
├── runtime-assets/                # Minimal Claude Code integration entrypoint
├── examples/
│   ├── hello-agent/
│   └── lambda-tool/
├── test/
│   ├── unit/
│   └── integration/
├── docs/
├── package.json
├── tsconfig.json
├── README.md
└── CLAUDE.md
```

Create only directories that are actively needed; avoid speculative abstractions and unnecessary packages.

## 11. Release roadmap

### v0.1 — minimum end-to-end proof

- `ClaudeCodeAgent` construct with a native Claude Code workspace path.
- Reproducible packaging of the real Claude Code executable and dependencies.
- Deployment to AgentCore Runtime via AWS CDK, model access using Amazon Bedrock.
- Runtime IAM execution role with minimum permissions.
- One controlled invocation that demonstrably returns Claude Code output.
- CloudWatch logs and an example with synth/deploy/destroy instructions.
- One verified Lambda connection exposed as an MCP tool through Gateway.
- CDK assertions/tests for assets, role policies, runtime, endpoint, and Gateway target.

### v0.2 — useful AWS integrations

- Stable `connect()` and `grant()` APIs.
- Read-only S3 tools and narrowly scoped DynamoDB tools.
- Imported CDK resources where possible.
- Better auth, input schemas, output filtering, error messages, and documentation.

### v0.3 — production hardening

- Support for observability/traces, configuration checks, runtime version updates, configurable networking, sessions and optional workspace durability.
- Versioned assets, upgrade tests and representative failure testing.
- More supported Gateway targets, without generalizing prematurely.

### Future, only after actual user demand

- Advanced session restoration, integrations with GitHub, more AWS resources, composable multi-agent deployment, and optional developer tooling.
- Do not add a dashboard or standalone control plane by default.

## 12. Engineering quality bar

- TypeScript strict mode; no unnecessary `any` or unsafe casts.
- Use official package APIs; verify signatures against pinned dependency versions before coding.
- Pin/test a compatible range of AWS CDK and relevant AWS/Anthropic tooling.
- Add unit tests using `aws-cdk-lib/assertions` for synthesized templates.
- Test expected IAM allow/deny behavior and security boundaries, not just snapshots.
- Provide one real AWS integration test for deploying, invoking, connecting a Lambda tool, and tearing down resources; keep it opt-in and cost-aware.
- Avoid network calls and credentials during `cdk synth` unless absolutely unavoidable and explicitly documented.
- Implement idempotent, deterministic deployment and explicit removal policies.
- Document known security/region/model limitations without pretending they are solved.
- Track generated assets and pinned external dependencies; verify license and distribution terms before bundling Claude Code.
- Keep README examples synced with tested public APIs.

## 13. Implementation workflow for coding agents

When tasked with new work:

1. Identify whether the work is **Claude Code integration**, **CDK/AgentCore infrastructure**, or **AWS service connections**.
2. Consult current official AWS CDK, AgentCore, and Claude Code references before selecting APIs.
3. Check for an existing official implementation first. Prefer it over new code.
4. Make the smallest cohesive change that improves the end-to-end developer experience.
5. Keep native Claude Code configurations unchanged wherever possible.
6. Update types, tests, a runnable example, and the relevant docs together.
7. Run type checking, linting, CDK synth/assertions, and any safe local tests.
8. Distinguish **implemented**, **planned**, and **unverified** functionality in every report.
9. Never claim an AWS deployment or an integration works without testing it.
10. Never execute `cdk deploy`, `cdk destroy`, privilege-escalating commands, or cost-incurring operations against a real account without the user's explicit authorization.

## 14. Open technical questions

These are NOT resolved decisions. Investigate before promising support:

1. Exact, currently supported means of packaging/distributing the Claude Code executable on AgentCore Runtime V2; constraints, licensing, runtime architecture, and version pinning.
2. Whether container assets or Node.js code assets provide the most reliable Claude Code environment; start with actual reproducibility tests.
3. The minimal request/response and streaming adapter needed for real Claude Code invocations on AgentCore Runtime.
4. Session continuity, filesystem persistence and reconnect semantics supported by the selected runtime version.
5. Precise Bedrock model identifiers and availability for target AWS regions.
6. Authentication from Claude Code to the Gateway MCP endpoint, including agent identity and SigV4/OAuth behavior.
7. Supported Gateway target types/operations for the first S3 and DynamoDB integrations; implement minimal Lambda adapters only where necessary.
8. Whether a single shared Gateway per app or a Gateway per agent is preferable for least privilege, costs, and isolation.
9. API shape for granting object-level IAM and MCP tools without conflating them.
10. Which CDK resources C3 should expose as public, stable properties.

### Decisions taken during implementation (2026-10)

These answer parts of the questions above; revisit them if upstream behavior changes.

- **Q1/Q2:** Container artifact (ARM64, `node:22-bookworm-slim`). Claude Code is installed from npm at image build time with a pinned version (`DEFAULT_CLAUDE_CODE_VERSION`) and is never redistributed by C3.
- **Q3:** The entrypoint runs `claude -p --output-format stream-json` and returns JSON, or SSE when `stream: true`.
- **Q5:** Model aliases are resolved by Claude Code itself. IAM is scoped to `anthropic.claude-*`, or to the exact inference profile when one is pinned.
- **Q6:** The Gateway uses `AWS_IAM` inbound auth. Claude Code reaches it through `mcp-proxy-for-aws-cli` (SigV4) as a stdio MCP server named `c3-gateway`. Not yet verified on AWS.
- **Q7:** S3, DynamoDB, SQS and EventBridge use small Lambda adapters in `runtime-assets/adapters`.
- **Q8:** One gateway per agent, created lazily on the first `connect()`.
- Gateway target names allow only letters, digits and `-`, so C3 converts `_` to `-`.

## 15. References (check for updates)

- AWS AgentCore CDK constructs: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_bedrockagentcore-readme.html
- AWS AgentCore Runtime L2: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_bedrockagentcore.Runtime.html
- AWS AgentCore Gateway targets: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-targets-mcp.html
- AWS article about cloud-hosted coding agents: https://aws.amazon.com/blogs/machine-learning/its-safe-to-close-your-laptop-now-hosting-coding-agents-on-amazon-bedrock-agentcore/
- Claude Agent SDK reference: https://code.claude.com/docs/en/agent-sdk/overview
- Claude Code documentation: https://code.claude.com/docs/en/overview

## 16. Product and branding notes

The project name is **C3 — Claude Code Cloud**. The visual direction discussed is a warm, muted terracotta background, a white pixel/block-style Claude mascot with sharp 90-degree corners, and retro pixel lettering inspired by Claude Code. This is branding context only; prioritize framework behavior and correctness. Respect trademark and branding rules in public distribution and clearly identify C3 as an independent open-source project, not an official Anthropic or AWS product.

---

**North star:** A developer should be able to take a real Claude Code workspace, construct one `ClaudeCodeAgent`, explicitly connect the AWS capabilities it needs, and deploy it with `cdk deploy`—without learning every AgentCore, IAM, Gateway, packaging, and authentication detail first.
