# Contributing to OpenVPM

OpenVPM welcomes code, documentation, translations, clinical terminology review,
and bug reports. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Report security issues through [SECURITY.md](SECURITY.md).

## Development setup

Use Node.js 24.22.1 from `.nvmrc`, pnpm 9.15.0 from `package.json`, and Docker.
The following setup is for a **new, empty local development database**:

```bash
git clone https://github.com/evangauer/openvpm.git
cd openvpm
git switch development
nvm use # if you use nvm
cp .env.example .env
# Set NEXTAUTH_SECRET in .env using: openssl rand -base64 32
pnpm install --frozen-lockfile
docker compose --env-file .env -f docker/docker-compose.yml up -d postgres minio minio-bootstrap
pnpm db:migrate
OPENPIMS_APP_DB_PASSWORD='local-openpims-app' pnpm db:rls
OPENPIMS_APP_DB_PASSWORD='local-openpims-app' pnpm db:rls:test
pnpm db:seed # once, on the new local database only
pnpm dev
```

Open http://localhost:3000. The [README Quick Start](README.md#quick-start)
lists the synthetic sign-in accounts. Keep real clinic data out of a shared demo.
For an existing checkout, apply pending migrations; do not reset or repeat the
non-idempotent seed as part of ordinary startup.

Keep `.env` at the repository root. `pnpm dev` loads it for the web app; a second
copy in `apps/web` is unnecessary. Existing shell exports and app env values
have precedence. Restart the dev server after changing the root env file, and
never commit secrets.

## Find and claim work

Browse the [good first issue label](https://github.com/evangauer/openvpm/labels/good%20first%20issue)
and comment on an issue before starting so a maintainer can confirm its scope.
For a new idea, open a [Discussion](https://github.com/evangauer/openvpm/discussions).
Docs, terminology glossaries, and focused bug fixes are useful first contributions.

## Workflow and review

1. Fork the repository and branch from current **`development`**.
2. Keep the change focused and link the issue it addresses.
3. Run the relevant checks:

   ```bash
   pnpm type-check
   pnpm test
   pnpm build
   pnpm verify:oss-release
   ```

   Stop the dev server before building; both use `apps/web/.next`.
   For a focused test, use `pnpm --filter @openpims/web exec vitest run lib/locale`.
4. Open the PR into **`development`** using the repository template. Reconcile
   a moved base and resolve review conversations before integration.
5. Follow [repository governance](docs/repository-governance.md) for required
   checks, reviews, staging acceptance, and production promotion. A feature PR
   does not authorize a production deployment.

The current `pnpm lint` command invokes Next.js's interactive ESLint setup when
no ESLint configuration exists. That prompt is not a completed lint check.

### PR checklist

- [ ] Targets `development` and links its issue.
- [ ] Relevant type checks, tests, build, and public-release scan pass.
- [ ] Behavior changes have meaningful regression coverage.
- [ ] Queries retain tenant scope and appropriate soft-delete filtering.
- [ ] Existing migrations remain unchanged; new migrations are append-only.
- [ ] UI changes include reproducible visual and interaction evidence.
- [ ] Auth, billing, migration, recovery, tenant, secret, or deployment risks are identified.

First-time fork CI may need maintainer approval. Previews remain subject to the
repository's quarantine controls; a skipped preview does not establish browser
acceptance. Required checks must pass before merging.

## Project structure and testing

- `apps/web/`: Next.js product, dashboard, and REST/tRPC APIs.
- `apps/docs/`: reserved documentation package; no standalone site on this branch.
- `packages/db/`: Drizzle schemas, committed migrations, RLS, and synthetic seed.
- `packages/api/`: shared Zod validators and API types.
- `packages/config/`: shared TypeScript and Tailwind configuration.
- `packages/email/`: email templates.
- `docs/help/`: staff guides.
- `e2e/`: Playwright tests, run with `pnpm test:e2e` and the appropriate local fixture.

Co-locate Vitest tests in `*.test.ts` or `__tests__/`. Opt-in database and browser
tests require their documented disposable fixtures; default unit tests do not
prove those integrations. Use TypeScript strict mode, existing Tailwind tokens,
tRPC for internal APIs, and Drizzle for database access.

## Adding a compatibility endpoint or target

The public REST API ([docs/api](docs/api/README.md)) is OpenVPM's integration
moat: integrators (and AI agents) plug into a frozen, vendor-shaped contract.
The layout makes adding endpoints — and entire vendor-compatible "targets" —
repeatable:

- **Route handlers**: `apps/web/app/api/v1/<resource>/route.ts`. Keep them
  **thin** — authenticate → validate → tenant-scoped Drizzle query → map →
  respond. No business logic or shape knowledge in the handler.
- **Auth**: call `authenticateApiKey(req, "<scope>")` from `lib/api-auth.ts`.
  **Every** query MUST be scoped by `ctx.practiceId` and filter
  `isNull(table.deletedAt)` — a cross-tenant read is a security bug.
- **Mappers**: `lib/compat/<target>/mappers.ts` holds **pure** functions that
  translate internal rows ↔ the target's shapes (enum crosswalks, date formats).
  The target's request/response shapes live in `lib/compat/<target>/schema.ts`.
- **A new target** (e.g. an existing PIMS's public API) is a new
  `lib/compat/<vendor>/` module plus an `app/api/compat/<vendor>/v1/` namespace —
  the auth, pagination, and error helpers are shared.

Every endpoint ships with mapper unit tests **and** a contract test
(`schema.parse(toApiX(row))`) so internal changes can't silently break the
public contract.

## Translations

The UI currently uses English. Locale formatting and selectable clinic regions
are separate from UI translation. See [the translation guide](docs/TRANSLATING.md)
for glossary work, language coordination, and the approval needed for a new
region or message-catalog foundation.

## Questions and license

Use [Discussions](https://github.com/evangauer/openvpm/discussions) for questions
and [issue templates](https://github.com/evangauer/openvpm/issues/new/choose) for
bugs. OpenVPM uses the [GNU AGPLv3](LICENSE); contributions use the same license.
