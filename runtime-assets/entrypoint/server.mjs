// C3 runtime entrypoint: implements the AgentCore Runtime HTTP contract
// (POST /invocations, GET /ping on 0.0.0.0:8080) and forwards each request to
// the official Claude Code CLI in noninteractive mode. This is integration
// glue only; the agent loop is Claude Code's.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  RequestError,
  SESSION_HEADER,
  buildClaudeArgs,
  gatewayMcpConfig,
  parseInvocation,
  readConfig,
  sessionUuid,
  splitLines,
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

const mcpConfigPath = config.gatewayUrl ? writeMcpConfig() : undefined;

function writeMcpConfig() {
  const dir = join(homedir(), '.c3');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'gateway-mcp.json');
  writeFileSync(file, JSON.stringify(gatewayMcpConfig(config.gatewayUrl, config.region), null, 2));
  return file;
}

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
  // Claude Code stores sessions under ~/.claude/projects/<encoded cwd>/<id>.jsonl.
  const encoded = config.workspaceDir.replace(/[^a-zA-Z0-9]/g, '-');
  return existsSync(join(homedir(), '.claude', 'projects', encoded, `${id}.jsonl`));
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
  const resume = sessionId ? knownSessions.has(sessionId) || sessionHasHistory(sessionId) : false;
  const args = buildClaudeArgs(config, {
    prompt: request.prompt,
    sessionId,
    resume,
    mcpConfigPath,
  });

  const started = Date.now();
  log('invocation.start', { sessionId, resume, stream: request.stream });

  const child = spawn('claude', args, {
    cwd: config.workspaceDir,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timer = setTimeout(() => {
    log('invocation.timeout', { sessionId, timeoutSeconds: config.timeoutSeconds });
    child.kill('SIGTERM');
  }, config.timeoutSeconds * 1000);

  const events = [];
  let buffer = '';
  let stderr = '';

  if (request.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    const { lines, rest } = splitLines(buffer, chunk);
    buffer = rest;
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      events.push(event);
      if (request.stream) res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });

  const exitCode = await new Promise((resolve) => {
    child.on('close', resolve);
    child.on('error', (err) => {
      stderr += String(err);
      resolve(-1);
    });
  });
  clearTimeout(timer);

  if (sessionId) {
    knownSessions.add(sessionId);
    if (config.sessionBucket) await saveSession(config, sessionId);
  }

  const summary = summarize(events);
  if (exitCode !== 0 && summary.status === 'success') summary.status = 'error';
  if (summary.status === 'error' && !summary.error) {
    summary.error = `Claude Code exited with code ${exitCode}.`;
  }
  log('invocation.end', {
    sessionId,
    exitCode,
    status: summary.status,
    durationMs: Date.now() - started,
    totalCostUsd: summary.totalCostUsd,
    stderrTail: exitCode !== 0 ? stderr.slice(-1000) : undefined,
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
  log('server.listening', { port: PORT, gateway: Boolean(mcpConfigPath) }),
);
