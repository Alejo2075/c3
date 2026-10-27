import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentRuntimeArtifact } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { copyWorkspace, type WorkspaceInspection } from '../workspace/workspace';

/**
 * Claude Code version installed in the runtime image unless overridden.
 * Bumped deliberately in C3 releases after testing.
 */
export const DEFAULT_CLAUDE_CODE_VERSION = '2.1.311';

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
  readonly claudeCodeVersion: string;
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
    fs.rmSync(contextDir, { recursive: true, force: true });
    for (const file of RUNTIME_ASSET_FILES) {
      const target = path.join(contextDir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(RUNTIME_ASSETS_DIR, file), target);
    }
    fs.mkdirSync(path.join(contextDir, 'workspace'), { recursive: true });
    copyWorkspace(options.workspace, path.join(contextDir, 'workspace'));
    fs.writeFileSync(path.join(contextDir, '.complete'), '');
  }

  const artifact = AgentRuntimeArtifact.fromAsset(contextDir, {
    platform: Platform.LINUX_ARM64,
    exclude: ['.complete'],
    buildArgs: {
      CLAUDE_CODE_VERSION: options.claudeCodeVersion,
      MCP_PROXY_FOR_AWS_VERSION,
      INSTALL_AWS_CLI: String(options.installAwsCli),
    },
  });
  return { artifact, contextDir };
}
