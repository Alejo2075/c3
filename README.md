<p align="center">
  <img src="https://raw.githubusercontent.com/Alejo2075/c3/main/docs/assets/c3-header.png" alt="C3: Claude Code Cloud" width="100%" />
</p>

<p align="center">
  <strong>Build Claude Code agents. Connect AWS services. Deploy with CDK.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/c3-aws"><img src="https://img.shields.io/npm/v/c3-aws?style=flat-square&color=D97757&labelColor=2B2523&logo=claude&logoColor=D97757&label=npm" alt="npm" /></a>
  <a href="https://github.com/Alejo2075/c3/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Alejo2075/c3/ci.yml?branch=main&style=flat-square&color=D97757&labelColor=2B2523&label=CI" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-D97757?style=flat-square&labelColor=2B2523" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/agent-sdk/overview"><img src="https://img.shields.io/badge/Claude%20Agent%20SDK-powered-D97757?style=flat-square&labelColor=2B2523&logo=claude&logoColor=D97757" alt="Claude Agent SDK" /></a>
  <a href="https://docs.aws.amazon.com/cdk/v2/guide/home.html"><img src="https://img.shields.io/badge/AWS%20CDK-v2-D97757?style=flat-square&labelColor=2B2523" alt="AWS CDK v2" /></a>
</p>

---

**C3 (Claude Code Cloud)** is an open-source AWS CDK construct library that deploys a real
[Claude Code](https://code.claude.com/docs/en/overview) workspace to
[Amazon Bedrock AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/), with Claude
models on Amazon Bedrock. It runs Claude Code through the official
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). You give the agent explicit,
least-privilege access to your AWS resources.

- **Reuse your workspace as is.** `CLAUDE.md`, `.claude/agents`, `.claude/skills`, `settings.json`,
  hooks and `.mcp.json` keep working. There is no new agent DSL.
- **One construct.** `new C3Agent(...)` lives in an ordinary CDK app. You deploy it with
  `cdk deploy`.
- **Explicit AWS access.** `grant()` adds IAM permissions. `connect()` exposes specific operations
  as MCP tools through AgentCore Gateway. Neither does anything you did not ask for.
- **Invoke it from code.** `c3-aws/client` wraps `InvokeAgentRuntime` with streaming, sessions and
  optional structured output (`outputSchema`).
- **Auditable.** Every tool call is logged by name, outcome and duration, never with its inputs or
  outputs.
- **Open underneath.** The runtime, role, gateway and targets are all regular CDK constructs, and
  you can reach every one of them.

> [!IMPORTANT]
> C3 is an independent project. It is **not** affiliated with or endorsed by Anthropic or AWS.
> It follows semantic versioning; while it is `0.x`, minor releases may include breaking changes.
> See [docs/limitations.md](docs/limitations.md) for scope and known limitations.

## Install

```bash
npm install c3-aws aws-cdk-lib constructs
```

Package: [npmjs.com/package/c3-aws](https://www.npmjs.com/package/c3-aws). To invoke agents from
code, also install `@aws-sdk/client-bedrock-agentcore` (see [Invoking from code](#invoking-from-code)).

**Requirements**

- Node.js 20 or later and an AWS CDK v2 app (TypeScript).
- An AWS account [bootstrapped for CDK](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html),
  in a region where Amazon Bedrock AgentCore is available.
- Access to a Claude model in Amazon Bedrock for that region.
- Docker running on the machine that runs `cdk deploy`. The runtime image is built for ARM64.

## Getting started

1. **Create a CDK app** (skip if you have one):

   ```bash
   mkdir my-agents && cd my-agents
   npx cdk init app --language typescript
   npm install c3-aws
   ```

2. **Create a Claude Code workspace** for the agent. It is a normal Claude Code project:

   ```bash
   mkdir -p agents/reviewer
   echo "You review documents and answer concisely." > agents/reviewer/CLAUDE.md
   ```

3. **Declare the agent** in your stack:

   ```ts
   import { App, Stack } from 'aws-cdk-lib';
   import * as lambda from 'aws-cdk-lib/aws-lambda';
   import * as s3 from 'aws-cdk-lib/aws-s3';
   import { C3Agent } from 'c3-aws';

   const app = new App();
   const stack = new Stack(app, 'Agents');

   const reviewer = new C3Agent(stack, 'Reviewer', {
     source: './agents/reviewer', // a normal Claude Code workspace
     model: 'sonnet',
   });

   // IAM only: lets Bash/SDK scripts inside Claude Code read these objects. No tool is created.
   const documents = new s3.Bucket(stack, 'Documents');
   reviewer.grant(documents, {
     actions: ['s3:ListBucket', 's3:GetObject'],
     prefixes: ['documents/*'],
   });

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

4. **Deploy** with the standard CDK commands:

   ```bash
   npx cdk synth
   npx cdk diff
   npx cdk deploy
   ```

5. **Invoke the agent** with the runtime ARN from the deployed stack (for example
   `reviewer.runtime.agentRuntimeArn`, which you can export as a `CfnOutput`):

   ```ts
   import { invokeAgent } from 'c3-aws/client';

   const result = await invokeAgent({ agentRuntimeArn, prompt: 'Review the latest report' });
   console.log(result.response);
   ```

6. **Clean up** when you are done: `npx cdk destroy`.

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
 └─ C3Agent
     ├─ ARM64 container: Claude Agent SDK (version-pinned) + your workspace + tiny HTTP adapter
     ├─ AgentCore Runtime (HTTP protocol) + execution role scoped to Claude models on Bedrock
     └─ AgentCore Gateway (IAM auth), created only when you call connect()
         └─ targets: your Lambda functions, or C3's audited S3 / DynamoDB / SQS / EventBridge adapters

invoke → AgentCore Runtime → Claude Agent SDK query() → Claude on Amazon Bedrock
                                  └─ MCP: c3-gateway → SigV4 proxy → AgentCore Gateway → tools
```

The adapter in [`runtime-assets/entrypoint`](runtime-assets/entrypoint) implements the
[AgentCore HTTP contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html)
(`POST /invocations`, `GET /ping`). For each request it calls `query()` from the official
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), which runs Claude Code with
your workspace's `CLAUDE.md`, settings, skills, subagents and hooks. It is glue code, not an agent loop. See [docs/architecture.md](docs/architecture.md).

## `grant()` vs `connect()`

|                                   | `agent.grant(resource, …)`                         | `agent.connect(resource, …)`                     |
| --------------------------------- | -------------------------------------------------- | ------------------------------------------------ |
| What it does                      | Adds IAM permissions to the agent's execution role | Makes specific operations available as MCP tools |
| Who calls AWS                     | Claude Code itself (Bash, AWS CLI, SDK scripts)    | A Gateway target (your Lambda, or a C3 adapter)  |
| Creates a tool                    | No                                                 | Yes, `mcp__c3-gateway__<name>___<tool>`          |
| Runtime role gets resource access | Yes, exactly the listed actions                    | No, only `bedrock-agentcore:InvokeGateway`       |

### Supported connections

| Resource                               | Tools                                    | Scope enforced by IAM and the adapter                           |
| -------------------------------------- | ---------------------------------------- | --------------------------------------------------------------- |
| `lambda.IFunction`                     | Your explicit schema(s)                  | Gateway role may invoke only that function                      |
| `s3.IBucket`                           | `list_objects`, `get_object` (read-only) | `prefixes` (required); `s3:prefix` condition; size caps         |
| `dynamodb.ITable`                      | `get_item`, `query` (read-only)          | Declared indexes, `dynamodb:LeadingKeys`, `dynamodb:Attributes` |
| `sqs.IQueue`                           | `send_message`                           | One queue, body size cap                                        |
| `events.IEventBus`                     | `put_event`                              | Fixed `source`, allow-listed `detailTypes`                      |
| OpenAPI (`connectOpenApi`)             | From the spec                            | Explicit outbound credentials                                   |
| Remote MCP server (`connectMcpServer`) | From the server                          | Credentials required                                            |

The full options and the IAM each connector creates are in [docs/connections.md](docs/connections.md).

## Configuration

```ts
new C3Agent(stack, 'Agent', {
  source: './agents/reviewer',
  model: ClaudeModel.fromInferenceProfileId('us.anthropic.claude-sonnet-4-6'), // pin for stability
  agentSdkVersion: '0.3.312', // @anthropic-ai/claude-agent-sdk; bundles Claude Code
  permissionMode: PermissionMode.DONT_ASK, // default: only pre-approved tools run
  allowedTools: ['Read', 'Grep'],
  maxBudgetUsd: 2, // per invocation
  outputSchema: { type: 'object', properties: { verdict: { type: 'string' } } }, // optional
  auditToolCalls: true, // default: log tool names and outcomes, never inputs or outputs
  invocationTimeout: Duration.minutes(15),
  installAwsCli: false,
  network: RuntimeNetworkConfiguration.usingVpc(stack, { vpc }),
  lifecycle: { idleRuntimeSessionTimeout: Duration.minutes(15) },
  platformVersion: PlatformVersion.V2, // opt in after checking regional support
  tracing: true,
  applicationLogs: { retention: RetentionDays.ONE_MONTH },
  sessionStorage: { bucket: sessionsBucket }, // optional durability across microVMs
});
```

## Invoking from code

`c3-aws/client` wraps `InvokeAgentRuntime` (it needs `@aws-sdk/client-bedrock-agentcore`, an optional peer
dependency):

```ts
import { invokeAgent, invokeAgentStream } from 'c3-aws/client';

const result = await invokeAgent({ agentRuntimeArn, prompt: 'Review the latest report' });
console.log(result.response, result.totalCostUsd);

// Continue the conversation and stream events as they happen.
for await (const event of invokeAgentStream({
  agentRuntimeArn,
  prompt: 'Now summarize',
  sessionId: result.sessionId,
})) {
  if (event.type === 'c3.result') console.log(event);
}
```

With `outputSchema` set on the agent, `result.structuredOutput` holds the validated object.

## Security model

- IAM has the final say. Claude Code permission rules are an extra layer on top of it, not a replacement.
- The defaults give no access to your AWS resources. Claude Code runs with `dontAsk`, so only tools
  that are pre-approved in your settings or `allowedTools` can run.
- Connected tools are read-only unless the connection is a write by nature (SQS, EventBridge), and
  even then it is scoped to one resource.
- C3 rejects environment variables that look like secrets, and its runtime adapter never logs prompts or model output. With `auditToolCalls` it logs only the
  name, outcome and duration of each tool call.
- Tool output and workspace files can carry prompt injection. Read [docs/security.md](docs/security.md).

## Costs

`cdk deploy` creates billable resources: AgentCore Runtime (per vCPU/GB-hour while sessions are
active), Bedrock model tokens, ECR image storage, CloudWatch Logs, and, when you call `connect()`,
AgentCore Gateway plus Lambda adapters. See [docs/costs.md](docs/costs.md). Run `cdk destroy` when
you are done.

## Documentation

- [Architecture](docs/architecture.md): components, request flow, identities
- [Connections](docs/connections.md): every connector, its options and the IAM it creates
- [Security](docs/security.md): permissions, secrets, prompt injection
- [Costs](docs/costs.md): what `cdk deploy` creates and bills
- [Limitations](docs/limitations.md): scope and known limitations

## Examples

- [`examples/hello-agent`](examples/hello-agent): the smallest deployable agent
- [`examples/lambda-tool`](examples/lambda-tool): a Lambda function exposed as an MCP tool
- [`examples/aws-data`](examples/aws-data): read-only S3 and DynamoDB tools, plus `grant()`

## Development

```bash
npm ci
npm run typecheck && npm run lint && npm test
npm run synth:examples
C3_INTEGRATION=1 AWS_PROFILE=dev npm run test:integration   # deploys real resources, opt-in
```

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Alejandro Santana. The Claude Agent SDK and the Claude Code binary it ships are not
distributed with this project; they are installed from npm under
[Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance) when you build the image.
See [NOTICE](NOTICE).
