# aws-data

An analyst agent with:

- `docs` tools (`list_objects`, `get_object`) limited to `reports/` in an S3 bucket;
- `orders` tools (`get_item`, `query`) limited to partition keys starting with `TENANT#acme`, and
  returning only `status`, `total` and `createdAt` plus key attributes;
- a plain IAM `grant()` to read `reports/public/`, for scripts the agent runs itself.

Seed some data after deploying:

```bash
aws s3 cp report.md s3://<DocumentsBucket>/reports/2026-q3.md
aws dynamodb put-item --table-name <OrdersTable> \
  --item '{"pk":{"S":"TENANT#acme"},"sk":{"S":"ORDER#1"},"status":{"S":"paid"},"total":{"N":"42"}}'
node ../../scripts/invoke.mjs <AgentRuntimeArn> "Summarize the Q3 report and list paid orders"
```

The bucket and table use `RemovalPolicy.DESTROY` because this is an example. Do not copy that
setting to production data.
