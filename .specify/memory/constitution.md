<!--
Sync Impact Report
Version change: (unratified template) → 1.0.0
Modified principles: none (initial ratification — file previously held only placeholder tokens)
Added principles:
  - I. Tenant Isolation Is Non-Negotiable
  - II. Public API Contracts Are Frozen Promises
  - III. Test-First for Non-Trivial Logic
  - IV. Expand-Contract Migration Discipline
  - V. Self-Hostable, Open by Default
  - VI. Clinical and Financial Data Demand Extra Care
Added sections:
  - Technology & Workflow Constraints
  - Development Workflow & Community Communication
  - Governance
Removed sections: none (template placeholders replaced with concrete content)
Templates requiring follow-up: plan-template.md, spec-template.md, tasks-template.md,
  checklist-template.md were not modified by this command (out of scope per the
  constitution command's scope guard). Confirm on the next /speckit-plan run that their
  Constitution Check section can evaluate against the six principles above.
Deferred placeholders: none.
-->

# OpenVPM Constitution

## Core Principles

### I. Tenant Isolation Is Non-Negotiable
Every query touching clinic-owned data MUST be scoped by the owning practice
(e.g. `practiceId`) and MUST filter soft-deleted rows at the application layer,
on top of the PostgreSQL row-level security policies enforced at the database
layer. A cross-tenant read or write MUST be triaged and fixed as a security
incident, not a routine bug. Any schema or migration change touching
tenant-owned tables MUST pass the RLS tenant-isolation tests (`pnpm db:rls:test`)
before merge.
**Rationale**: OpenVPM stores patient, clinical, and billing records for many
independent clinics in shared infrastructure. Tenant bleed is the single most
damaging failure mode the product can have, both legally and for clinic trust.

### II. Public API Contracts Are Frozen Promises
The `/api/v1` REST surface and its webhook payloads are a contract independent
of the internal schema. Internal refactors MUST NOT change response shapes,
field semantics, or webhook payloads without a deliberate, versioned contract
change. Every public endpoint and mapper MUST ship with a mapper unit test and
a schema contract test (`schema.parse(...)`) that checks the external shape,
in addition to any dashboard-side tests. Route handlers MUST stay thin —
authenticate → validate → tenant-scoped query → map → respond — with business
logic living in shared library code, not the handler.
**Rationale**: integrators and AI agents build against this surface expecting
it to outlive internal changes; it is documented as the project's integration
moat, not an implementation detail.

### III. Test-First for Non-Trivial Logic
New branches, loops, parsers, dosing or financial calculations, and
security-sensitive logic MUST ship with unit tests (Vitest), and MUST add
Playwright E2E coverage when they touch a user-facing flow. Pure logic
(mappers, validators, calculators) MUST be unit-testable without a database. A
change is not complete until `pnpm test`, `pnpm test:e2e` where applicable, and
`pnpm build` (type-check + lint) pass.
**Rationale**: matches the testing workflow already documented in
CONTRIBUTING.md and protects clinical and financial correctness, where a
silent logic bug has real-world consequences.

### IV. Expand-Contract Migration Discipline
Schema changes to shared or production-reachable tables follow
expand → migrate → switch → contract. A single pull request MUST NOT combine an
incompatible schema contraction with the code that first depends on the
replacement shape. Committed migration history is append-only — a migration
that may have run in any shared environment MUST NEVER be edited. Production
uses committed migrations plus RLS re-apply and verification (`pnpm db:migrate`,
`db:rls`, `db:rls:test`); schema-push tooling (`db:push`) is a local/dev-only
convenience and MUST NOT be used against a shared environment.
**Rationale**: codifies the migration policy already in
`docs/repository-governance.md` so specs and plans don't propose migration
steps that are unsafe to run against live clinic data.

### V. Self-Hostable, Open by Default
Every feature MUST work, or degrade gracefully, for a self-hosted install with
no proprietary dependency. Cloud-only conveniences (hosted billing, hosted SMS,
managed AI model access) MUST be opt-in and MUST NOT be required for core
clinic workflows. A feature that depends on an unconfigured provider (email,
SMS, Stripe, an AI model) MUST fail closed with a clear setup notice rather
than silently no-op or crash. No feature may introduce per-provider pricing, a
self-hoster-disable-proof telemetry requirement, or a dependency that breaks
the "your practice, your data" promise.
**Rationale**: this is OpenVPM's stated product thesis — free, AGPLv3, and
self-hostable forever — and it is a correctness requirement for any plan, not
an aspiration.

### VI. Clinical and Financial Data Demand Extra Care
Controlled-substance, audit, billing, and clinical-record writes MUST be
append-only or explicitly reversible with an audit trail; none may be silently
overwritten. Security-sensitive or high-risk workflows — authentication, tenant
boundaries, billing, controlled substances, migrations — MUST carry audit
logging and MUST be called out explicitly in review, per
`docs/repository-governance.md`. Conservative defaults are required wherever a
wrong default could affect patient safety or practice finances (e.g. dosing
ranges, account lockout timers, payment state transitions).
**Rationale**: the product handles prescriptions, controlled substances, and
clinic billing; mistakes here are safety and legal incidents, not ordinary
bugs.

## Technology & Workflow Constraints

New work MUST fit the existing stack rather than introduce a parallel one
without an amendment to this document: Next.js (App Router) + TypeScript strict
mode + React on the frontend; tRPC with Zod validation and role-based access
control for internal dashboard APIs; Drizzle ORM + PostgreSQL 16 for storage;
Turborepo + pnpm workspaces for the monorepo. Tests use Vitest for units and
Playwright for E2E, co-located as `*.test.ts` next to the code under test. The
RBAC roles (Admin, Veterinarian, Technician, Front Desk, Viewer) are enforced
at the API layer; a new role or permission MUST be threaded through tRPC
middleware, not checked ad hoc in UI code. Existing security headers (CSP,
HSTS, Permissions-Policy, X-Content-Type-Options, X-Frame-Options,
X-XSS-Protection, Referrer-Policy) and the current rate-limiting/lockout model
MUST remain intact; changes to auth, sessions, or rate limiting require the
security-owner review path defined in `docs/repository-governance.md`.

## Development Workflow & Community Communication

Follow `docs/repository-governance.md` for branch flow (feature or fix branch
→ `development` → `staging` → `main`), required reviews, and release
discipline; specs, plans, and tasks generated for this repository MUST NOT
propose direct pushes to a protected branch or skipping a required check. Keep
pull requests small enough to review; incomplete work ships behind a
default-off flag with a named owner, activation criteria, and a removal date
rather than landing as an unfinished partial feature.

This is a public AGPLv3 repository. PR descriptions, commit messages, issues,
and any spec/plan artifact that lands in the repo MUST be written for the
project and the clinics it serves: no customer, prospect, or partner names; no
team-member names or first-person founder references; no internal deal,
conversation, log, or dashboard specifics. That context belongs in Jira (the
`OPENVPM` project) — link the ticket key instead. Agents coordinate feature
work through the Jira `OPENVPM` board per `CLAUDE.md` and
`docs/agents/jira-operating-manual.md`; this constitution governs spec/plan/task
quality, not ticket mechanics.

## Governance

This constitution governs how features are specified, planned, and broken into
tasks in this repository. It complements, and MUST stay consistent with,
`docs/repository-governance.md` (branch and release policy) and `CLAUDE.md`
(agent workflow and public-voice rules) — it does not supersede either.

Amendments require a pull request that updates this file, states the version
bump rationale, and goes through the same review this repository requires for
any other governance change. Versioning follows semantic versioning: MAJOR for
removing or redefining a principle, MINOR for adding a principle or materially
expanding guidance, PATCH for wording or clarification only. Every Spec Kit
plan and task list MUST be checked against these principles before
implementation; a violation requires either a documented, justified exception
in the plan's Complexity Tracking section or a redesign.

**Version**: 1.0.0 | **Ratified**: 2026-11-10 | **Last Amended**: 2026-11-10
