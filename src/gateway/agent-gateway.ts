import { Annotations } from 'aws-cdk-lib';
import {
  Gateway,
  GatewayAuthorizer,
  GatewayExceptionLevel,
  ToolSchema,
  type GatewayTarget,
} from 'aws-cdk-lib/aws-bedrockagentcore';
import type * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { C3ValidationError } from '../errors';
import { toToolDefinition, type ToolSpec } from './tool-schema';

/** MCP server name under which Claude Code sees the gateway tools. */
export const GATEWAY_MCP_SERVER_NAME = 'c3-gateway';

/**
 * Gateway target names allow only letters, digits and hyphens. C3 accepts
 * snake_case connection names and converts underscores to hyphens.
 */
export function toTargetName(name: string): string {
  return name.replace(/_/g, '-');
}

/** Claude-visible tool names (`mcp__<server>__<target>___<tool>`) longer than this may be rejected. */
const MAX_VISIBLE_TOOL_NAME = 64;
const TARGET_NAME_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,98}[a-zA-Z0-9])?$/;

export interface AgentToolGatewayProps {
  /** The agent runtime identity allowed to call the gateway. */
  readonly invoker: iam.IGrantable;
  /** Return detailed tool errors to the agent. Useful while developing. */
  readonly debugErrors?: boolean;
}

/**
 * One AgentCore Gateway per agent, protected with AWS IAM (SigV4) so only the
 * agent's execution role can list and call its tools.
 */
export class AgentToolGateway extends Construct {
  public readonly gateway: Gateway;
  private readonly targetNames = new Set<string>();

  constructor(scope: Construct, id: string, props: AgentToolGatewayProps) {
    super(scope, id);
    this.gateway = new Gateway(this, 'Gateway', {
      description: 'C3 tools for a Claude Code agent',
      authorizerConfiguration: GatewayAuthorizer.usingAwsIam(),
      exceptionLevel: props.debugErrors ? GatewayExceptionLevel.DEBUG : undefined,
    });
    this.gateway.grantInvoke(props.invoker);
  }

  /** The MCP endpoint URL of the gateway. */
  public get url(): string {
    const url = this.gateway.gatewayUrl;
    if (!url) {
      throw new C3ValidationError('The AgentCore Gateway construct did not expose a gateway URL.');
    }
    return url;
  }

  /** Register a Lambda function that implements one or more tools. */
  public addLambdaTools(
    targetName: string,
    fn: lambda.IFunction,
    tools: readonly ToolSpec[],
    description?: string,
  ): GatewayTarget {
    if (!this.targetNames.has(targetName)) this.reserveTargetName(targetName);
    if (tools.length === 0) {
      throw new C3ValidationError(`Target "${targetName}" must expose at least one tool.`);
    }
    const seen = new Set<string>();
    for (const tool of tools) {
      if (seen.has(tool.name)) {
        throw new C3ValidationError(
          `Target "${targetName}" defines tool "${tool.name}" more than once.`,
        );
      }
      seen.add(tool.name);
      this.checkVisibleName(targetName, tool.name);
    }
    return this.gateway.addLambdaTarget(targetName, {
      gatewayTargetName: targetName,
      description,
      lambdaFunction: fn,
      toolSchema: ToolSchema.fromInline(tools.map(toToolDefinition)),
    });
  }

  /** Validate and reserve a target name; target names prefix every tool name. */
  public reserveTargetName(targetName: string): void {
    if (!TARGET_NAME_PATTERN.test(targetName)) {
      throw new C3ValidationError(
        `Tool target name "${targetName}" must be 1-100 characters of letters, digits or "-" (C3 converts "_" to "-"), starting and ending with a letter or digit.`,
      );
    }
    if (this.targetNames.has(targetName)) {
      throw new C3ValidationError(
        `Tool target name "${targetName}" is already used by this agent.`,
      );
    }
    this.targetNames.add(targetName);
  }

  private checkVisibleName(targetName: string, toolName: string): void {
    const visible = `mcp__${GATEWAY_MCP_SERVER_NAME}__${targetName}___${toolName}`;
    if (visible.length > MAX_VISIBLE_TOOL_NAME) {
      Annotations.of(this).addWarningV2(
        'c3-aws:tool-name-length',
        `Tool "${visible}" is ${visible.length} characters long. Some clients reject tool names over ${MAX_VISIBLE_TOOL_NAME} characters; use shorter target or tool names.`,
      );
    }
  }
}
