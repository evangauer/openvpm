# Repository recovery and cleanup ledger

This ledger is the review record for the 2026-08-25 repository consolidation.
It turns the branch and pull-request backlog into explicit recovery decisions.
It is intentionally conservative: an item remains preserved until its successor
has passed current checks and an owner approves the recorded disposition.

The deployed baseline for this ledger is `development`, `staging`, and `main`
at `b2d07cd970dcb4b0fef276bcdeb0dbb105e6f6ca`. The prior deployed baseline
`cc6fd16cc8d414f181d278546e2a1213300732a0` and the prior `staging` tip
`0f139422c331b1d57a7862a7d0aa7724055341db` remain in dedicated safety refs
and the verified offline all-refs bundle. The cleanup owner also holds separate
snapshots of every dirty worktree. Those archives may contain secrets or
private operational data and must not be pushed to GitHub or attached to a
pull request.

## Decision vocabulary

| Decision | Meaning |
| --- | --- |
| `governance` | Required control-plane work; review before any routine cleanup |
| `recover` | Valuable work; replay as a focused branch from `development` |
| `evidence-only` | Preserve for history and test ideas; do not merge wholesale |
| `recreate` | Close only after a current replacement pull request exists |
| `hold` | Ownership, product value, or safety impact is still unresolved |
| `close-approved` | All unique value is proven merged/preserved and closure is approved |

Only `close-approved` permits closing a pull request or deleting its remote
branch. Age, conflicts, or failing checks are never sufficient on their own.

## Open pull-request register

The counts and merge state below are the GitHub state observed on 2026-08-25.
They are evidence for triage, not acceptance evidence for the underlying code.

| PR | Topic | Observed state | Decision | Recovery boundary |
| --- | --- | --- | --- | --- |
| [#198](https://github.com/evangauer/openvpm/pull/198) | Encounter estimate conversion and medication charge handoff | Conflicting; 19 files | `recover` | Re-prove conversion, charge ownership, idempotency, and tenant boundaries separately |
| [#199](https://github.com/evangauer/openvpm/pull/199) | Auditable medication charge workflow | Stacked on #198; 39 files | `recover` | Extract only after #198 concepts are mapped; do not merge the stack base-to-tip |
| [#200](https://github.com/evangauer/openvpm/pull/200) | Onboarding conversion funnel | Conflicting; 16 files | `recover` | Reconcile with #221 and current analytics/privacy contracts |
| [#202](https://github.com/evangauer/openvpm/pull/202) | Subscription conversion lifecycle | Draft, conflicting; 15 files | `recover` | Reconcile with current billing and webhook idempotency code |
| [#203](https://github.com/evangauer/openvpm/pull/203) | First-clinic-win subscription conversion | Draft, stacked on #202; 58 files | `recover` | Separate product behavior from generated or fixture-heavy changes |
| [#204](https://github.com/evangauer/openvpm/pull/204) | SMS pilot activation preflight | Draft, conflicting; 13 files | `recover` | Security/operations review; preserve all default-off and fee-bearing interlocks |
| [#205](https://github.com/evangauer/openvpm/pull/205) | Clinic-launch integration stack | Draft, conflicting; 130 files | `evidence-only` | Umbrella branch contains the component stack; use it to trace provenance and tests, never as a wholesale merge |
| [#219](https://github.com/evangauer/openvpm/pull/219) | Patient merge and migration safety | Draft, conflicting; 13 files | `recover` | Database/RLS specialist review and fresh real-Postgres evidence required |
| [#220](https://github.com/evangauer/openvpm/pull/220) | pnpm/action-setup update | Behind; 2 files | `recreate` | Re-run Dependabot after governance baseline; retain pinning and supply-chain checks |
| [#221](https://github.com/evangauer/openvpm/pull/221) | Privacy-safe acquisition reporting | Draft, behind; 7 files | `recover` | Reconcile overlap with #200 and re-review reporting privacy |
| [#222](https://github.com/evangauer/openvpm/pull/222) | P0 one-click billing integration | Draft, conflicting; 136 files | `evidence-only` | High-risk integration aggregate; decompose billing, auth, migration, and operational changes into independently testable recoveries |
| [#224](https://github.com/evangauer/openvpm/pull/224) | Development dependency group | Behind; 7 files | `recreate` | Regenerate after baseline and review breaking toolchain changes separately |
| [#230](https://github.com/evangauer/openvpm/pull/230) | Production dependency group | Behind; 4 files | `recreate` | Split security fixes from broad upgrades and prove runtime compatibility |
| [#240](https://github.com/evangauer/openvpm/pull/240) | Repository governance | Rebase-merged and deployed as `b2d07cd9`; exact-SHA migration/release rehearsal, health, and smoke checks passed | `close-approved` | Governance value is in all three protected canonical branches; the source branch may be deleted after this ledger update merges |

The stacked work represented by #198-#205 has one integration tip in #205.
That containment is a preservation fact only; it does not make #205 a safe
release candidate. #222 is a separate large aggregate with substantial overlap
and must not be merged beside or on top of #205.

## High-priority branch-only recovery

These branches have valuable commits not represented by a current remote pull
request or a safe current branch. Their commits are present in the offline
bundle and dedicated safety refs.

| Source | Preserved tip | Main divergence at inventory | Decision | First review |
| --- | --- | --- | --- | --- |
| `feat/lifecycle-emails` | `24a3347ced908f725f72260667d6f48c2f701ee9` | 4 unique commits; 219 behind | `recover` via draft [#242](https://github.com/evangauer/openvpm/pull/242) | Narrow confirmation/cancellation recovery preserves post-commit state checks and idempotency; durable provider-failure redrive remains an explicit review risk |
| `feat/activation-funnel` | `09e4fadd41742103e6c8092a9497134138100759` | 3 commits at inventory; two already merged via #29, one stale UI-only tip remains | `evidence-only` | Review found no analytics implementation to recover; current empty states, onboarding redirect, and billing-state-aware trial badge supersede the remaining copy/route changes |
| `codex/onboarding-first-day-density` | `68959b3a3ca088b00144ac846e91e4ab266f5af6` | 1 unique commit; 32 behind | `recover` | Separate the committed onboarding polish from the much larger dirty worktree |

Twenty-two locally held worktree heads were absent from cached remote refs at
inventory time. They are preserved in the verified bundle. Each remains
`hold` until a domain owner maps it to current product behavior; no bulk push
or deletion is authorized.

The `feat/activation-funnel` source was re-reviewed against the deployed
baseline. Commits `3812e872` and `97b52c0a` are already represented by PR #29
and its merge commit `58d0cc42`. The remaining `09e4fadd` changes only trial
badge urgency/copy, client/patient empty-state presentation, and deletion of
the `/onboarding` route; it contains no analytics capture, aggregation, or
privacy filtering. Current code has role-aware and error-safe empty states,
retains `/onboarding` as a compatibility redirect, and models trial/billing
states without the old pressure-oriented copy. The focused current-base suites
`analytics-privacy.test.ts`, `dashboard-onboarding-ui.test.ts`,
`trial-badge-ui.test.ts`, and `funnel-analytics.test.ts` passed (28 tests), so
no replay branch or successor pull request is needed. PRs #200 and #221 remain
separate recovery candidates with distinct provenance.

## Dirty-worktree register

Five worktrees contained uncommitted content at inventory time. Each has a
tracked patch or WIP bundle and a separate untracked-file archive where
applicable. The primary mixed worktree includes authentication/MFA, billing,
email security, docs, database, migration, and operational work and is not a
rebase candidate.

| Work area | State | Decision | Constraint |
| --- | --- | --- | --- |
| Primary mixed checkout | 148 tracked changes plus 153 detailed untracked entries | `hold` | Extract by domain; exclude private `outputs/`; resolve migration numbering first |
| GTM/CRO planning | Untracked planning documents | `hold` | Privacy and partnership-data review before publication |
| Nutrition extension | Tracked WIP plus a conflicting migration number | `recover` | Regenerate migration from the current development ledger |
| Resend incident hardening | Three unique commits plus lockfile WIP | `recover` | Separate security behavior from dependency churn |
| Orca history-filter worktree | One-line migration journal WIP | `hold` | Compare against current append-only migration history before recovery |

## Migration collision register

The primary mixed checkout contains untracked migrations numbered `0090`
through `0095`, while deployed `main` already contains `0090` through `0096`.
The local `0094` and `0095` names collide with different migrations on main,
and snapshot metadata diverges after `0090`. The nutrition worktree has another
untracked `0091`.

No migration or snapshot from these worktrees may be copied directly into a
recovery branch. Recover the intended schema change against current
`development`, generate new append-only numbers and snapshots, exercise the
upgrade from a production-shaped database, and re-run migration integrity,
drift, RLS, and rollback/forward-repair review.

## Recovery order

1. Land and rehearse repository governance without changing the production
   application or database.
2. Establish protected `development` and `staging` at the deployed baseline.
3. Recover lifecycle email behavior as the first branch-only loss-risk item.
4. Decompose #198-#205 into domain-sized recovery pull requests.
5. Review #219 independently because patient identity and migration safety are
   release-blocking boundaries.
6. Treat #222 as an evidence source and extract only changes not already
   recovered from the clinic-launch stack.
7. Recreate dependency updates from the then-current lockfile.
8. Publish a proposed closure list with successor links and a grace period.
9. Close or delete only entries that reach `close-approved`.

## Governance rollout evidence

PR #240 passed all required CI, CodeQL, RLS, migration-integrity, Vercel, and
independent P0/P1 review gates before it was rebase-merged. The actual merged
SHA `b2d07cd970dcb4b0fef276bcdeb0dbb105e6f6ca`—not the pull-request head—was
used for the protected Production migration run and both Vercel release gates.
The app and demo custom domains now resolve to deployments sourced from that
SHA, both health endpoints returned HTTP 200, and both release gates were
cleared after verification.

`development` was created and `staging` was fast-forwarded to that same
deployed SHA before protections were applied. All three refs are covered by an
active no-bypass ruleset requiring pull requests, strict core checks, resolved
review threads, and linear squash/rebase history while forbidding deletion and
non-fast-forward updates. Classic protection additionally enforces
administrators and forbids force-pushes and deletion. Development and Staging
GitHub environments are restricted to their matching branches, but contain no
deployment credentials; non-production deployment remains quarantined until
environment-specific credentials and canary isolation evidence exist.

The first `development` branch-creation push had an all-zero
`github.event.before` value, so the fail-closed migration-history job rejected
that one bootstrap event instead of comparing the commit to itself. The same
commit's `staging` fast-forward supplied a real prior SHA and passed all CI.
Normal pull requests into `development` provide a real base SHA; this ledger
update is the first protected-flow exercise of that path.

## Orca retirement gate and grace period

Orca is operationally frozen: its app and runtime are stopped, persisted state
contains no automations or automation runs, and the audit found no running
process, launch agent, cron entry, repository hook, scheduled workflow,
repository webhook, deploy key, or Orca-named collaborator. All 22 registered
Orca worktree heads are exact heads in the verified complete-history bundle.
The only dirty Orca byte—the final newline in the migration journal—matches
both its preserved full-index patch hash and synthetic safety commit
`e30bf89b066f031b6de978047f6f9d9dc4ff3382`.

That evidence authorizes keeping Orca stopped; it does not yet authorize
declaring formal retirement complete or deleting any Orca worktree. Formal
disable/revocation waits for isolated Development and Staging deployment proof,
a complete governed Development-to-Staging-to-Production release, a final live
Orca state capture, and a manual GitHub App/OAuth-grant audit. Global model and
host GitHub credentials are shared with non-PIMS work and must not be revoked as
if they were repository-specific.

The cleanup grace period is 14 calendar days starting when this ledger update
merges into `development`, and at least one complete governed
Development-to-Staging-to-Production release after isolated non-production
resources are enabled, whichever ends later. Before the clock starts, create
and verify an encrypted copy of the safety directory on independent storage and
record its custodian without publishing its location or secret-bearing
contents. Until the full gate and grace period are satisfied, do not remove or
prune Orca worktrees, delete their branches, or remove safety refs.

## Evidence required for a recovery pull request

Every successor records its source branch/PR and the exact commits consulted.
It must also provide:

- a narrow user or operational outcome;
- a current-base diff with no unrelated generated output;
- current CI and domain-specific tests;
- migration, tenant-isolation, auth, billing, provider, and privacy review when
  those boundaries are touched;
- rollout and rollback/forward-repair instructions; and
- confirmation that the old source can remain evidence-only or advance to
  `close-approved`.

This ledger is updated in the same pull request as each disposition. A cleanup
operation without a ledger update is out of policy.
