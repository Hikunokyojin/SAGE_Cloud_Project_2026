# Contributing

Thanks for taking an interest in SAGE.

## Setup

```bash
npm install
npm test
npm run typecheck
```

Node.js 22 or newer is required. Both commands must pass before you open a pull request; CI runs them on every push.

## Workflow

1. Branch from `develop` (`feature/<short-name>` or `fix/<short-name>`).
2. Write the test first, then the change. Each agent has unit tests next to its source (`*.test.ts`); infrastructure properties are asserted in `infra/cdk/test`.
3. Keep changes focused, and use [Conventional Commits](https://www.conventionalcommits.org/) for messages (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
4. Open a pull request into `develop` and describe what changed and how you verified it.

## Guidelines

- **Never commit secrets.** `.env` files are ignored; production secrets live in AWS SSM Parameter Store. Do not put account IDs, keys or tokens in code, docs or issues.
- **Keep selection deterministic.** The Negotiator and Reviewer must not call an LLM; add model calls only to language-facing agents.
- **Keep IAM minimal.** Grant a role only the actions its own code calls, scoped to named resources. `infra/cdk/test/sage-stack.test.ts` enforces this.
- **Update the docs** (`docs/`, the README) when behaviour or architecture changes, and record catalogue changes in `data/CHANGELOG.md`.
