import * as path from 'node:path';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { GATEWAY_MCP_SERVER_NAME, type AgentToolGateway } from '../gateway/agent-gateway';
import type { ToolSpec } from '../gateway/tool-schema';
import type { ToolConnection } from './types';

export const ADAPTERS_DIR = path.resolve(__dirname, '..', '..', 'runtime-assets', 'adapters');

export type AdapterKind = 's3' | 'dynamodb' | 'sqs' | 'eventbridge';

export interface AdapterProps {
  readonly kind: AdapterKind;
  /** Serialized into `C3_ADAPTER_CONFIG`. Must not contain secrets. */
  readonly config: Record<string, unknown>;
  readonly logRetention?: logs.RetentionDays;
}

/**
 * A small, audited Lambda function that exposes one AWS resource as Gateway
 * tools using the AWS SDK bundled with the Lambda runtime.
 */
export class ToolAdapterFunction extends Construct {
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: AdapterProps) {
    super(scope, id);
    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: props.logRetention ?? logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.function = new lambda.Function(this, 'Function', {
      description: `C3 ${props.kind} tool adapter`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: `${props.kind}.handler`,
      code: lambda.Code.fromAsset(ADAPTERS_DIR),
      timeout: Duration.seconds(30),
      memorySize: 256,
      logGroup,
      environment: {
        C3_ADAPTER_CONFIG: JSON.stringify(props.config),
        NODE_OPTIONS: '--enable-source-maps',
      },
    });
  }
}

export function connectAdapter(
  gateway: AgentToolGateway,
  targetName: string,
  adapter: lambda.IFunction,
  tools: readonly ToolSpec[],
  description: string | undefined,
): ToolConnection {
  const target = gateway.addLambdaTools(targetName, adapter, tools, description);
  return {
    targetName,
    toolNames: tools.map((tool) => visibleToolName(targetName, tool.name)),
    target,
    adapter,
  };
}

export function visibleToolName(targetName: string, toolName: string): string {
  return `mcp__${GATEWAY_MCP_SERVER_NAME}__${targetName}___${toolName}`;
}
