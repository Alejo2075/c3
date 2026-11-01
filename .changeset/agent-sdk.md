---
'c3-aws': minor
---

The runtime entrypoint now uses the official Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) instead of spawning the Claude Code CLI. The `claudeCodeVersion` prop is replaced by `agentSdkVersion`, and timeouts interrupt the turn before aborting it.
