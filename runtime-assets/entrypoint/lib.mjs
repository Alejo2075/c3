// Pure helpers for the C3 runtime entrypoint. Kept free of I/O so they can be
// unit tested without a container.
import { createHash } from 'node:crypto';

export const GATEWAY_SERVER_NAME = 'c3-gateway';
export const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';
export const MAX_PROMPT_BYTES = 256 * 1024;

const PERMISSION_MODES = new Set([
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan',
]);

/**
 * Read the runtime configuration from environment variables set by the
 * C3Agent construct.
 */
export function readConfig(env) {
  const permissionMode = env.C3_PERMISSION_MODE || 'dontAsk';
  if (!PERMISSION_MODES.has(permissionMode)) {
    throw new Error(`Unsupported C3_PERMISSION_MODE "${permissionMode}"`);
  }
  return {
    workspaceDir: env.C3_WORKSPACE_DIR || '/workspace',
    model: env.ANTHROPIC_MODEL || undefined,
    permissionMode,
    allowedTools: parseList(env.C3_ALLOWED_TOOLS),
    disallowedTools: parseList(env.C3_DISALLOWED_TOOLS),
    maxBudgetUsd: env.C3_MAX_BUDGET_USD ? Number(env.C3_MAX_BUDGET_USD) : undefined,
    timeoutSeconds: Number(env.C3_INVOCATION_TIMEOUT_SECONDS || 900),
    // The construct sets 'none' when no tools are connected.
    gatewayUrl:
      env.C3_GATEWAY_URL && env.C3_GATEWAY_URL !== 'none' ? env.C3_GATEWAY_URL : undefined,
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || env.C3_AWS_REGION || undefined,
    outputSchema: parseSchema(env.C3_OUTPUT_SCHEMA),
    auditToolCalls: env.C3_AUDIT_TOOL_CALLS !== 'false',
    sessionBucket: env.C3_SESSION_BUCKET || undefined,
    sessionPrefix: env.C3_SESSION_PREFIX || '',
  };
}

function parseSchema(value) {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('C3_OUTPUT_SCHEMA is not valid JSON');
  }
}

function parseList(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Validate an /invocations request body. Returns `{ prompt, stream }`. */
export function parseInvocation(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new RequestError('Request body must be a JSON object with a "prompt" string.');
  }
  if (typeof body.prompt !== 'string' || body.prompt.trim() === '') {
    throw new RequestError('"prompt" must be a non-empty string.');
  }
  if (Buffer.byteLength(body.prompt, 'utf8') > MAX_PROMPT_BYTES) {
    throw new RequestError(`"prompt" exceeds ${MAX_PROMPT_BYTES} bytes.`);
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw new RequestError('"stream" must be a boolean when provided.');
  }
  return { prompt: body.prompt, stream: body.stream === true };
}

export class RequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RequestError';
    this.statusCode = 400;
  }
}

/**
 * Claude Code requires a UUID for session IDs. AgentCore session IDs are
 * arbitrary strings, so derive a stable UUID from them.
 */
export function sessionUuid(agentCoreSessionId) {
  const hex = createHash('sha256').update(agentCoreSessionId).digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Where Claude Code stores a session transcript:
 * <home>/.claude/projects/<encoded cwd>/<id>.jsonl. The file is the only
 * reliable sign that a session can be resumed.
 */
export function sessionTranscriptPath(home, workspaceDir, sessionId) {
  const encoded = workspaceDir.replace(/[^a-zA-Z0-9]/g, '-');
  return `${home}/.claude/projects/${encoded}/${sessionId}.jsonl`;
}

/** MCP servers that reach the AgentCore Gateway through the SigV4 proxy. */
export function gatewayMcpServers(gatewayUrl, region) {
  const args = [gatewayUrl, '--service', 'bedrock-agentcore'];
  if (region) args.push('--region', region);
  return { [GATEWAY_SERVER_NAME]: { type: 'stdio', command: 'mcp-proxy-for-aws-cli', args } };
}

/**
 * Build the Claude Agent SDK `query()` options for one invocation. The SDK runs
 * the same Claude Code engine as the CLI, so the workspace's CLAUDE.md,
 * settings, skills, subagents and hooks load through `settingSources`.
 */
export function buildQueryOptions(
  config,
  { sessionId, resume, env, stream, abortController, hooks },
) {
  const options = {
    cwd: config.workspaceDir,
    env,
    abortController,
    // Same sources as the CLI, plus Claude Code's own system prompt so the
    // agent behaves as it does on a developer machine.
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    // "manual" is the CLI spelling of the SDK's "default" mode.
    permissionMode: config.permissionMode === 'manual' ? 'default' : config.permissionMode,
    includePartialMessages: stream,
  };
  if (hooks) options.hooks = hooks;
  if (config.outputSchema)
    options.outputFormat = { type: 'json_schema', schema: config.outputSchema };
  if (config.permissionMode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;
  if (config.model) options.model = config.model;

  const allowedTools = [...config.allowedTools];
  if (config.gatewayUrl) {
    options.mcpServers = gatewayMcpServers(config.gatewayUrl, config.region);
    // Connecting a resource is the explicit opt-in for its tools.
    allowedTools.push(`mcp__${GATEWAY_SERVER_NAME}`);
  }
  if (allowedTools.length > 0) options.allowedTools = allowedTools;
  if (config.disallowedTools.length > 0) options.disallowedTools = config.disallowedTools;
  if (config.maxBudgetUsd !== undefined && Number.isFinite(config.maxBudgetUsd)) {
    options.maxBudgetUsd = config.maxBudgetUsd;
  }
  if (sessionId) {
    if (resume) options.resume = sessionId;
    else options.sessionId = sessionId;
  }
  return options;
}

/**
 * Reduce the Agent SDK messages to the final invocation result.
 * The last `result` event carries the answer, cost and usage.
 */
export function summarize(events) {
  const result = [...events].reverse().find((event) => event && event.type === 'result');
  if (!result) {
    return { status: 'error', response: '', error: 'Claude Code exited without a result event.' };
  }
  return {
    status: result.is_error || result.subtype !== 'success' ? 'error' : 'success',
    response: typeof result.result === 'string' ? result.result : '',
    error: result.subtype !== 'success' ? `Claude Code stopped: ${result.subtype}.` : undefined,
    sessionId: result.session_id,
    numTurns: result.num_turns,
    durationMs: result.duration_ms,
    totalCostUsd: result.total_cost_usd,
    usage: result.usage,
    structuredOutput: result.structured_output,
  };
}

/**
 * Agent SDK hooks that log which tools ran, how they ended and how long they
 * took. Tool inputs, outputs and error text are deliberately never logged: they
 * can contain customer data or secrets.
 */
export function auditHooks(log) {
  const record = (event, outcome) => async (input) => {
    log(event, {
      tool: input.tool_name,
      outcome,
      durationMs: input.duration_ms,
      interrupted: input.is_interrupt,
    });
    return {};
  };
  return {
    PostToolUse: [{ hooks: [record('tool.call', 'ok')] }],
    PostToolUseFailure: [{ hooks: [record('tool.call', 'failed')] }],
    PermissionDenied: [{ hooks: [record('tool.call', 'denied')] }],
  };
}
