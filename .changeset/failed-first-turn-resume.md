---
'c3-aws': patch
---

The runtime entrypoint resumes a session only when Claude Code wrote its transcript. A first turn that failed before writing one (for example, missing Bedrock model access) no longer leaves the session stuck on a failing resume.
