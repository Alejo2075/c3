# Connections

`connect()` exposes specific operations as MCP tools through Amazon Bedrock AgentCore Gateway.
The first call creates one gateway per agent, which only the agent's execution role can call
(`AWS_IAM` inbound authorization). Claude Code sees each tool as:

```
mcp__c3-gateway__<target>___<tool>
```

`<target>` is the connection `name`, with `_` replaced by `-` because Gateway target names allow
only letters, digits and hyphens. Connected tools are added to `--allowedTools` automatically:
calling `connect()` is your opt-in.

Each section below lists the operations, IAM, schemas, errors and limits of one connector.

## Lambda functions (your own code)

```ts
agent.connect(fn, {
  name: 'send_notification',
  description: 'Send a user notification',
  inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  outputSchema: { type: 'object', properties: { id: { type: 'string' } } },
});

// several tools in one function
agent.connect(fn, { name: 'tickets', tools: [{ name: 'create', … }, { name: 'close', … }] });
```

- **Event**: the tool arguments. **Context**: `context.clientContext.custom.bedrockAgentCoreToolName`
  is `<target>___<tool>`, plus `bedrockAgentCoreGatewayId` and related IDs.
- **IAM**: the Gateway service role gets `lambda:InvokeFunction` on the function only.
- **Schemas**: C3 validates them at synth time. Supported types are `string`, `number`,
  `integer`, `boolean`, `array` (with `items`) and `object`. The top level must be an object.
- **Errors**: return a JSON object such as `{ "error": "…" }` so the agent can correct itself.

## S3 buckets: `list_objects`, `get_object`

```ts
agent.connect(bucket, { name: 'docs', prefixes: ['reports/'], maxObjectBytes: 256 * 1024, maxKeys: 100 });
```

| | |
|---|---|
| IAM | `s3:ListBucket` on the bucket with `StringLike s3:prefix = <prefix>*`; `s3:GetObject` on `<bucket>/<prefix>*`; `kms:Decrypt` if the bucket has a CMK. |
| Inputs | `list_objects { prefix?, maxKeys?, nextToken? }`, `get_object { key, maxBytes? }` |
| Output | Text up to `maxObjectBytes`, with `truncated`. Binary objects return metadata only. |
| Limits | Read-only. `prefixes` is required: `['*']` means the whole bucket. No versioned reads. |

## DynamoDB tables: `get_item`, `query`

```ts
agent.connect(table, {
  name: 'orders',
  indexes: ['byStatus'],
  partitionKeyPrefixes: ['TENANT#acme'],
  attributes: ['status', 'total'],
  maxItems: 25,
});
```

| | |
|---|---|
| IAM | `dynamodb:GetItem` and `dynamodb:Query` on the table, plus `dynamodb:Query` on each declared index. `ForAllValues:StringLike dynamodb:LeadingKeys` when `partitionKeyPrefixes` is set. `ForAllValues:StringEquals dynamodb:Attributes` and `dynamodb:Select = SPECIFIC_ATTRIBUTES` when `attributes` is set (key attributes are added automatically). `kms:Decrypt` for a CMK. |
| Inputs | `get_item { partitionKey, sortKey? }`, `query { partitionKey, sortKeyCondition?, indexName?, limit?, descending?, nextToken? }` |
| Limits | Read-only. No `Scan`. String and number keys only (no binary, no multi-attribute keys). Imported tables need `keySchema`, and each of their indexes needs its own key schema. `partitionKeyPrefixes` applies to the base table: only declare indexes the agent may read in full. |

## SQS queues: `send_message`

`agent.connect(queue, { name: 'jobs', maxBodyBytes: 64 * 1024 })`. IAM comes from
`queue.grantSendMessages`. FIFO queues require `messageGroupId`.

## EventBridge buses: `put_event`

```ts
agent.connect(bus, { name: 'events', source: 'com.example.reviewer', detailTypes: ['ReviewCompleted'] });
```

IAM allows `events:PutEvents` on the bus, but only when `events:source` equals `source` and every
`events:detail-type` is in `detailTypes`. The `detail` field must be a JSON object string.

## OpenAPI and remote MCP servers

`agent.connectOpenApi({ name, schema: ApiSchema.fromLocalAsset(...), credentialProviders })` and
`agent.connectMcpServer({ name, endpoint, credentialProviders })` are thin wrappers around the
official Gateway targets. Supply credentials through AgentCore Identity (`GatewayCredentialProvider`);
never put credentials in the schema.

## Adapter implementation

The adapters live in [`runtime-assets/adapters`](../runtime-assets/adapters). They are short,
dependency-free ES modules that use the AWS SDK bundled with the Node.js 22 Lambda runtime (ARM64,
30 s timeout, 256 MB). They validate inputs, cap output sizes and return input errors as
`{ "error": "…" }` tool results. Unexpected errors are logged by name only, without payloads.
