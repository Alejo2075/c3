# Contributing to C3

Thanks for your interest! C3 aims to stay small: a single CDK construct that sits at the boundary
between Claude Code and AWS. Before you start, read the product boundaries in
[CLAUDE.md](CLAUDE.md): sections 3 (non-goals) and 8 (security).

## Development setup

```bash
git clone https://github.com/Alejo2075/c3.git && cd c3
npm ci
npm run typecheck
npm run lint
npm test                # unit tests (CDK assertions, adapters, entrypoint)
npm run synth:examples  # synthesizes every example; no AWS credentials needed
```

Node.js 22 or newer is required.

## Pull requests

1. Open an issue first for new connectors or public API changes.
2. Keep changes small. Update types, tests, examples and docs in the same PR.
3. Add tests that check IAM allow and deny behavior, not only snapshots.
4. Run `npx changeset` to describe user-facing changes.
5. Say clearly in the PR what is **implemented**, **unverified** and **planned**.
6. Never commit credentials, account IDs from real accounts, or `cdk.out`.

## Integration tests

`npm run test:integration` deploys real resources and costs money. It only runs with
`C3_INTEGRATION=1`, and needs Docker plus a bootstrapped account:

```bash
C3_INTEGRATION=1 AWS_PROFILE=<profile> AWS_REGION=us-east-1 npm run test:integration
```

Maintainers run it before releases.

## Code style

- TypeScript strict mode. No `any`, no unchecked casts.
- Prefer official CDK constructs and AWS SDKs over custom code.
- Error messages must tell the developer what to change.

By contributing you agree that your contributions are licensed under the MIT License.
