import type * as lambda from 'aws-cdk-lib/aws-lambda';
import { C3ValidationError } from '../errors';
import { toTargetName, type AgentToolGateway } from '../gateway/agent-gateway';
import type { ObjectJsonSchema, ToolSpec } from '../gateway/tool-schema';
import { visibleToolName } from './adapter';
import type { ConnectionOptions, ToolConnection } from './types';

/**
 * Expose your own Lambda function as agent tools.
 *
 * Either describe a single tool with `inputSchema` (the tool is named after
 * `name`; the gateway target uses `name` with `_` replaced by `-`), or pass
 * several `tools` implemented by the same function. The
 * function receives the tool arguments as its event and the tool name in
 * `context.clientContext.custom.bedrockAgentCoreToolName`.
 */
export interface LambdaToolOptions extends ConnectionOptions {
  /** Single-tool form: tool description. Defaults to `description`. */
  readonly toolDescription?: string;
  /** Single-tool form: input schema. */
  readonly inputSchema?: ObjectJsonSchema;
  /** Single-tool form: output schema. */
  readonly outputSchema?: ObjectJsonSchema;
  /** Multi-tool form. */
  readonly tools?: readonly ToolSpec[];
}

export function connectLambda(
  gateway: AgentToolGateway,
  fn: lambda.IFunction,
  options: LambdaToolOptions,
): ToolConnection {
  const targetName = toTargetName(options.name);
  gateway.reserveTargetName(targetName);
  const tools = lambdaToolSpecs(options);
  const target = gateway.addLambdaTools(targetName, fn, tools, options.description);
  return {
    targetName,
    toolNames: tools.map((tool) => visibleToolName(targetName, tool.name)),
    target,
  };
}

function lambdaToolSpecs(options: LambdaToolOptions): ToolSpec[] {
  if (options.tools && options.inputSchema) {
    throw new C3ValidationError(
      `Lambda connection "${options.name}" must use either "tools" or "inputSchema", not both.`,
    );
  }
  if (options.tools) {
    return [...options.tools];
  }
  if (!options.inputSchema) {
    throw new C3ValidationError(
      `Lambda connection "${options.name}" needs an explicit "inputSchema" (or a "tools" list). C3 never infers tool schemas.`,
    );
  }
  const description = options.toolDescription ?? options.description;
  if (!description) {
    throw new C3ValidationError(`Lambda connection "${options.name}" needs a "description".`);
  }
  return [
    {
      name: options.name,
      description,
      inputSchema: options.inputSchema,
      outputSchema: options.outputSchema,
    },
  ];
}
