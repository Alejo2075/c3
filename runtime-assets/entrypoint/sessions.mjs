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

/** Archive members are stored relative to "/" and must stay inside these trees. */
export function allowedArchivePaths(config) {
  return [config.workspaceDir, join(homedir(), '.claude', 'projects')].map((p) =>
    p.replace(/^\/+/, ''),
  );
}

/** True when every member is a relative path inside one of the allowed trees. */
export function isSafeArchiveListing(listing, allowed) {
  const members = listing.split('\n').filter(Boolean);
  return members.every((member) => {
    const clean = member.replace(/\/+$/, '');
    if (clean.startsWith('/') || clean.split('/').includes('..')) return false;
    return allowed.some((root) => clean === root || clean.startsWith(`${root}/`));
  });
}

function objectKey(config, sessionId) {
  return `${config.sessionPrefix}${sessionId}.tar.gz`;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${command} failed: ${stderr}`)),
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
    const listing = await run('tar', ['-tzf', archive]);
    if (!isSafeArchiveListing(listing, allowedArchivePaths(config))) {
      throw new Error('Session archive contains paths outside the workspace and session history.');
    }
    await run('tar', ['-xzf', archive, '-C', '/', '--no-same-owner', '--no-same-permissions']);
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
  const paths = allowedArchivePaths(config).filter((p) => existsSync(`/${p}`));
  try {
    await run('tar', ['-czf', archive, '-C', '/', ...paths]);
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
