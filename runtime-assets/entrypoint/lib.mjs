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
 * ClaudeCodeAgent construct.
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
    sessionBucket: env.C3_SESSION_BUCKET || undefined,
    sessionPrefix: env.C3_SESSION_PREFIX || '',
  };
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
 * Claude Code requires a UUID for --session-id. AgentCore session IDs are
 * arbitrary strings, so derive a stable UUID from them.
 */
export function sessionUuid(agentCoreSessionId) {
  const hex = createHash('sha256').update(agentCoreSessionId).digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** MCP configuration that reaches the AgentCore Gateway through the SigV4 proxy. */
export function gatewayMcpConfig(gatewayUrl, region) {
  const args = [gatewayUrl, '--service', 'bedrock-agentcore'];
  if (region) args.push('--region', region);
  return {
    mcpServers: {
      [GATEWAY_SERVER_NAME]: {
        command: 'mcp-proxy-for-aws-cli',
        args,
      },
    },
  };
}

/** Build the argument list for a noninteractive Claude Code invocation. */
export function buildClaudeArgs(config, { prompt, sessionId, resume, mcpConfigPath }) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
  args.push('--permission-mode', config.permissionMode);
  if (config.model) args.push('--model', config.model);

  const allowed = [...config.allowedTools];
  if (mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath);
    // Connecting a resource is the explicit opt-in for its tools.
    allowed.push(`mcp__${GATEWAY_SERVER_NAME}`);
  }
  if (allowed.length > 0) args.push('--allowedTools', allowed.join(','));
  if (config.disallowedTools.length > 0)
    args.push('--disallowedTools', config.disallowedTools.join(','));
  if (config.maxBudgetUsd !== undefined && Number.isFinite(config.maxBudgetUsd)) {
    args.push('--max-budget-usd', String(config.maxBudgetUsd));
  }
  if (sessionId) {
    args.push(resume ? '--resume' : '--session-id', sessionId);
  }
  return args;
}

/**
 * Reduce Claude Code's stream-json events to the final invocation result.
 * The last `result` event carries the answer, cost and usage.
 */
export function summarize(events) {
  const result = [...events].reverse().find((event) => event && event.type === 'result');
  if (!result) {
    return { status: 'error', response: '', error: 'Claude Code exited without a result event.' };
  }
  return {
    status: result.is_error ? 'error' : 'success',
    response: typeof result.result === 'string' ? result.result : '',
    sessionId: result.session_id,
    numTurns: result.num_turns,
    durationMs: result.duration_ms,
    totalCostUsd: result.total_cost_usd,
    usage: result.usage,
  };
}

/** Split a chunk stream into complete lines, returning the unfinished tail. */
export function splitLines(buffer, chunk) {
  const text = buffer + chunk;
  const lines = text.split('\n');
  const rest = lines.pop() ?? '';
  return { lines: lines.filter((line) => line.trim() !== ''), rest };
}
