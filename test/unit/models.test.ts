import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, test } from 'vitest';
import { ClaudeCodeAgent, ClaudeModel } from 'c3-aws';
import { actionsOf, makeStack, makeWorkspace, statementsForRole } from '../helpers';

describe('ClaudeModel', () => {
  test('parses aliases, inference profiles and ARNs', () => {
    expect(ClaudeModel.of('sonnet').kind).toBe('alias');
    expect(ClaudeModel.of('us.anthropic.claude-sonnet-4-6').kind).toBe('inference-profile');
    expect(
      ClaudeModel.of('arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc')
        .kind,
    ).toBe('application-inference-profile');
    expect(() => ClaudeModel.of('gpt-4')).toThrow(/not an Anthropic inference profile/);
    expect(() => ClaudeModel.of('us.meta.llama3')).toThrow(/not an Anthropic/);
  });

  test('a pinned inference profile is scoped to that model', () => {
    const stack = makeStack();
    new ClaudeCodeAgent(stack, 'Agent', {
      source: makeWorkspace(),
      model: 'us.anthropic.claude-sonnet-4-6',
    });
    const template = Template.fromStack(stack).toJSON();
    const statement = statementsForRole(template, 'AgentRuntimeExecutionRole').find((s) =>
      actionsOf([s]).includes('bedrock:InvokeModel'),
    );
    expect(JSON.stringify(statement?.Resource)).toContain(
      'inference-profile/us.anthropic.claude-sonnet-4-6',
    );
    expect(JSON.stringify(statement?.Resource)).toContain(
      'foundation-model/anthropic.claude-sonnet-4-6',
    );
    expect(JSON.stringify(statement?.Resource)).not.toContain('claude-*');
    Template.fromStack(stack).hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      EnvironmentVariables: { ANTHROPIC_MODEL: 'us.anthropic.claude-sonnet-4-6' },
    });
  });
});
