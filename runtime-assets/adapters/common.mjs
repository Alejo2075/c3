// Shared helpers for C3 Gateway Lambda adapters. Adapters only use the AWS SDK
// for JavaScript v3 bundled with the Node.js Lambda runtime.

const DELIMITER = '___';

/** Configuration written by the construct at synth time. */
export function loadConfig() {
  const raw = process.env.C3_ADAPTER_CONFIG;
  if (!raw) throw new Error('C3_ADAPTER_CONFIG is not set');
  return JSON.parse(raw);
}

/** Strip the `<target>___` prefix AgentCore Gateway adds to tool names. */
export function toolNameFrom(context) {
  const full = context?.clientContext?.custom?.bedrockAgentCoreToolName;
  if (typeof full !== 'string') return undefined;
  const index = full.indexOf(DELIMITER);
  return index === -1 ? full : full.slice(index + DELIMITER.length);
}

/** Errors the agent can fix by changing its input. Returned, not thrown. */
export class ToolInputError extends Error {}

export function toolError(message) {
  return { error: message };
}

/**
 * Run a tool implementation, converting input errors into tool output so the
 * agent sees why the call was rejected. Other errors are logged without
 * request payloads and returned as a generic failure.
 */
export async function dispatch(tools, event, context) {
  const name = toolNameFrom(context);
  const tool = name ? tools[name] : undefined;
  if (!tool) return toolError(`Unknown tool "${name ?? ''}".`);
  try {
    return await tool(event ?? {});
  } catch (err) {
    if (err instanceof ToolInputError) return toolError(err.message);
    console.error(
      JSON.stringify({
        event: 'adapter.error',
        tool: name,
        errorName: err?.name,
        message: err?.message,
      }),
    );
    if (err?.name === 'AccessDenied' || err?.name === 'AccessDeniedException') {
      return toolError('Access denied by IAM for this resource.');
    }
    return toolError(`The tool failed (${err?.name ?? 'Error'}).`);
  }
}

export function requireString(input, field, { maxLength = 1024, optional = false } = {}) {
  const value = input[field];
  if (value === undefined || value === null || value === '') {
    if (optional) return undefined;
    throw new ToolInputError(`"${field}" is required.`);
  }
  if (typeof value !== 'string') throw new ToolInputError(`"${field}" must be a string.`);
  if (value.length > maxLength)
    throw new ToolInputError(`"${field}" must be at most ${maxLength} characters.`);
  return value;
}

export function optionalInteger(input, field, { min, max, fallback }) {
  const value = input[field];
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ToolInputError(`"${field}" must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function encodeToken(value) {
  return value === undefined
    ? undefined
    : Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeToken(token) {
  if (token === undefined) return undefined;
  try {
    return JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new ToolInputError('"nextToken" is not valid.');
  }
}
