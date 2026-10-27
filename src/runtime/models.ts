import { Stack, Token } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { IConstruct } from 'constructs';
import { C3ValidationError } from '../errors';

const ALIASES = ['opus', 'sonnet', 'haiku'] as const;
const INFERENCE_PROFILE_PREFIXES = ['us', 'eu', 'apac', 'jp', 'au', 'global', 'us-gov'];

/**
 * The Claude model a `ClaudeCodeAgent` runs on Amazon Bedrock.
 *
 * Aliases (`opus`, `sonnet`, `haiku`) are resolved by Claude Code itself to its
 * built-in Bedrock defaults, which can change between Claude Code versions.
 * Pin an inference profile ID when you need a stable model.
 */
export class ClaudeModel {
  /** Claude Code's `opus` alias. Highest per-token price. */
  public static readonly OPUS = new ClaudeModel('opus', 'alias');
  /** Claude Code's `sonnet` alias. The C3 default. */
  public static readonly SONNET = new ClaudeModel('sonnet', 'alias');
  /** Claude Code's `haiku` alias. The model must be enabled in your account. */
  public static readonly HAIKU = new ClaudeModel('haiku', 'alias');

  /**
   * A system-defined cross-region inference profile ID, for example
   * `us.anthropic.claude-sonnet-4-6`. The ID is not checked against Bedrock at
   * synth time; make sure it is enabled in your account and region.
   */
  public static fromInferenceProfileId(id: string): ClaudeModel {
    if (!Token.isUnresolved(id)) {
      const [prefix, provider] = id.split('.');
      if (!prefix || !INFERENCE_PROFILE_PREFIXES.includes(prefix) || provider !== 'anthropic') {
        throw new C3ValidationError(
          `"${id}" is not an Anthropic inference profile ID. Expected "<prefix>.anthropic.<model>" with prefix one of ${INFERENCE_PROFILE_PREFIXES.join(', ')}.`,
        );
      }
    }
    return new ClaudeModel(id, 'inference-profile');
  }

  /** An application inference profile ARN that routes to a Claude model. */
  public static fromApplicationInferenceProfileArn(arn: string): ClaudeModel {
    if (!Token.isUnresolved(arn) && !/:application-inference-profile\//.test(arn)) {
      throw new C3ValidationError(`"${arn}" is not an application inference profile ARN.`);
    }
    return new ClaudeModel(arn, 'application-inference-profile');
  }

  /** Accepts an alias (`'sonnet'`) or an inference profile ID / ARN. */
  public static of(value: string): ClaudeModel {
    if ((ALIASES as readonly string[]).includes(value)) {
      return new ClaudeModel(value, 'alias');
    }
    if (value.startsWith('arn:')) {
      return ClaudeModel.fromApplicationInferenceProfileArn(value);
    }
    return ClaudeModel.fromInferenceProfileId(value);
  }

  private constructor(
    /** Value passed to Claude Code as `ANTHROPIC_MODEL`. */
    public readonly modelId: string,
    public readonly kind: 'alias' | 'inference-profile' | 'application-inference-profile',
  ) {}

  /**
   * IAM statements Claude Code needs to invoke this model through Amazon
   * Bedrock. Aliases are scoped to Anthropic Claude models because Claude
   * Code chooses the concrete version at runtime.
   */
  public policyStatements(scope: IConstruct): iam.PolicyStatement[] {
    const stack = Stack.of(scope);
    const invoke = ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'];
    // Cross-region inference profiles route to foundation models in other regions.
    const claudeFoundationModels = `arn:${stack.partition}:bedrock:*::foundation-model/anthropic.claude-*`;
    const statements: iam.PolicyStatement[] = [];

    switch (this.kind) {
      case 'alias':
        statements.push(
          new iam.PolicyStatement({
            sid: 'C3InvokeClaude',
            actions: [...invoke, 'bedrock:GetInferenceProfile'],
            resources: [
              `arn:${stack.partition}:bedrock:*:${stack.account}:inference-profile/*.anthropic.claude-*`,
              claudeFoundationModels,
            ],
          }),
        );
        break;
      case 'inference-profile': {
        const foundationModel = this.modelId.slice(this.modelId.indexOf('.') + 1);
        statements.push(
          new iam.PolicyStatement({
            sid: 'C3InvokeClaude',
            actions: [...invoke, 'bedrock:GetInferenceProfile'],
            resources: [
              `arn:${stack.partition}:bedrock:${stack.region}:${stack.account}:inference-profile/${this.modelId}`,
              `arn:${stack.partition}:bedrock:*::foundation-model/${foundationModel}`,
            ],
          }),
        );
        break;
      }
      case 'application-inference-profile':
        statements.push(
          new iam.PolicyStatement({
            sid: 'C3InvokeClaude',
            actions: [...invoke, 'bedrock:GetInferenceProfile'],
            resources: [this.modelId, claudeFoundationModels],
          }),
        );
        break;
    }

    // Claude Code lists inference profiles to resolve region prefixes. List
    // actions do not support resource-level permissions.
    statements.push(
      new iam.PolicyStatement({
        sid: 'C3ListInferenceProfiles',
        actions: ['bedrock:ListInferenceProfiles'],
        resources: ['*'],
      }),
    );
    return statements;
  }
}
