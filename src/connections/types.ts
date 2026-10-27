import type { GatewayTarget } from 'aws-cdk-lib/aws-bedrockagentcore';
import type * as lambda from 'aws-cdk-lib/aws-lambda';

/** Result of `ClaudeCodeAgent.connect()`. */
export interface ToolConnection {
  /** Gateway target name; it prefixes every tool name. */
  readonly targetName: string;
  /** Tool names as Claude Code sees them (`mcp__c3-gateway__<target>___<tool>`). */
  readonly toolNames: readonly string[];
  /** The underlying AgentCore Gateway target. */
  readonly target: GatewayTarget;
  /** The C3 adapter function, for resource-specific connectors. */
  readonly adapter?: lambda.IFunction;
}

/** Options shared by every connector. */
export interface ConnectionOptions {
  /**
   * Connection name. The gateway target is named after it with `_` replaced
   * by `-`, and tools appear to Claude as `<target>___<tool>`.
   */
  readonly name: string;
  /** Description of the target. */
  readonly description?: string;
}
