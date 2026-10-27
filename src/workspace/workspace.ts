import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { C3ValidationError } from '../errors';

/**
 * Paths that are never copied into the deployed artifact, relative to the
 * workspace root. Patterns are matched against every path segment or full
 * relative path (see `isExcluded`).
 */
export const DEFAULT_WORKSPACE_EXCLUDES: readonly string[] = [
  '.git',
  'node_modules',
  'cdk.out',
  '.DS_Store',
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '.claude/settings.local.json',
  'CLAUDE.local.md',
];

/** Commands that the C3 runtime image provides for stdio MCP servers. */
const COMMANDS_AVAILABLE_IN_IMAGE = new Set([
  'node',
  'npx',
  'npm',
  'uv',
  'uvx',
  'python3',
  'bash',
  'sh',
  'git',
]);

export interface WorkspaceFile {
  /** Path relative to the workspace root, always with forward slashes. */
  readonly relativePath: string;
  readonly absolutePath: string;
}

export interface WorkspaceInspection {
  /** Absolute path of the workspace root. */
  readonly root: string;
  /** Files that will be packaged, sorted by relative path. */
  readonly files: readonly WorkspaceFile[];
  /** Files skipped because they matched an exclude pattern. */
  readonly excluded: readonly string[];
  /** Non-fatal problems the developer should know about. */
  readonly warnings: readonly string[];
  /** SHA-256 over every packaged path and its contents. */
  readonly fingerprint: string;
}

export interface InspectWorkspaceOptions {
  /** Additional exclude patterns, appended to the defaults. */
  readonly exclude?: readonly string[];
}

/**
 * Discover and validate a native Claude Code workspace without modifying it.
 *
 * Throws for problems that would make the deployed agent unusable (missing
 * directory, malformed JSON configuration) and returns warnings for features
 * that may not behave the same inside the container.
 */
export function inspectWorkspace(
  source: string,
  options: InspectWorkspaceOptions = {},
): WorkspaceInspection {
  const root = path.resolve(source);
  if (!fs.existsSync(root)) {
    throw new C3ValidationError(`Workspace path "${source}" does not exist (resolved to ${root}).`);
  }
  if (!fs.statSync(root).isDirectory()) {
    throw new C3ValidationError(`Workspace path "${source}" must be a directory.`);
  }

  const patterns = [...DEFAULT_WORKSPACE_EXCLUDES, ...(options.exclude ?? [])];
  const files: WorkspaceFile[] = [];
  const excluded: string[] = [];
  const warnings: string[] = [];

  walk(root, '', patterns, files, excluded, warnings);
  files.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );

  const has = (rel: string) =>
    files.some((f) => f.relativePath === rel || f.relativePath.startsWith(`${rel}/`));
  if (!has('CLAUDE.md') && !has('.claude')) {
    warnings.push(
      `Workspace ${root} has neither CLAUDE.md nor a .claude/ directory. Claude Code will run with default behavior.`,
    );
  }

  const settingsPath = path.join(root, '.claude', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    warnings.push(...inspectSettings(readJson(settingsPath, '.claude/settings.json')));
  }
  const mcpPath = path.join(root, '.mcp.json');
  if (fs.existsSync(mcpPath)) {
    warnings.push(...inspectMcpConfig(readJson(mcpPath, '.mcp.json')));
  }
  if (excluded.includes('.claude/settings.local.json')) {
    warnings.push('.claude/settings.local.json is personal configuration and is not deployed.');
  }

  return { root, files, excluded, warnings, fingerprint: fingerprint(files) };
}

/**
 * Copy the inspected files into `destination`, preserving relative paths.
 * The source workspace is only read, never written.
 */
export function copyWorkspace(inspection: WorkspaceInspection, destination: string): void {
  for (const file of inspection.files) {
    const target = path.join(destination, ...file.relativePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file.absolutePath, target);
  }
}

/** Returns true when `relativePath` matches one of the exclude patterns. */
export function isExcluded(relativePath: string, patterns: readonly string[]): boolean {
  const segments = relativePath.split('/');
  const name = segments[segments.length - 1] ?? relativePath;
  return patterns.some((pattern) => {
    if (pattern.includes('/')) {
      return globToRegExp(pattern).test(relativePath);
    }
    const re = globToRegExp(pattern);
    return re.test(name) || segments.some((segment) => re.test(segment));
  });
}

function walk(
  root: string,
  relativeDir: string,
  patterns: readonly string[],
  files: WorkspaceFile[],
  excluded: string[],
  warnings: string[],
): void {
  const dir = path.join(root, relativeDir);
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (isExcluded(relativePath, patterns)) {
      excluded.push(relativePath);
      continue;
    }
    const absolutePath = path.join(root, relativePath);
    if (entry.isSymbolicLink()) {
      warnings.push(
        `Symbolic link ${relativePath} is not packaged. Copy the target into the workspace instead.`,
      );
      continue;
    }
    if (entry.isDirectory()) {
      walk(root, relativePath, patterns, files, excluded, warnings);
    } else if (entry.isFile()) {
      files.push({ relativePath, absolutePath });
    }
  }
}

function readJson(file: string, label: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (err) {
    throw new C3ValidationError(`${label} is not valid JSON: ${(err as Error).message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inspectSettings(settings: unknown): string[] {
  const warnings: string[] = [];
  if (!isRecord(settings)) {
    throw new C3ValidationError('.claude/settings.json must contain a JSON object.');
  }
  if (settings.hooks !== undefined) {
    warnings.push(
      'Hooks in .claude/settings.json run inside the AgentCore container; make sure every command they call exists in the image.',
    );
  }
  if (settings.enabledPlugins !== undefined || settings.extraKnownMarketplaces !== undefined) {
    warnings.push(
      'Plugins are installed by Claude Code at runtime and need network access to their marketplace; this is not verified by C3.',
    );
  }
  if (isRecord(settings.env)) {
    for (const key of Object.keys(settings.env)) {
      if (looksSecret(key)) {
        warnings.push(
          `.claude/settings.json sets "${key}" in env. Do not deploy secrets in workspace files; use AgentCore Identity or Secrets Manager.`,
        );
      }
    }
  }
  return warnings;
}

function inspectMcpConfig(config: unknown): string[] {
  const warnings: string[] = [];
  if (!isRecord(config) || (config.mcpServers !== undefined && !isRecord(config.mcpServers))) {
    throw new C3ValidationError('.mcp.json must contain an object with an "mcpServers" object.');
  }
  const servers = isRecord(config.mcpServers) ? config.mcpServers : {};
  for (const [name, server] of Object.entries(servers)) {
    if (!isRecord(server)) {
      throw new C3ValidationError(`.mcp.json server "${name}" must be an object.`);
    }
    if (name === 'c3-gateway') {
      throw new C3ValidationError(
        '.mcp.json must not define a server named "c3-gateway"; that name is reserved by C3.',
      );
    }
    const command = typeof server.command === 'string' ? server.command : undefined;
    if (command && !COMMANDS_AVAILABLE_IN_IMAGE.has(command)) {
      warnings.push(
        `.mcp.json server "${name}" runs "${command}", which is not installed in the C3 runtime image.`,
      );
    }
    if (isRecord(server.env)) {
      for (const key of Object.keys(server.env)) {
        if (looksSecret(key)) {
          warnings.push(
            `.mcp.json server "${name}" sets "${key}". Do not commit secrets into the workspace.`,
          );
        }
      }
    }
  }
  if (Object.keys(servers).length > 0) {
    warnings.push(
      'Project MCP servers from .mcp.json need approval in headless mode; set "enableAllProjectMcpServers" or "enabledMcpjsonServers" in .claude/settings.json.',
    );
  }
  return warnings;
}

/** Heuristic for environment variable names that probably hold credentials. */
export function looksSecret(name: string): boolean {
  return /(SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)/i.test(name);
}

function fingerprint(files: readonly WorkspaceFile[]): string {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(fs.readFileSync(file.absolutePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`);
}
