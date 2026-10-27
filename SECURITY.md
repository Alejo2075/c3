# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/Alejo2075/c3/security/advisories/new).
Include the affected version, the impact, and steps to reproduce. You should get an acknowledgement
within 5 business days.

In scope: the construct's IAM, gateway and authentication wiring; the runtime entrypoint; the tool
adapters; and packaging (for example, secrets leaking into images).

Out of scope: vulnerabilities in Claude Code, Amazon Bedrock, AgentCore or other upstream
services. Report those to Anthropic or AWS directly.

## Supported versions

Only the latest `0.x` release receives security fixes.

See [docs/security.md](docs/security.md) for the security model.
