# Repository governance and release policy

This document defines the target operating model for repository changes and
hosted releases. The goals are to keep production stable, preserve valuable
work in progress, and make every release reviewable and recoverable.

## Canonical branches and environments

Changes move in one direction:

```text
feature or fix branch -> development -> staging -> main
                            |             |          |
                        Development    Staging   Production
```

| Branch | Purpose | Environment | Deployment rule |
| --- | --- | --- | --- |
| `development` | Integration branch for completed feature work | Development | Deploy automatically after required checks pass |
| `staging` | Release-candidate branch; no unrelated feature work | Staging | Deploy an immutable release candidate for acceptance testing |
| `main` | Audited production history and the deployed release line | Production | Deploy only an approved artifact already tested in staging |

All three canonical branches must be protected. Direct pushes, force pushes,
and branch deletion are disabled. Required checks and reviews apply to
maintainers and administrators as well as other contributors. A bypass is an
incident action, not a normal release mechanism, and must be recorded in the
incident timeline.

`main` is the source of truth for what is in production. A deployment is not
considered a production release unless its source commit and immutable artifact
identifier are recorded against `main`.

## Normal change flow

### Feature and fix pull requests

1. Create a short-lived branch from current `development`. Before review,
   rebase it on current `development` and resolve conflicts on the topic branch.
2. Open a pull request into `development`. Do not open feature pull requests
   directly into `staging` or `main`.
3. Describe the user or operational outcome, risk, test evidence, rollout
   controls, migration impact, and rollback limits. UI changes include visual
   evidence; security- or data-sensitive changes identify their threat and
   tenant-isolation considerations.
4. Obtain the required independent and code-owner reviews, resolve all review
   threads, and pass all required checks.
5. Merge using the repository's configured merge strategy. Delete the topic
   branch only after the merge is verified and no other pull request depends on
   it.

Keep pull requests small enough to review. If a feature must be integrated
before it is ready for users, put it behind a default-off flag with an owner,
activation criteria, and removal date.

### Release pull requests

1. Open a release pull request from `development` to `staging`. Its description
   lists the included pull requests, migrations, configuration changes, feature
   flags, operator actions, acceptance plan, and rollback constraints.
2. Freeze the release candidate while it is tested. A release-blocking fix
   branches from `staging`, returns to `staging` through a reviewed pull request,
   and is immediately forward-ported to `development`.
3. Build the release artifact once, deploy that immutable artifact to the
   Staging environment, and record its digest and source commit.
4. After staging acceptance, open a production release pull request from
   `staging` to `main`. The pull request must identify the exact artifact tested
   in staging and link the release evidence.
5. After production approval, advance `main` and promote the same artifact to
   Production. Do not rebuild the production artifact from a branch name.
6. Verify production health, migrations, tenant isolation, and a minimal smoke
   path. Record the result in the release.

If `development` advances while a release candidate is in staging, those later
changes wait for the next release. Do not merge `development` into a release in
progress merely to make the branches appear synchronized.

## Required reviews and checks

Every pull request into a canonical branch requires:

- at least one approval from a reviewer other than the author;
- approval from an applicable code owner for owned paths;
- all review conversations resolved and no outstanding change requests;
- a current base branch with conflicts resolved before final approval;
- successful `build`, `Migration history integrity`, and `RLS tenant
  isolation` CI jobs; and
- the testing, security, migration, and release evidence appropriate to the
  change.

Production release pull requests require a second approval from the designated
release owner. Changes involving authentication, authorization, tenant
boundaries, migrations, clinical records, billing, secrets, webhooks, provider
integrations, recovery, CI, or deployment configuration require approval from
the relevant security, data, or operations owner in addition to the normal
reviewer. Authors cannot approve their own pull requests or deployments.

Required checks must include the repository's existing public-release scan,
production-dependency audit, type check, automated tests, build, append-only
migration-history check, schema/migration consistency checks, and real-Postgres
RLS isolation tests. A flaky or unavailable check blocks a release until it is
fixed or an incident-scoped exception is documented and approved by both the
release and relevant code owner.

## CODEOWNERS policy

The repository must maintain `.github/CODEOWNERS` using teams or durable roles,
not a single individual's account. At minimum, it should assign ownership for:

- default repository-wide review;
- authentication, authorization, tenant scoping, and RLS;
- database schema, migrations, and recovery tooling;
- billing, messaging, email, webhooks, and external providers;
- CI workflows, deployment configuration, and release runbooks; and
- security policy and dependency controls.

Code ownership is a review boundary, not merely a notification list. Owners are
responsible for assessing failure modes, migration and rollback limits, data
exposure, and operational readiness in their area. Ownership changes require a
review from the existing owner or the repository maintainers and must not leave
a sensitive path unowned.

During the transition, the current maintainer account may bootstrap ownership
so sensitive paths are not left unowned. Replace that temporary entry with
durable teams before enabling independent code-owner approval as a required
merge condition.

## Database migration policy

Production migrations follow an expand-and-contract sequence:

1. **Expand:** add backward-compatible tables, columns, indexes, policies, or
   dual-read/write support. Committed migration history is append-only; never
   edit a migration that may have run in any shared environment.
2. **Migrate:** backfill in bounded, observable batches. Make retries safe,
   retain evidence of completion, and avoid long locks on live tables.
3. **Switch:** deploy code that uses the new shape only after the expansion is
   proven in Development and Staging. Keep rollback compatibility with the
   prior artifact for the declared rollback window.
4. **Contract:** remove old reads, writes, columns, tables, or policies in a
   separate release after the old application version and all backfills are
   confirmed inactive.

A pull request must not combine an incompatible schema contraction with the
code that first depends on the replacement. Production uses committed
migrations and reapplies and verifies RLS; it must not use schema-push tooling.
Before a high-risk migration, verify current backup and restore evidence,
estimate lock and runtime behavior, define abort thresholds, and identify
whether rollback means artifact rollback, a forward data repair, or restore.

## Production release control

The release pipeline must build an immutable artifact from the approved staging
commit, store its digest, and deploy that same digest to Staging and Production.
The production environment must require an explicit approval from a release
owner who did not author the release. Environment credentials are scoped to the
environment and unavailable to pull-request code.

Each production release record contains:

- the `main` commit, staging source commit, and immutable artifact digest;
- included pull requests and user-visible release notes;
- required-check results and staging acceptance evidence;
- migrations, configuration changes, feature-flag state, and operator steps;
- named approvers, approval time, and deployment time; and
- the rollback artifact and any database rollback limitation.

Production promotion is serialized: only one release or migration operation may
modify Production at a time. Health checks and smoke tests must complete before
the release is declared successful.

## Preview and non-production credential isolation

Pull-request code is untrusted until it has passed review. A preview deployment
must never receive a credential that can mutate Production, even when the
preview uses a separate database. Development and Staging require distinct
databases, auth/session secrets, mail/provider credentials, webhook endpoints
and signing secrets, object-storage credentials, billing test-mode keys, and
least-privilege cloud identities. Default-off provider and fee-bearing flags
remain off in both environments.

The 2026-08-25 audit found that `openvpm-app` Preview used a different database
but several Preview credentials had values identical to Production, including
Stripe, Resend, webhook, MFA, cron, and replica credentials. New non-production
builds are therefore quarantined in Vercel while credentials are separated and
rotated. The `openvpm` demo project already skipped non-production builds and
now remains under the same quarantine boundary. This is an incident-prevention
control, not the completed Development or Staging environment.

The initial containment narrowed shared Resend and auth secrets to Production,
removed only Preview credential entries proven byte-identical to retained
Production copies, removed the stale branch-specific build override, and
enabled Vercel Authentication for every app deployment except the customer
custom domains. The remaining app Preview secrets are limited to a distinct
database, auth secret, Blob token, and GCP service account; the demo Preview has
a distinct database only. This scoping—not the repository-owned ignore
script—is the security boundary, because pull-request code can modify its own
`vercel.json`. The ignore script remains defense in depth. Historical exposure
still makes the retained Production values rotation candidates.

Before enabling either canonical non-production branch:

1. provision environment-specific data stores and provider test accounts;
2. create new non-production credentials rather than copying Production;
3. remove every Production-capable credential from Preview and rotate any
   Production credential that was previously available to preview code;
4. configure explicit Development and Staging branch/environment mappings;
5. prove a canary pull request receives only its intended environment and
   cannot access Production data or providers; and
6. record the Vercel project, deployment, source SHA, variable-scope audit, and
   smoke-test evidence before lifting the quarantine.

The placeholder `openvpm-docs` project is separately quarantined with an
Ignored Build Step of `test ! -f .vercel-deploy-enabled`. Adding that sentinel
is an explicit release decision requiring a focused docs pull request, build
evidence, domains and environment review, and an owner. Package metadata alone
must not infer that unfinished docs WIP is ready to deploy.

## Rollback and incident path

When a release causes harm or threatens data, tenant isolation, security, or
availability:

1. Stop further promotions and name an incident lead.
2. Preserve logs and deployment evidence, identify the affected artifact and
   migration state, and disable the smallest relevant feature or integration if
   a safe kill switch exists.
3. If the database remains compatible, promote the last known-good immutable
   artifact. Do not rebuild an old branch.
4. If a migration or data write makes artifact rollback unsafe, hold the
   rollout and use a reviewed forward repair. Restore data only under the
   backup/restore runbook with an explicit data-loss and tenant-impact review.
5. For an urgent code repair, branch from `main`, use an expedited but reviewed
   pull request with the required checks, and deploy through the production
   approval gate. Immediately forward-port the repair to `staging` and
   `development`.
6. Record detection, decisions, approvals, customer impact, recovery, and
   follow-up work. Rotate credentials promptly if exposure is possible and
   complete a blameless post-incident review.

The incident lead may shorten timing, but may not silently waive auditability,
independent review, tenant-safety checks, or release recording.

## Branch and pull-request cleanup

Cleanup is an evidence-preservation exercise, not a bulk deletion event.
The active item-by-item decisions are recorded in the
[repository recovery and cleanup ledger](repository-recovery-ledger.md).

### Phase 0: Stabilize

- Pause nonessential production merges and all branch deletion.
- Declare the deployed `main` commit as the baseline.
- Back up repository metadata and record all open pull requests, remote
  branches, tags, and deployment-linked commits.
- Assign a cleanup owner and use a shared register for every branch and pull
  request.

### Phase 1: Inventory and classify

For each item, record its owner, purpose, base and head commits, open pull
request, last activity, unique commits, deployment history, dependencies,
migrations, security or tenant impact, and test state. Classify it as:

- merged or already equivalent to `main`;
- active and owned;
- valuable but needing recovery;
- superseded, abandoned, or generated; or
- unknown/high-risk and requiring specialist review.

No unknown or high-risk item is deleted merely because it is old.

### Phase 2: Recover valuable work

Recreate valuable changes as small, current branches based on `development`.
Prefer reviewed cherry-picks or a clean reimplementation over merging a stale
branch wholesale. Re-run current checks and give migrations, authentication,
tenant boundaries, billing, messaging, and provider changes specialist review.
Link the replacement pull request to the original so authorship and decisions
remain discoverable.

### Phase 3: Close superseded work

Close a pull request only after recording why it is obsolete, merged elsewhere,
or replaced, with a link to the successor when one exists. Delete its remote
branch only after confirming that all valuable unique commits are merged or
preserved and no open work depends on it. Require two-maintainer approval for
cleanup of a branch with migrations, deployment history, or uncertain ownership.

### Phase 4: Prune and maintain

After a published grace period, prune approved merged or superseded branches,
verify that canonical and release references remain reachable, and publish a
cleanup summary. Enable automatic deletion only for merged topic branches, not
canonical or release references. Repeat the inventory on a regular cadence so
the backlog does not regrow.

## Retiring Orca as repository authority

Orca worktrees and automation are not canonical repository state. Retire them
in a controlled handoff:

1. Freeze new work in Orca and inventory every Orca worktree, uncommitted
   change, unique commit, open pull request, automation, and credential scope.
2. Recover valuable work through reviewed branches and pull requests in the
   canonical flow. Preserve provenance by linking the source worktree or pull
   request in the cleanup register without publishing local paths or secrets.
3. Prove that Development, Staging, and Production deploy successfully under
   the new branch protections, environment approvals, and release recording.
4. Disable Orca jobs and repository write access, then revoke its credentials
   and webhooks. Verify that no required deployment, scheduled job, or recovery
   process depended on them.
5. Remove Orca worktrees only after all unique work is preserved and the grace
   period has passed.

Standard local clones and Git worktrees may still be used as working copies;
the protected remote branches, reviewed pull requests, immutable artifacts, and
release records remain authoritative.

## Transition note — 2026-08-25

This policy describes the target state, not controls that are already fully in
place. At the start of this transition:

- `main` is the deployed branch and automatically deploys today;
- `staging` exists but is stale and materially behind `main`;
- `development` does not exist;
- pull-request CI is configured for `main`, not all three canonical branches;
- the migration workflow runs from pushes to `main`;
- `.github/CODEOWNERS` does not exist; and
- protected-environment approval and exact-artifact promotion have not yet been
  established by this document alone.

Until the transition is complete, treat every merge to `main` as an immediate
production change. Do not use `staging` for release decisions while it is stale,
and do not delete branches or close pull requests before completing the
inventory.

The initial governance change adds a transitional fail-closed release lock.
Automatic Vercel builds from `main` are only candidates: a Production build
fails unless `PRODUCTION_RELEASE_SHA` equals that deployment's exact
`VERCEL_GIT_COMMIT_SHA`. Production migrations must be dispatched from `main`
with the same 40-character commit and the typed confirmation
`MIGRATE_PRODUCTION`. After migrations and drift checks pass, set the exact SHA
in each production-target Vercel project, redeploy that exact candidate, run
health and smoke checks, and then clear or rotate the value. Until protected
environment reviewers are configured, the SHA value is a kill switch and audit
aid—not proof of independent approval. It is superseded by build-once artifact
promotion when the target pipeline is ready.

The initial control rollout is:

1. Record the current deployed `main` commit and restrict `main` to approved,
   checked production changes.
2. Create `development` from that exact `main` commit.
3. Preserve the current `staging` tip, then fast-forward `staging` to the same
   baseline through a reviewed maintainer operation.
4. Add branch protection, CODEOWNERS, and required CI coverage for
   `development`, `staging`, and `main`.
5. Configure distinct Development, Staging, and Production environments with
   scoped credentials and production deployment approval.
6. Implement build-once artifact recording and promotion, then rehearse a
   normal release and rollback before resuming routine production delivery.
7. Run the phased branch and pull-request inventory, recovery, and cleanup.

Do not protect `development` or `staging` while they still point at the old
deployed baseline: that baseline's CI workflow emits canonical-branch checks
only for `main`, which would deadlock required checks. First merge, deploy, and
verify the governance commit on `main`; then create or fast-forward both
branches to that exact deployed SHA and apply their no-bypass protections.

Any step that would rewrite or delete a remote ref requires a preserved
reference, a reviewed change record, and explicit maintainer approval.
