# Contributing to OpenVPM

Thanks for being here! OpenVPM is open-source (AGPLv3) practice management for veterinary clinics. Contributions of all sizes are welcome: code, docs, translations, clinical data review, and bug reports.

Please follow our [Code of Conduct](CODE_OF_CONDUCT.md). To report a security issue, use [SECURITY.md](SECURITY.md), not a public issue.

## Start here in 5 minutes

**Prerequisites:** Node.js 20+ (CI uses Node.js 24), pnpm 9.15.0 (pinned in `package.json`), Docker.

```bash
git clone https://github.com/evangauer/openvpm.git
cd openvpm
cp .env.example .env
# In the root .env, set NEXTAUTH_SECRET using: openssl rand -base64 32
pnpm install --frozen-lockfile
docker compose -f docker/docker-compose.yml up -d postgres minio minio-bootstrap
pnpm db:migrate
OPENPIMS_APP_DB_PASSWORD='local-openpims-app' pnpm db:rls
OPENPIMS_APP_DB_PASSWORD='local-openpims-app' pnpm db:rls:test
pnpm db:seed
# Temporary #327 workaround until the root-env fix is merged into main:
cp .env apps/web/.env.local
pnpm dev                        # http://localhost:3000
```

Keep `.env` at the repository root for database commands. Until the fix for
[#327](https://github.com/evangauer/openvpm/issues/327) is merged into `main`,
the web server also needs the temporary `apps/web/.env.local` copy shown above.
Update that copy after changing `.env`, then restart `pnpm dev`. Both files
are ignored by Git; never commit secrets. Once the fix lands, remove the
temporary copy so stale app values do not mask the root env.

The commands use only local PostgreSQL/MinIO and synthetic seed data. For the
seeded sign-in accounts, see the [README Quick Start](README.md#quick-start).
Use the [release checklist](docs/open-source-release-checklist.md) before
working with real clinic data.

Want to see it before installing? Use the [live demo](https://openvpm.com/demo). No card needed.

## Claim an issue

1. Browse [`good first issue`](https://github.com/evangauer/openvpm/labels/good%20first%20issue).
2. Comment "I'd like to take this". A maintainer can confirm ownership and assign you.
3. If there's no update for 7 days, the issue may be reopened for others. Just comment if you need more time.
4. Have your own idea? Open a [Discussion](https://github.com/evangauer/openvpm/discussions) first, so we can agree on scope before you write code.

## Workflow

1. Fork, then branch from **`main`** (for example `feat/waitlist-list-view`).
2. Make a small, focused change.
3. Run the checks:
   ```bash
   pnpm test          # unit tests (Vitest)
   pnpm type-check
   pnpm build
   ```
   To run a single package or file: `pnpm --filter @openpims/web exec vitest run lib/locale`
4. Open a PR into **`main`** using the PR template. Hosted production
   promotions still require the reviews and release evidence in
   [repository governance](docs/repository-governance.md).

The root `pnpm lint` script exists, but a fresh clone currently opens the
Next.js ESLint setup prompt because no ESLint configuration is committed.
Do not treat that prompt as a passing lint check or add lint configuration
to an unrelated PR. `pnpm build` runs Next's configured checks.

### PR checklist

- [ ] Targets `main`
- [ ] Linked issue (`Closes #123`)
- [ ] `pnpm test`, `pnpm type-check`, and `pnpm build` pass
- [ ] Tests added or updated for behavior changes (co-located `*.test.ts` / `__tests__/`)
- [ ] Every DB query is scoped by `practiceId` and filters `deletedAt`
- [ ] No edits to existing migrations (migrations are append-only and CI enforces it)
- [ ] Screenshots for UI changes
- [ ] Flagged if the change touches auth, billing, migrations, tenant isolation, or secrets

## Testing

- **Unit** (Vitest): `pnpm test`. Pure logic such as mappers and helpers should be tested without a database.
- **E2E** (Playwright): `pnpm test:e2e`.

## Project Structure

- `apps/web/` — Next.js product, dashboard, and REST/tRPC APIs
- `apps/docs/` — Placeholder docs package (no dev/build scripts yet)
- `packages/db/` — Drizzle ORM schema and migrations
- `packages/api/` — Shared Zod validators and types
- `packages/config/` — Shared TypeScript and Tailwind config
- `packages/email/` — Email templates
- `docs/help/` — Markdown staff guides

## Code Style

- TypeScript strict mode
- Tailwind CSS (follow existing design tokens)
- tRPC for all internal API endpoints
- Drizzle ORM for database queries

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

The UI is English-only today. String extraction hasn't started yet; the plan is in [docs/I18N.md](docs/I18N.md). You can help right now with:

- Locale formatting with tests and maintainer approval for new clinic regions
- Terminology glossaries

Start with [docs/TRANSLATING.md](docs/TRANSLATING.md) and join the existing efforts: Spanish (Latin America) in [#346](https://github.com/evangauer/openvpm/issues/346), Italian in [Discussion #34](https://github.com/evangauer/openvpm/discussions/34).

## Good first issues

See the [`good first issue`](https://github.com/evangauer/openvpm/labels/good%20first%20issue) label: formulary expansion, drag-to-reschedule, waitlist view, CSV import errors, booking widget, and locale formatting.

## Questions

- General questions and ideas: [Discussions](https://github.com/evangauer/openvpm/discussions)
- Bugs: [issues](https://github.com/evangauer/openvpm/issues/new/choose) (use the templates)
- Security: [SECURITY.md](SECURITY.md)

## License
OpenVPM is licensed under the GNU AGPLv3 ([LICENSE](LICENSE)). By contributing, you agree that your contributions are licensed under the same terms.
