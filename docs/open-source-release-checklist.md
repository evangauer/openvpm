# Open-source release checklist

Use this gate before tagging a release, publishing a container, or merging a
clinic-specific migration branch into the public repository.

## Automated gate

```bash
pnpm verify:oss-release
pnpm install --frozen-lockfile
pnpm type-check
pnpm test
pnpm build
pnpm audit --prod --audit-level high
```

`verify:oss-release` examines only Git-tracked files. It fails when it finds a
private migration handoff artifact, a tracked environment file other than the
public example, a database/archive export, private-key material, or a missing
public setup/security file. It reports only the file and rule; it never prints
the matching value.

## Fresh-machine rehearsal

Run the Quick Start from the public `README.md` in a clean clone with no Vercel,
Supabase, or operator credentials present:

1. Copy `.env.example` to `.env` and replace every placeholder secret.
2. Start the Docker Compose PostgreSQL and MinIO services.
3. Install with the lockfile, migrate, apply RLS, and run the RLS test.
4. Seed the synthetic demonstration clinic.
5. Sign in, search for a synthetic patient, and open a chart.
6. Confirm `/api/health` reports `self-host` mode and no hosted service is
   required.

Never use a clinic backup or vendor export for this rehearsal. Public examples,
screenshots, tests, and issue reports must use synthetic data.

## Human release review

- Confirm the release notes describe schema migrations and rollback limits.
- Review authentication, tenant scoping, recovery-hold, upload, webhook, and
  provider changes as security-sensitive.
- Confirm no clinic name, contact detail, clinical value, tenant identifier,
  migration source value, or operator credential appears in the diff.
- Confirm `SECURITY.md` has a working private reporting channel.
- Confirm the container runs as documented behind HTTPS with a least-privilege
  database role and private object storage.
- Record the tested commit and the clean-clone rehearsal result.
