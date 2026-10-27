#!/usr/bin/env node
// Synthesize every example app. No AWS credentials or Docker are needed:
// container images are built only by `cdk deploy`.
import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const cdk = join(root, 'node_modules', 'aws-cdk', 'bin', 'cdk');
for (const name of readdirSync(join(root, 'examples'))) {
  const dir = join(root, 'examples', name);
  if (!existsSync(join(dir, 'cdk.json'))) continue;
  console.log(`\n> cdk synth (${name})`);
  execFileSync(process.execPath, [cdk, 'synth', '--quiet'], {
    cwd: dir,
    stdio: 'inherit',
    env: { ...process.env, CDK_DISABLE_VERSION_CHECK: '1' },
  });
}
