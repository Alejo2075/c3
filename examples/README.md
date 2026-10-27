# Examples

Each example is an ordinary CDK app. Inside this repository, they import `c3-aws` straight from
`src/` through the root `tsconfig.json`. In your own project, run `npm install c3-aws` instead.

| Example | Shows | Billable resources |
|---|---|---|
| [hello-agent](hello-agent) | The smallest agent | Runtime, ECR, Bedrock tokens |
| [lambda-tool](lambda-tool) | A Lambda function exposed as an MCP tool | + Gateway, Lambda |
| [aws-data](aws-data) | Read-only S3 and DynamoDB tools, plus `grant()` | + S3, DynamoDB, adapters |

```bash
cd examples/hello-agent
npx cdk synth                      # no credentials needed
npx cdk deploy                     # needs Docker, a bootstrapped account and Bedrock model access
node ../../scripts/invoke.mjs <AgentRuntimeArn> "What can you do?"
npx cdk destroy
```

Before deploying, open the Amazon Bedrock console and submit the Anthropic use case form for your
account, as described in
[Claude Code on Amazon Bedrock](https://code.claude.com/docs/en/amazon-bedrock).
