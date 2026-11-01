import { randomUUID } from 'node:crypto';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { C3ValidationError } from './errors';

/** AgentCore requires runtime session IDs of at least 33 characters. */
const MIN_SESSION_ID_LENGTH = 33;

export interface InvokeAgentOptions {
  /** ARN of the runtime, for example `agent.runtime.agentRuntimeArn`. */
  readonly agentRuntimeArn: string;
  readonly prompt: string;
  /** Reuse the same ID to continue a conversation. @default a new `c3-<uuid>` */
  readonly sessionId?: string;
  /** Endpoint name to invoke. @default 'DEFAULT' */
  readonly qualifier?: string;
  /** Preconfigured client. @default a client for the region in the ARN */
  readonly client?: Pick<BedrockAgentCoreClient, 'send'>;
}

export interface InvokeResult {
  readonly status: 'success' | 'error';
  /** Claude Code's final answer. */
  readonly response: string;
  /** Pass it back as `sessionId` to continue the conversation. */
  readonly sessionId: string;
  readonly numTurns?: number;
  readonly durationMs?: number;
  readonly totalCostUsd?: number;
  readonly usage?: unknown;
  /** Set when the agent has an `outputSchema`. */
  readonly structuredOutput?: unknown;
  readonly error?: string;
}

/** An event relayed from the agent: Claude Agent SDK messages and a final `c3.result`. */
export interface AgentEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** Raised when the agent reports an error. The partial result is in `result`. */
export class C3InvocationError extends Error {
  constructor(
    message: string,
    readonly result: InvokeResult,
  ) {
    super(`[c3-aws] ${message}`);
    this.name = 'C3InvocationError';
  }
}

function prepare(options: InvokeAgentOptions, stream: boolean) {
  const arn = options.agentRuntimeArn;
  const region = arn.split(':')[3];
  if (!arn.startsWith('arn:') || !region) {
    throw new C3ValidationError(`"${arn}" is not an AgentCore runtime ARN.`);
  }
  if (options.prompt.trim() === '') throw new C3ValidationError('"prompt" must not be empty.');
  const sessionId = options.sessionId ?? `c3-${randomUUID()}`;
  if (sessionId.length < MIN_SESSION_ID_LENGTH) {
    throw new C3ValidationError(
      `"sessionId" must have at least ${MIN_SESSION_ID_LENGTH} characters (got ${sessionId.length}).`,
    );
  }
  const client = options.client ?? new BedrockAgentCoreClient({ region });
  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: arn,
    qualifier: options.qualifier,
    runtimeSessionId: sessionId,
    contentType: 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
    payload: Buffer.from(JSON.stringify({ prompt: options.prompt, stream })),
  });
  return { client, command, sessionId };
}

async function* chunksOf(body: unknown): AsyncGenerator<string> {
  if (body && typeof body === 'object' && Symbol.asyncIterator in body) {
    const decoder = new TextDecoder();
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      yield decoder.decode(chunk, { stream: true });
    }
    return;
  }
  const readable = body as { transformToString?: () => Promise<string> } | undefined;
  if (readable?.transformToString) yield await readable.transformToString();
}

/** Parse Server-Sent Events carrying one JSON object per `data:` line. */
export async function* parseEvents(chunks: AsyncIterable<string>): AsyncGenerator<AgentEvent> {
  let buffer = '';
  const emit = function* (line: string): Generator<AgentEvent> {
    if (!line.startsWith('data:')) return;
    const json = line.slice(5).trim();
    if (!json) return;
    try {
      yield JSON.parse(json) as AgentEvent;
    } catch {
      // Ignore malformed frames.
    }
  };
  for await (const chunk of chunks) {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) yield* emit(line);
  }
  yield* emit(buffer);
}

function toResult(raw: Record<string, unknown>, sessionId: string): InvokeResult {
  return {
    status: raw.status === 'success' ? 'success' : 'error',
    response: typeof raw.response === 'string' ? raw.response : '',
    sessionId,
    numTurns: raw.numTurns as number | undefined,
    durationMs: raw.durationMs as number | undefined,
    totalCostUsd: raw.totalCostUsd as number | undefined,
    usage: raw.usage,
    structuredOutput: raw.structuredOutput,
    error: raw.error as string | undefined,
  };
}

/**
 * Invoke a deployed C3 agent once and wait for the answer.
 * Throws `C3InvocationError` when the agent reports an error.
 */
export async function invokeAgent(options: InvokeAgentOptions): Promise<InvokeResult> {
  const { client, command, sessionId } = prepare(options, false);
  const output = await client.send(command);
  let text = '';
  for await (const chunk of chunksOf(output.response)) text += chunk;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new C3InvocationError(
      'The runtime returned a response that is not JSON.',
      toResult({ status: 'error', error: 'Invalid response' }, sessionId),
    );
  }
  const result = toResult(raw, sessionId);
  if (result.status !== 'success') {
    throw new C3InvocationError(result.error ?? 'The agent reported an error.', result);
  }
  return result;
}

/**
 * Invoke a deployed C3 agent and stream its events as they happen. The last
 * event has `type: 'c3.result'` and the fields of `InvokeResult`.
 */
export async function* invokeAgentStream(options: InvokeAgentOptions): AsyncGenerator<AgentEvent> {
  const { client, command } = prepare(options, true);
  const output = await client.send(command);
  yield* parseEvents(chunksOf(output.response));
}
