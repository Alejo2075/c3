# hello-agent

The smallest C3 deployment: a Claude Code workspace (`agents/hello`) running on AgentCore Runtime.
It can only use `Read`, `Glob` and `Grep`, has a $1 budget per invocation, and has no AWS resource
access.

```bash
npx cdk deploy
node ../../scripts/invoke.mjs <AgentRuntimeArn> "What files are in your workspace?"
npx cdk destroy
```
