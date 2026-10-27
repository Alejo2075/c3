// Optional session durability: archives Claude Code's session history and the
// workspace to S3 after each invocation and restores them when a session lands
// on a fresh microVM. Enabled only when C3_SESSION_BUCKET is set.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

let s3Module;
async function s3() {
  s3Module ??= await import('@aws-sdk/client-s3');
  return s3Module;
}

function objectKey(config, sessionId) {
  return `${config.sessionPrefix}${sessionId}.tar.gz`;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} failed: ${stderr}`)),
    );
    child.on('error', reject);
  });
}

export async function restoreSession(config, sessionId) {
  const { S3Client, GetObjectCommand } = await s3();
  const client = new S3Client({ region: config.region });
  const archive = join(tmpdir(), `${sessionId}.tar.gz`);
  try {
    const result = await client.send(
      new GetObjectCommand({ Bucket: config.sessionBucket, Key: objectKey(config, sessionId) }),
    );
    await pipeline(result.Body, createWriteStream(archive));
    await run('tar', ['-xzf', archive, '-C', '/']);
  } catch (err) {
    if (err?.name !== 'NoSuchKey') {
      process.stdout.write(
        `${JSON.stringify({ event: 'session.restore.error', sessionId, error: err.message })}\n`,
      );
    }
  } finally {
    rmSync(archive, { force: true });
  }
}

export async function saveSession(config, sessionId) {
  const { S3Client, PutObjectCommand } = await s3();
  const client = new S3Client({ region: config.region });
  const archive = join(tmpdir(), `${sessionId}.tar.gz`);
  const paths = [config.workspaceDir, join(homedir(), '.claude', 'projects')].filter((p) =>
    existsSync(p),
  );
  try {
    await run('tar', ['-czf', archive, '-P', ...paths]);
    await client.send(
      new PutObjectCommand({
        Bucket: config.sessionBucket,
        Key: objectKey(config, sessionId),
        Body: readFileSync(archive),
      }),
    );
  } catch (err) {
    process.stdout.write(
      `${JSON.stringify({ event: 'session.save.error', sessionId, error: err.message })}\n`,
    );
  } finally {
    rmSync(archive, { force: true });
  }
}
