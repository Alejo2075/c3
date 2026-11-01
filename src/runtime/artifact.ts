import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentRuntimeArtifact } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { copyWorkspace, type WorkspaceInspection } from '../workspace/workspace';

/**
 * `@anthropic-ai/claude-agent-sdk` version installed in the runtime image
 * unless overridden. The SDK bundles the Claude Code binary (0.3.312 ships
 * Claude Code 2.1.312). Bumped deliberately in C3 releases after testing.
 */
export const DEFAULT_AGENT_SDK_VERSION = '0.3.312';

/** Version of the AWS-maintained SigV4 MCP proxy installed in the image. */
export const MCP_PROXY_FOR_AWS_VERSION = '1.7.0';

/** Directory that holds the Dockerfile and entrypoint shipped with C3. */
export const RUNTIME_ASSETS_DIR = path.resolve(__dirname, '..', '..', 'runtime-assets');

const RUNTIME_ASSET_FILES = [
  'Dockerfile',
  'entrypoint/lib.mjs',
  'entrypoint/package-lock.json',
  'entrypoint/package.json',
  'entrypoint/server.mjs',
  'entrypoint/sessions.mjs',
];

export interface RuntimeArtifactOptions {
  readonly workspace: WorkspaceInspection;
  readonly agentSdkVersion: string;
  readonly installAwsCli: boolean;
  /** Parent directory for build contexts. Defaults to the OS temp directory. */
  readonly stagingRoot?: string;
}

export interface StagedRuntimeArtifact {
  readonly artifact: AgentRuntimeArtifact;
  /** Docker build context directory. */
  readonly contextDir: string;
}

/**
 * Assemble a deterministic Docker build context (C3 runtime files plus a copy
 * of the workspace) and reference it as an ARM64 AgentCore runtime artifact.
 * The image is built and pushed by the CDK toolchain during `cdk deploy`.
 */
export function stageRuntimeArtifact(options: RuntimeArtifactOptions): StagedRuntimeArtifact {
  const hash = crypto.createHash('sha256');
  hash.update(options.workspace.fingerprint);
  for (const file of RUNTIME_ASSET_FILES) {
    hash.update(file);
    hash.update(fs.readFileSync(path.join(RUNTIME_ASSETS_DIR, file)));
  }
  const digest = hash.digest('hex').slice(0, 32);
  const contextDir = path.join(options.stagingRoot ?? path.join(os.tmpdir(), 'c3-build'), digest);

  if (!fs.existsSync(path.join(contextDir, '.complete'))) {
    // Stage in a private directory and rename it into place, so concurrent
    // synths (or test workers) never observe or delete a half-written context.
    const stagingDir = `${contextDir}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      for (const file of RUNTIME_ASSET_FILES) {
        const target = path.join(stagingDir, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(RUNTIME_ASSETS_DIR, file), target);
      }
      fs.mkdirSync(path.join(stagingDir, 'workspace'), { recursive: true });
      copyWorkspace(options.workspace, path.join(stagingDir, 'workspace'));
      fs.writeFileSync(path.join(stagingDir, '.complete'), '');
      try {
        fs.renameSync(stagingDir, contextDir);
      } catch {
        // Another process finished first, or an incomplete directory is in the way.
        if (!fs.existsSync(path.join(contextDir, '.complete'))) {
          fs.rmSync(contextDir, { recursive: true, force: true });
          fs.renameSync(stagingDir, contextDir);
        }
      }
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  const artifact = AgentRuntimeArtifact.fromAsset(contextDir, {
    platform: Platform.LINUX_ARM64,
    exclude: ['.complete'],
    buildArgs: {
      CLAUDE_AGENT_SDK_VERSION: options.agentSdkVersion,
      MCP_PROXY_FOR_AWS_VERSION,
      INSTALL_AWS_CLI: String(options.installAwsCli),
    },
  });
  return { artifact, contextDir };
}
