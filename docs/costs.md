# Costs

C3 has no hosted component and charges nothing. Everything it deploys runs in your AWS account and
is billed by AWS. Check current prices on the AWS pricing pages; the list below says what is
provisioned and when.

| Resource | Created when | Billed for |
|---|---|---|
| Amazon Bedrock AgentCore Runtime | Always | vCPU and memory while sessions are active (sessions stay alive until the idle timeout, default 15 min) |
| Amazon Bedrock model inference | On every invocation | Input/output/cache tokens of the Claude model you choose. Unpinned `opus` costs more than `sonnet`. |
| Amazon ECR (CDK assets repository) | Always | Image storage (the image is several hundred MB) |
| Amazon CloudWatch Logs | Always (runtime stdout), plus `applicationLogs` | Ingestion and storage |
| AWS X-Ray | `tracing: true` | Traces |
| Amazon Bedrock AgentCore Gateway | First `connect()` call | Tool invocations and search (semantic tool search is enabled by default on Gateway) |
| AWS Lambda (adapters and your functions) | `connect()` | Invocations and duration |
| Amazon S3 | `sessionStorage` | Archive storage and requests |

## Keeping costs predictable

- Set `maxBudgetUsd` so each invocation has a spend cap enforced by Claude Code.
- Pin a model (`ClaudeModel.fromInferenceProfileId(...)`) instead of relying on aliases.
- Lower `lifecycle.idleRuntimeSessionTimeout` if sessions are short.
- Run `npx cdk destroy` for experiments. The CDK bootstrap ECR repository keeps old images: add a
  lifecycle rule or clean it periodically.
