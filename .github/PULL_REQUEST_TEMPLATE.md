## Summary

Brief description of what this PR does and why.

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactoring / code quality
- [ ] Documentation
- [ ] Other (describe):

## Target and Risk

- [ ] Feature/fix PR into `development`
- [ ] Release promotion from `development` into `staging`
- [ ] Production promotion from `staging` into `main`
- [ ] Changes auth, billing, migrations, tenant isolation, deployment, or secrets

Risk and blast radius:

Rollback or recovery plan:

## Testing

- [ ] `pnpm type-check` passes
- [ ] `pnpm build` succeeds
- [ ] Tested manually in a local dev environment
- [ ] Added/updated E2E tests (if applicable)
- [ ] Preview or staging smoke test completed (for promotions)

## Screenshots

If this affects the UI, include before/after screenshots.

## Checklist

- [ ] Code follows the existing style (TypeScript, Tailwind, tRPC patterns)
- [ ] No hardcoded secrets or credentials
- [ ] Database changes include schema updates in `packages/db/schema/`
- [ ] Database changes use backward-compatible expand/contract sequencing
- [ ] Existing migration SQL and snapshots were not edited
- [ ] New API endpoints include Zod validation and role-based access checks
- [ ] Deployment, workflow, auth, billing, and migration changes have an explicit owner review
