# lambda-tool

Exposes `functions/notify` as an MCP tool named
`mcp__c3-gateway__send-notification___send_notification`. AgentCore Gateway authorizes the agent's
execution role with SigV4. The Gateway role is the only identity that can invoke the function.

```bash
npx cdk deploy
node ../../scripts/invoke.mjs <AgentRuntimeArn> "Notify on-call that the deploy finished"
aws logs tail /aws/lambda/<NotifyFunctionName> --since 10m
npx cdk destroy
```

The repository's opt-in integration test (`npm run test:integration`) deploys this exact example.
