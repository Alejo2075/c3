// C3 runtime entrypoint: implements the AgentCore Runtime HTTP contract
// (POST /invocations, GET /ping on 0.0.0.0:8080) and forwards each request to
// the official Claude Agent SDK (`query()`), which runs Claude Code. This is
// integration glue only; the agent loop is Claude Code's.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import {
  RequestError,
  SESSION_HEADER,
  auditHooks,
  buildQueryOptions,
  parseInvocation,
  readConfig,
  sessionTranscriptPath,
  sessionUuid,
  summarize,
} from './lib.mjs';
import { restoreSession, saveSession } from './sessions.mjs';

const PORT = 8080;
const MAX_BODY_BYTES = 1024 * 1024;

const config = readConfig(process.env);
// Claude Code falls back to us-east-1 when no region is set.
if (!process.env.AWS_REGION && config.region) process.env.AWS_REGION = config.region;
const knownSessions = new Set();
let busy = false;
let statusChangedAt = Math.floor(Date.now() / 1000);

// Time between asking the SDK to interrupt a turn and killing the process.
const INTERRUPT_GRACE_MS = 10_000;

function setBusy(value) {
  if (busy !== value) {
    busy = value;
    statusChangedAt = Math.floor(Date.now() / 1000);
  }
}

function log(event, fields = {}) {
  // Never log prompts or model output; they can contain sensitive data.
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RequestError(`Request body exceeds ${MAX_BODY_BYTES} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new RequestError('Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function sessionHasHistory(id) {
  return existsSync(sessionTranscriptPath(homedir(), config.workspaceDir, id));
}

async function invoke(req, res) {
  const request = parseInvocation(await readBody(req));
  const agentCoreSession = req.headers[SESSION_HEADER];
  const sessionId =
    typeof agentCoreSession === 'string' && agentCoreSession
      ? sessionUuid(agentCoreSession)
      : undefined;

  if (sessionId && config.sessionBucket && !knownSessions.has(sessionId)) {
    await restoreSession(config, sessionId);
  }
  // Resume only when Claude Code wrote a transcript: a turn that failed before
  // writing one leaves nothing to resume.
  const resume = sessionId ? sessionHasHistory(sessionId) : false;
  const abortController = new AbortController();
  let stderr = '';
  const options = buildQueryOptions(config, {
    sessionId,
    resume,
    env: { ...process.env },
    stream: request.stream,
    abortController,
    hooks: config.auditToolCalls ? auditHooks(log) : undefined,
  });
  options.stderr = (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  };

  const started = Date.now();
  log('invocation.start', { sessionId, resume, stream: request.stream });

  if (request.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  }

  const run = query({ prompt: request.prompt, options });
  // Interrupt first so the turn ends with a result (and its cost); abort only
  // if the process does not stop in time.
  let hardKill;
  const timer = setTimeout(() => {
    log('invocation.timeout', { sessionId, timeoutSeconds: config.timeoutSeconds });
    run.interrupt().catch(() => {});
    hardKill = setTimeout(() => abortController.abort(), INTERRUPT_GRACE_MS);
  }, config.timeoutSeconds * 1000);

  const results = [];
  let failure;
  try {
    for await (const message of run) {
      if (message.type === 'result') results.push(message);
      if (request.stream) res.write(`data: ${JSON.stringify(message)}\n\n`);
    }
  } catch (err) {
    failure = err;
  } finally {
    clearTimeout(timer);
    clearTimeout(hardKill);
  }

  if (sessionId && sessionHasHistory(sessionId)) {
    // Skip the S3 restore on later turns handled by this container.
    knownSessions.add(sessionId);
    if (config.sessionBucket) await saveSession(config, sessionId);
  }

  const summary = summarize(results);
  if (failure && summary.status === 'success') summary.status = 'error';
  if (summary.status === 'error' && failure) summary.error = 'Claude Code stopped unexpectedly.';
  log('invocation.end', {
    sessionId,
    status: summary.status,
    durationMs: Date.now() - started,
    totalCostUsd: summary.totalCostUsd,
    errorName: failure?.name,
    stderrTail: summary.status === 'error' ? stderr.slice(-1000) : undefined,
  });

  if (request.stream) {
    res.write(`data: ${JSON.stringify({ type: 'c3.result', ...summary })}\n\n`);
    res.end();
  } else {
    res.writeHead(summary.status === 'success' ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(summary));
  }
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: busy ? 'HealthyBusy' : 'Healthy',
        time_of_last_update: statusChangedAt,
      }),
    );
    return;
  }
  if (req.method === 'POST' && req.url === '/invocations') {
    if (busy) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'error',
          error: 'An invocation is already running in this session.',
        }),
      );
      return;
    }
    setBusy(true);
    invoke(req, res)
      .catch((err) => {
        const statusCode = err instanceof RequestError ? 400 : 500;
        log('invocation.error', { statusCode, error: err.message });
        if (!res.headersSent) {
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: err.message }));
        } else {
          res.end();
        }
      })
      .finally(() => setBusy(false));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'error', error: 'Not found' }));
});

server.requestTimeout = 0;
server.listen(PORT, '0.0.0.0', () =>
  log('server.listening', { port: PORT, gateway: Boolean(config.gatewayUrl) }),
);
