---
'c3-aws': patch
---

DynamoDB connections reject `indexes` together with `partitionKeyPrefixes` (IAM leading-key conditions do not cover index queries), and session restore validates archive members before extracting.
