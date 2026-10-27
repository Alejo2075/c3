<p align="center">
  <img src="https://raw.githubusercontent.com/Alejo2075/c3/main/docs/assets/c3-header.png" alt="C3: Claude Code Cloud" width="100%" />
</p>

<p align="center">
  <strong>Build Claude Code agents. Connect AWS services. Deploy with CDK.</strong>
</p>

<p align="center">
  <a href="https://github.com/Alejo2075/c3/actions/workflows/ci.yml"><img src="https://github.com/Alejo2075/c3/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/c3-aws"><img src="https://img.shields.io/npm/v/c3-aws.svg" alt="npm" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
</p>

---

**C3 (Claude Code Cloud)** is an open-source AWS CDK construct library that deploys a real
[Claude Code](https://code.claude.com/docs/en/overview) workspace to
[Amazon Bedrock AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/), with Claude
models on Amazon Bedrock. You give the agent explicit, least-privilege access to your AWS resources.

- **Reuse your workspace as is.** `CLAUDE.md`, `.claude/agents`, `.claude/skills`, `settings.json`,
  hooks and `.mcp.json` keep working. There is no new agent DSL.
- **One construct.** `new ClaudeCodeAgent(...)` lives in an ordinary CDK app. You deploy it with
  `cdk deploy`.
- **Explicit AWS access.** `grant()` adds IAM permissions. `connect()` exposes specific operations
  as MCP tools through AgentCore Gateway. Neither does anything you did not ask for.
- **Open underneath.** The runtime, role, gateway and targets are all regular CDK constructs, and
  you can reach every one of them.

> [!IMPORTANT]
> C3 is an independent project. It is **not** affiliated with or endorsed by Anthropic or AWS.
> It is early-stage software (`0.x`): read [Status](#status) before using it in production.

## Quick start

```bash
npm install c3-aws aws-cdk-lib constructs
```

```ts
import { App, Stack } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { ClaudeCodeAgent } from 'c3-aws';

const app = new App();
const stack = new Stack(app, 'Agents');

const reviewer = new ClaudeCodeAgent(stack, 'Reviewer', {
  source: './agents/reviewer', // a normal Claude Code workspace
  model: 'sonnet',
});

// IAM only: lets Bash/SDK scripts inside Claude Code read these objects. No tool is created.
const documents = new s3.Bucket(stack, 'Documents');
reviewer.grant(documents, { actions: ['s3:ListBucket', 's3:GetObject'], prefixes: ['documents/*'] });

// An MCP tool backed by your Lambda function, served through AgentCore Gateway.
declare const notification: lambda.IFunction;
reviewer.connect(notification, {
  name: 'send_notification',
  description: 'Send a user notification',
  inputSchema: {
    type: 'object',
    properties: { message: { type: 'string', description: 'Notification text' } },
    required: ['message'],
  },
});
```

```bash
npx cdk deploy                  # needs Docker (ARM64 builds) and a bootstrapped account
node scripts/invoke.mjs <AgentRuntimeArn> "Review the latest report"
```

Your workspace stays a native Claude Code project:

```text
agents/reviewer/
├── CLAUDE.md
├── .claude/
│   ├── agents/          # subagents
│   ├── skills/
│   └── settings.json    # permissions are honored in the cloud too
└── .mcp.json            # optional
```

## How it works

```text
your CDK app
 └─ ClaudeCodeAgent
     ├─ ARM64 container: Claude Code CLI (version-pinned) + your workspace + tiny HTTP adapter
     ├─ AgentCore Runtime (HTTP protocol) + execution role scoped to Claude models on Bedrock
     └─ AgentCore Gateway (IAM auth), created only when you call connect()
         └─ targets: your Lambda functions, or C3's audited S3 / DynamoDB / SQS / EventBridge adapters

invoke → AgentCore Runtime → claude -p … (stream-json) → Claude on Amazon Bedrock
                                  └─ MCP: c3-gateway → SigV4 proxy → AgentCore Gateway → tools
```

The adapter in [`runtime-assets/entrypoint`](runtime-assets/entrypoint) implements the
[AgentCore HTTP contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html)
(`POST /invocations`, `GET /ping`). For each request it runs the official CLI in headless mode.
It is glue code, not an agent loop. See [docs/architecture.md](docs/architecture.md).

## `grant()` vs `connect()`

| | `agent.grant(resource, …)` | `agent.connect(resource, …)` |
|---|---|---|
| What it does | Adds IAM permissions to the agent's execution role | Makes specific operations available as MCP tools |
| Who calls AWS | Claude Code itself (Bash, AWS CLI, SDK scripts) | A Gateway target (your Lambda, or a C3 adapter) |
| Creates a tool | No | Yes, `mcp__c3-gateway__<name>___<tool>` |
| Runtime role gets resource access | Yes, exactly the listed actions | No, only `bedrock-agentcore:InvokeGateway` |

### Supported connections

| Resource | Tools | Scope enforced by IAM and the adapter |
|---|---|---|
| `lambda.IFunction` | Your explicit schema(s) | Gateway role may invoke only that function |
| `s3.IBucket` | `list_objects`, `get_object` (read-only) | `prefixes` (required); `s3:prefix` condition; size caps |
| `dynamodb.ITable` | `get_item`, `query` (read-only) | Declared indexes, `dynamodb:LeadingKeys`, `dynamodb:Attributes` |
| `sqs.IQueue` | `send_message` | One queue, body size cap |
| `events.IEventBus` | `put_event` | Fixed `source`, allow-listed `detailTypes` |
| OpenAPI (`connectOpenApi`) | From the spec | Explicit outbound credentials |
| Remote MCP server (`connectMcpServer`) | From the server | Credentials required |

The full options and the IAM each connector creates are in [docs/connections.md](docs/connections.md).

## Configuration

```ts
new ClaudeCodeAgent(stack, 'Agent', {
  source: './agents/reviewer',
  model: ClaudeModel.fromInferenceProfileId('us.anthropic.claude-sonnet-4-6'), // pin for stability
  claudeCodeVersion: '2.1.311',
  permissionMode: PermissionMode.DONT_ASK,  // default: only pre-approved tools run
  allowedTools: ['Read', 'Grep'],
  maxBudgetUsd: 2,                          // per invocation
  invocationTimeout: Duration.minutes(15),
  installAwsCli: false,
  network: RuntimeNetworkConfiguration.usingVpc(stack, { vpc }),
  lifecycle: { idleRuntimeSessionTimeout: Duration.minutes(15) },
  platformVersion: PlatformVersion.V2,      // opt in after checking regional support
  tracing: true,
  applicationLogs: { retention: RetentionDays.ONE_MONTH },
  sessionStorage: { bucket: sessionsBucket }, // optional durability across microVMs
});
```

## Security model

- IAM has the final say. Claude Code permission rules are an extra layer on top of it, not a replacement.
- The defaults give no access to your AWS resources. Claude Code runs with `dontAsk`, so only tools
  that are pre-approved in your settings or `allowedTools` can run.
- Connected tools are read-only unless the connection is a write by nature (SQS, EventBridge), and
  even then it is scoped to one resource.
- C3 rejects environment variables that look like secrets, and its runtime adapter never logs prompts or model output.
- Tool output and workspace files can carry prompt injection. Read [docs/security.md](docs/security.md).

## Costs

`cdk deploy` creates billable resources: AgentCore Runtime (per vCPU/GB-hour while sessions are
active), Bedrock model tokens, ECR image storage, CloudWatch Logs, and, when you call `connect()`,
AgentCore Gateway plus Lambda adapters. See [docs/costs.md](docs/costs.md). Run `cdk destroy` when
you are done.

## Status

| Area | State |
|---|---|
| `ClaudeCodeAgent`, workspace packaging, IAM, Gateway wiring, connectors | **Implemented**, unit-tested with CDK assertions |
| Examples synthesize (`npm run synth:examples`) | **Implemented**, run in CI |
| Docker image build, deploy, invoke, Lambda tool round-trip | **Not yet verified on AWS.** An opt-in test exists in `test/integration` |
| Claude Code → Gateway auth through `mcp-proxy-for-aws` | **Unverified** until the integration test passes |
| Session durability (`sessionStorage`) | **Experimental** |

Known limitations are listed in [docs/limitations.md](docs/limitations.md).

## Examples

- [`examples/hello-agent`](examples/hello-agent): the smallest deployable agent
- [`examples/lambda-tool`](examples/lambda-tool): a Lambda function exposed as an MCP tool
- [`examples/aws-data`](examples/aws-data): read-only S3 and DynamoDB tools, plus `grant()`

## Development

```bash
npm ci
npm run typecheck && npm run lint && npm test
npm run synth:examples
C3_INTEGRATION=1 AWS_PROFILE=dev npm run test:integration   # billable, opt-in
```

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Alejandro Santana. Claude Code itself is not distributed with this project; it is
installed from npm under [Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance)
when you build the image. See [NOTICE](NOTICE).
