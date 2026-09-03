# Contributing to OpenVPM

Thank you for your interest in contributing to OpenVPM!

## Development Setup

1. **Prerequisites**: Node.js 20+, pnpm 9+, Docker
2. **Clone and install**:
   ```bash
   git clone https://github.com/evangauer/openvpm.git
   cd openvpm
   cp .env.example .env
   pnpm install --frozen-lockfile
   ```
3. **Start services**:
   ```bash
   docker compose -f docker/docker-compose.yml up -d postgres minio minio-bootstrap
   pnpm db:migrate
   pnpm db:seed
   pnpm dev
   ```

## Project Structure

- `apps/web/` — Next.js product + dashboard and REST/tRPC APIs
- `apps/docs/` — Searchable Next.js staff-guide site
- `packages/db/` — Drizzle ORM schema and migrations
- `packages/api/` — Shared Zod validators and types
- `packages/config/` — Shared TypeScript and Tailwind config
- `packages/docs-content/` — Shared guide content and metadata

## Development Workflow

1. Create a feature branch from `main`
2. Make your changes
3. Run `pnpm test` (unit) and `pnpm build` (type-check + lint) to verify
4. Submit a pull request

## Testing

- **Unit tests** (Vitest): `pnpm test`. Co-locate as `*.test.ts` next to the code
  (e.g. `lib/compat/openvpm/__tests__/`). Pure logic — mappers, helpers — should
  be unit-tested without a database.
- **E2E tests** (Playwright): `pnpm test:e2e`.

## Code Style

- TypeScript strict mode
- Tailwind CSS for styling (follow existing design tokens)
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

## Good first issues

New here? These are scoped, self-contained, and well-tested — great first PRs.
Comment on the matching [issue](https://github.com/evangauer/openvpm/issues) (or
open one) to claim it.

- **Expand the drug dosing formulary** — add drugs with species-specific reference
  ranges to `apps/web/lib/dosing/formulary.ts`. Data-only, fully unit-tested
  (`apps/web/lib/dosing/__tests__/`). Keep ranges conservative and cite a source.
- **Drag-to-reschedule on the calendar** — the `appointments.reschedule` API
  already exists with conflict checking; wire it into the schedule UI.
- **Appointment waitlist UI** — build a staff-facing list on the existing
  tenant-scoped schema and tRPC router.
- **CSV import review UX** — deepen the existing Settings → Data flow with
  clearer row-level validation and issue resolution for supported import types.
- **Embeddable booking widget** — an iframe/script version of the client-portal
  booking flow (`apps/web/app/portal/[token]/book`).

Want to help but unsure where to start? Open a
[Discussion](https://github.com/evangauer/openvpm/discussions) and say hello.

## License

By contributing, you agree that your contributions will be licensed under the GNU AGPLv3.
