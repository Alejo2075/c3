import {
  SchemaDefinitionType,
  type SchemaDefinition,
  type ToolDefinition,
} from 'aws-cdk-lib/aws-bedrockagentcore';
import { C3ValidationError } from '../errors';

/** JSON Schema subset supported by AgentCore Gateway Lambda tool schemas. */
export type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';

export interface JsonSchema {
  readonly type: JsonSchemaType;
  readonly description?: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
}

/** Top-level input or output schema of a tool. Must be an object schema. */
export interface ObjectJsonSchema extends JsonSchema {
  readonly type: 'object';
}

export interface ToolSpec {
  /** Tool name shown to Claude (after the `<target>___` prefix). */
  readonly name: string;
  /** What the tool does and when to use it. Claude reads this. */
  readonly description: string;
  readonly inputSchema: ObjectJsonSchema;
  readonly outputSchema?: ObjectJsonSchema;
}

const SUPPORTED_TYPES: readonly JsonSchemaType[] = [
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
];
const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const MAX_DEPTH = 10;

/** Validate a tool spec and convert it to the CDK `ToolDefinition` shape. */
export function toToolDefinition(spec: ToolSpec): ToolDefinition {
  if (!NAME_PATTERN.test(spec.name) || spec.name.includes('___')) {
    throw new C3ValidationError(
      `Tool name "${spec.name}" must start with a letter, contain only letters, digits, "_" or "-", be at most 64 characters and not contain "___".`,
    );
  }
  if (!spec.description || spec.description.trim().length === 0) {
    throw new C3ValidationError(
      `Tool "${spec.name}" needs a description so Claude knows when to use it.`,
    );
  }
  if (spec.inputSchema.type !== 'object') {
    throw new C3ValidationError(`Tool "${spec.name}" inputSchema must have type "object".`);
  }
  if (spec.outputSchema && spec.outputSchema.type !== 'object') {
    throw new C3ValidationError(`Tool "${spec.name}" outputSchema must have type "object".`);
  }
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: convert(spec.inputSchema, `${spec.name}.inputSchema`, 0),
    outputSchema: spec.outputSchema
      ? convert(spec.outputSchema, `${spec.name}.outputSchema`, 0)
      : undefined,
  };
}

function convert(schema: JsonSchema, at: string, depth: number): SchemaDefinition {
  if (depth > MAX_DEPTH) {
    throw new C3ValidationError(`${at} is nested deeper than ${MAX_DEPTH} levels.`);
  }
  if (!SUPPORTED_TYPES.includes(schema.type)) {
    throw new C3ValidationError(
      `${at} has unsupported type "${String(schema.type)}". Use one of ${SUPPORTED_TYPES.join(', ')}.`,
    );
  }
  if (schema.type === 'array' && !schema.items) {
    throw new C3ValidationError(`${at} is an array and must define "items".`);
  }
  if (schema.type !== 'array' && schema.items) {
    throw new C3ValidationError(`${at} defines "items" but is not an array.`);
  }
  if (schema.type !== 'object' && (schema.properties || schema.required)) {
    throw new C3ValidationError(`${at} defines "properties" or "required" but is not an object.`);
  }
  for (const name of schema.required ?? []) {
    if (!schema.properties || !(name in schema.properties)) {
      throw new C3ValidationError(
        `${at} requires "${name}" but does not define it in "properties".`,
      );
    }
  }

  const properties = schema.properties
    ? Object.fromEntries(
        Object.entries(schema.properties).map(([key, value]) => [
          key,
          convert(value, `${at}.properties.${key}`, depth + 1),
        ]),
      )
    : undefined;

  return {
    type: SchemaDefinitionType.of(schema.type),
    description: schema.description,
    properties,
    required: schema.required ? [...schema.required] : undefined,
    items: schema.items ? convert(schema.items, `${at}.items`, depth + 1) : undefined,
  };
}
