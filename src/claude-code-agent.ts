import { Annotations, Duration, Lazy, RemovalPolicy, Stack } from 'aws-cdk-lib';
import {
  LogType,
  LoggingDestination,
  Runtime,
  type AgentRuntimeArtifact,
  type ApiSchema,
  type GatewayTarget,
  type ICredentialProviderConfig,
  type LifecycleConfiguration,
  type LoggingConfig,
  type PlatformVersion,
  type RuntimeEndpoint,
  type RuntimeNetworkConfiguration,
} from 'aws-cdk-lib/aws-bedrockagentcore';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { connectDynamoDb, type DynamoDbToolOptions } from './connections/dynamodb';
import { connectLambda, type LambdaToolOptions } from './connections/lambda';
import {
  connectEventBridge,
  connectSqs,
  type EventBridgeToolOptions,
  type SqsToolOptions,
} from './connections/messaging';
import { connectS3, type S3ToolOptions } from './connections/s3';
import type { ConnectionOptions, ToolConnection } from './connections/types';
import { C3ValidationError } from './errors';
import { AgentToolGateway, toTargetName } from './gateway/agent-gateway';
import { DEFAULT_CLAUDE_CODE_VERSION, stageRuntimeArtifact } from './runtime/artifact';
import { ClaudeModel } from './runtime/models';
import { grantResource, type GrantableResource, type GrantOptions } from './security/grants';
import { inspectWorkspace, looksSecret } from './workspace/workspace';

/** Claude Code permission modes accepted in headless mode. */
export enum PermissionMode {
  /** Deny every tool that is not pre-approved by settings or `allowedTools`. The C3 default. */
  DONT_ASK = 'dontAsk',
  /** Auto-approve file edits; other tools still need approval rules. */
  ACCEPT_EDITS = 'acceptEdits',
  /** Read-only planning. */
  PLAN = 'plan',
  /** Claude Code's classifier-based auto mode. */
  AUTO = 'auto',
  /** Skip all permission checks. Only for fully isolated, trusted workloads. */
  BYPASS_PERMISSIONS = 'bypassPermissions',
}

export interface ApplicationLogsOptions {
  /** @default logs.RetentionDays.ONE_MONTH */
  readonly retention?: logs.RetentionDays;
  /** @default RemovalPolicy.RETAIN */
  readonly removalPolicy?: RemovalPolicy;
}

export interface SessionStorageOptions {
  /** Bucket that stores session archives. Use a private, encrypted bucket. */
  readonly bucket: s3.IBucket;
  /** Key prefix for archives. @default 'c3-sessions/' */
  readonly prefix?: string;
}

export interface ClaudeCodeAgentProps {
  /** Path to a native Claude Code workspace (CLAUDE.md, .claude/, .mcp.json). */
  readonly source: string;
  /**
   * Claude model on Amazon Bedrock: an alias (`'sonnet'`, `'opus'`,
   * `'haiku'`), an inference profile ID or a `ClaudeModel`.
   * @default ClaudeModel.SONNET
   */
  readonly model?: ClaudeModel | string;
  /** Claude Code npm version installed in the image. @default DEFAULT_CLAUDE_CODE_VERSION */
  readonly claudeCodeVersion?: string;
  /** @default PermissionMode.DONT_ASK */
  readonly permissionMode?: PermissionMode;
  /** Extra Claude Code permission rules to allow, e.g. `['Read', 'Bash(git log:*)']`. */
  readonly allowedTools?: readonly string[];
  /** Claude Code permission rules to deny. */
  readonly disallowedTools?: readonly string[];
  /** Per-invocation spend cap passed to `--max-budget-usd`. */
  readonly maxBudgetUsd?: number;
  /** Kill an invocation after this long. @default Duration.minutes(15) */
  readonly invocationTimeout?: Duration;
  /** Additional non-secret environment variables for Claude Code. */
  readonly environment?: Record<string, string>;
  /** Install AWS CLI v2 in the image so Bash can call AWS. @default false */
  readonly installAwsCli?: boolean;
  /** Additional workspace paths to exclude from the artifact (glob, `*` and `?`). */
  readonly exclude?: readonly string[];
  /** Runtime name. Letters, digits and `_`. @default - generated */
  readonly runtimeName?: string;
  readonly description?: string;
  /** @default - public network */
  readonly network?: RuntimeNetworkConfiguration;
  /** Idle timeout and maximum lifetime of runtime sessions. */
  readonly lifecycle?: LifecycleConfiguration;
  /** AgentCore Runtime platform version, e.g. `PlatformVersion.V2`. @default - service default */
  readonly platformVersion?: PlatformVersion;
  /** Deliver traces to X-Ray. @default false */
  readonly tracing?: boolean;
  /** Deliver application logs to a C3-managed log group. @default - stdout logs only */
  readonly applicationLogs?: boolean | ApplicationLogsOptions;
  /** Persist sessions and workspace changes across microVMs. @default - ephemeral */
  readonly sessionStorage?: SessionStorageOptions;
  /** Create a named runtime endpoint in addition to DEFAULT. */
  readonly endpointName?: string;
  /** Return detailed Gateway tool errors to the agent. @default false */
  readonly debugToolErrors?: boolean;
  /** Override the runtime artifact. For advanced use and tests. */
  readonly artifact?: AgentRuntimeArtifact;
}

/**
 * One Claude Code execution environment on Amazon Bedrock AgentCore Runtime,
 * built from a native Claude Code workspace.
 */
export class ClaudeCodeAgent extends Construct implements iam.IGrantable {
  /** The AgentCore Runtime. */
  public readonly runtime: Runtime;
  /** The runtime execution role. Claude Code runs with these permissions. */
  public readonly role: iam.IRole;
  public readonly grantPrincipal: iam.IPrincipal;
  /** The model Claude Code uses. */
  public readonly model: ClaudeModel;
  /** The named endpoint, when `endpointName` is set. */
  public readonly endpoint?: RuntimeEndpoint;
  /** Docker build context, when C3 built the artifact. */
  public readonly buildContextDir?: string;
  /** Application log group, when `applicationLogs` is enabled. */
  public readonly logGroup?: logs.ILogGroup;

  private toolGateway?: AgentToolGateway;
  private readonly debugToolErrors: boolean;

  constructor(scope: Construct, id: string, props: ClaudeCodeAgentProps) {
    super(scope, id);
    this.debugToolErrors = props.debugToolErrors ?? false;
    this.model =
      props.model instanceof ClaudeModel ? props.model : ClaudeModel.of(props.model ?? 'sonnet');

    let artifact = props.artifact;
    const workspace = inspectWorkspace(props.source, { exclude: props.exclude });
    for (const warning of workspace.warnings) {
      Annotations.of(this).addWarningV2('c3-aws:workspace', warning);
    }
    if (!artifact) {
      const staged = stageRuntimeArtifact({
        workspace,
        claudeCodeVersion: props.claudeCodeVersion ?? DEFAULT_CLAUDE_CODE_VERSION,
        installAwsCli: props.installAwsCli ?? false,
      });
      artifact = staged.artifact;
      this.buildContextDir = staged.contextDir;
    }

    const loggingConfigs: LoggingConfig[] = [];
    if (props.applicationLogs) {
      const options = props.applicationLogs === true ? {} : props.applicationLogs;
      this.logGroup = new logs.LogGroup(this, 'ApplicationLogs', {
        retention: options.retention ?? logs.RetentionDays.ONE_MONTH,
        removalPolicy: options.removalPolicy ?? RemovalPolicy.RETAIN,
      });
      loggingConfigs.push({
        logType: LogType.APPLICATION_LOGS,
        destination: LoggingDestination.cloudWatchLogs(this.logGroup),
      });
    }

    this.runtime = new Runtime(this, 'Runtime', {
      runtimeName: props.runtimeName,
      description: props.description ?? 'Claude Code agent deployed with C3',
      agentRuntimeArtifact: artifact,
      networkConfiguration: props.network,
      lifecycleConfiguration: props.lifecycle,
      platformVersion: props.platformVersion,
      tracingEnabled: props.tracing,
      loggingConfigs: loggingConfigs.length > 0 ? loggingConfigs : undefined,
      environmentVariables: this.environment(props),
    });
    this.role = this.runtime.role;
    this.grantPrincipal = this.runtime.grantPrincipal;

    for (const statement of this.model.policyStatements(this)) {
      this.role.addToPrincipalPolicy(statement);
    }

    if (props.sessionStorage) {
      const prefix = props.sessionStorage.prefix ?? 'c3-sessions/';
      props.sessionStorage.bucket.grantReadWrite(this.role, `${prefix}*`);
    }

    if (props.endpointName) {
      this.endpoint = this.runtime.addEndpoint(props.endpointName);
    }
  }

  private environment(props: ClaudeCodeAgentProps): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(props.environment ?? {})) {
      if (looksSecret(key)) {
        throw new C3ValidationError(
          `Environment variable "${key}" looks like a secret. Runtime environment variables are visible in CloudFormation; use AgentCore Identity or a secret store instead.`,
        );
      }
      if (key.startsWith('C3_') || key === 'CLAUDE_CODE_USE_BEDROCK') {
        throw new C3ValidationError(`Environment variable "${key}" is managed by C3.`);
      }
      env[key] = value;
    }
    if (props.maxBudgetUsd !== undefined && !(props.maxBudgetUsd > 0)) {
      throw new C3ValidationError('maxBudgetUsd must be a positive number.');
    }
    const timeout = props.invocationTimeout ?? Duration.minutes(15);
    if (timeout.toSeconds() < 10 || timeout.toSeconds() > 8 * 3600) {
      throw new C3ValidationError('invocationTimeout must be between 10 seconds and 8 hours.');
    }

    env.ANTHROPIC_MODEL = this.model.modelId;
    env.C3_AWS_REGION = Stack.of(this).region;
    env.C3_PERMISSION_MODE = props.permissionMode ?? PermissionMode.DONT_ASK;
    env.C3_INVOCATION_TIMEOUT_SECONDS = String(timeout.toSeconds());
    if (props.allowedTools?.length) env.C3_ALLOWED_TOOLS = props.allowedTools.join(',');
    if (props.disallowedTools?.length) env.C3_DISALLOWED_TOOLS = props.disallowedTools.join(',');
    if (props.maxBudgetUsd !== undefined) env.C3_MAX_BUDGET_USD = String(props.maxBudgetUsd);
    if (props.sessionStorage) {
      env.C3_SESSION_BUCKET = props.sessionStorage.bucket.bucketName;
      env.C3_SESSION_PREFIX = props.sessionStorage.prefix ?? 'c3-sessions/';
    }
    // Resolved at synth time so connect() can be called after construction.
    env.C3_GATEWAY_URL = Lazy.string({
      produce: () => (this.toolGateway ? this.toolGateway.url : 'none'),
    });
    return env;
  }

  /** The AgentCore Gateway that serves this agent's tools, if any were connected. */
  public get gateway(): AgentToolGateway | undefined {
    return this.toolGateway;
  }

  private ensureGateway(): AgentToolGateway {
    this.toolGateway ??= new AgentToolGateway(this, 'Tools', {
      invoker: this.role,
      debugErrors: this.debugToolErrors,
    });
    return this.toolGateway;
  }

  /**
   * Allow Claude Code (Bash, AWS CLI, SDK scripts) to call specific AWS APIs
   * on a resource. This does not create a tool.
   */
  public grant(resource: GrantableResource, options: GrantOptions): iam.PolicyStatement[] {
    return grantResource(this, resource, options);
  }

  /** Allow a principal to invoke this agent runtime. */
  public grantInvoke(grantee: iam.IGrantable): iam.Grant {
    return this.runtime.grantInvoke(grantee);
  }

  /**
   * Expose explicit operations on a resource as MCP tools through AgentCore
   * Gateway. Lambda functions use your schema; buckets, tables, queues and
   * event buses use audited C3 adapters with fixed, narrow tools.
   */
  public connect(fn: lambda.IFunction, options: LambdaToolOptions): ToolConnection;
  public connect(bucket: s3.IBucket, options: S3ToolOptions): ToolConnection;
  public connect(table: dynamodb.ITable, options: DynamoDbToolOptions): ToolConnection;
  public connect(queue: sqs.IQueue, options: SqsToolOptions): ToolConnection;
  public connect(bus: events.IEventBus, options: EventBridgeToolOptions): ToolConnection;
  public connect(
    resource: lambda.IFunction | s3.IBucket | dynamodb.ITable | sqs.IQueue | events.IEventBus,
    options:
      | LambdaToolOptions
      | S3ToolOptions
      | DynamoDbToolOptions
      | SqsToolOptions
      | EventBridgeToolOptions,
  ): ToolConnection {
    const gateway = this.ensureGateway();
    if ('functionArn' in resource) {
      return connectLambda(gateway, resource, options as LambdaToolOptions);
    }
    if ('bucketArn' in resource) {
      return connectS3(this, gateway, resource, options as S3ToolOptions);
    }
    if ('tableArn' in resource) {
      return connectDynamoDb(this, gateway, resource, options as DynamoDbToolOptions);
    }
    if ('queueArn' in resource) {
      return connectSqs(this, gateway, resource, options as SqsToolOptions);
    }
    if ('eventBusArn' in resource) {
      return connectEventBridge(this, gateway, resource, options as EventBridgeToolOptions);
    }
    throw new C3ValidationError(
      'connect() supports Lambda functions, S3 buckets, DynamoDB tables, SQS queues and EventBridge buses.',
    );
  }

  /**
   * Expose an HTTP API described by OpenAPI as tools. Outbound credentials
   * must be given explicitly (API key or OAuth via AgentCore Identity).
   */
  public connectOpenApi(
    options: ConnectionOptions & {
      readonly schema: ApiSchema;
      readonly credentialProviders: readonly ICredentialProviderConfig[];
    },
  ): GatewayTarget {
    const gateway = this.ensureGateway();
    const targetName = toTargetName(options.name);
    gateway.reserveTargetName(targetName);
    if (options.credentialProviders.length === 0) {
      Annotations.of(this).addWarningV2(
        'c3-aws:openapi-no-auth',
        `OpenAPI connection "${options.name}" has no outbound credentials.`,
      );
    }
    return gateway.gateway.addOpenApiTarget(targetName, {
      gatewayTargetName: targetName,
      description: options.description,
      apiSchema: options.schema,
      credentialProviderConfigurations: [...options.credentialProviders],
    });
  }

  /** Expose a remote MCP server's tools. Outbound credentials are required. */
  public connectMcpServer(
    options: ConnectionOptions & {
      readonly endpoint: string;
      readonly credentialProviders: readonly ICredentialProviderConfig[];
    },
  ): GatewayTarget {
    if (options.credentialProviders.length === 0) {
      throw new C3ValidationError(
        `MCP server connection "${options.name}" needs at least one credential provider.`,
      );
    }
    const gateway = this.ensureGateway();
    const targetName = toTargetName(options.name);
    gateway.reserveTargetName(targetName);
    return gateway.gateway.addMcpServerTarget(targetName, {
      gatewayTargetName: targetName,
      description: options.description,
      endpoint: options.endpoint,
      credentialProviderConfigurations: [...options.credentialProviders],
    });
  }
}
