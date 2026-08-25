# Repository recovery and cleanup ledger

This ledger is the review record for the 2026-08-25 repository consolidation.
It turns the branch and pull-request backlog into explicit recovery decisions.
It is intentionally conservative: an item remains preserved until its successor
has passed current checks and an owner approves the recorded disposition.

The deployed baseline for this ledger is `staging` and `main` at
`b2d07cd970dcb4b0fef276bcdeb0dbb105e6f6ca`. Protected `development` has
advanced through reviewed recovery work to
`1e41d5d7b90906cddc3a227952f17def33c31e19`; that work has not been promoted
or deployed. The prior deployed baseline
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

## Pull-request register

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
| [#219](https://github.com/evangauer/openvpm/pull/219) | Patient merge and migration safety | Draft, conflicting; 13 files; historical real-PostgreSQL job failed on a nonexistent fixture table | `recover` | Database/RLS specialist review, corrected fixtures, and fresh real-Postgres tenant/concurrency evidence required |
| [#220](https://github.com/evangauer/openvpm/pull/220) | pnpm/action-setup update | Behind; 2 files | `recreate` | Re-run Dependabot after governance baseline; retain pinning and supply-chain checks |
| [#221](https://github.com/evangauer/openvpm/pull/221) | Privacy-safe acquisition reporting | Draft, behind; 7 files | `recover` | Reconcile overlap with #200 and re-review reporting privacy |
| [#222](https://github.com/evangauer/openvpm/pull/222) | P0 one-click billing integration | Draft, conflicting; 136 files | `evidence-only` | High-risk integration aggregate; decompose billing, auth, migration, and operational changes into independently testable recoveries |
| [#224](https://github.com/evangauer/openvpm/pull/224) | Development dependency group | Behind; 7 files | `recreate` | Regenerate after baseline and review breaking toolchain changes separately |
| [#230](https://github.com/evangauer/openvpm/pull/230) | Production dependency group | Behind; 4 files | `recreate` | Split security fixes from broad upgrades and prove runtime compatibility |
| [#240](https://github.com/evangauer/openvpm/pull/240) | Repository governance | Rebase-merged and deployed as `b2d07cd9`; exact-SHA migration/release rehearsal, health, and smoke checks passed | `close-approved` | Governance value is in all three protected canonical branches; source branch `codex/repository-governance` was deleted after PR #241 preserved the ledger evidence |
| [#242](https://github.com/evangauer/openvpm/pull/242) | Subscription lifecycle email recovery | Squash-merged into `development` as `1e41d5d7`; exact-head and exact-merge CI, CodeQL, migration, RLS, and PostgreSQL outbox gates passed | `close-approved` | Reviewed tree is preserved by the merge; successor branch `codex/recover-lifecycle-emails` and its clean worktree were deleted after tree-equivalence proof; original evidence branch `feat/lifecycle-emails` remains preserved |

The stacked work represented by #198-#205 has one integration tip in #205.
That containment is a preservation fact only; it does not make #205 a safe
release candidate. #222 is a separate large aggregate with substantial overlap
and must not be merged beside or on top of #205.

### Current-base triage checkpoint

The 13 still-open pull requests were re-audited against fixed
`development@1e41d5d7b90906cddc3a227952f17def33c31e19` after the lifecycle-email
recovery. None is safe to merge as-is: every item targets stale `main` or a
stale feature base, and the product branches are 36 to 51 Development commits
behind. Historical green checks are inventory evidence, not release evidence
against the current base.

The next safety/value queue is:

1. #219 patient-merge safety, because identity and merge errors can cause
   irreversible customer-data harm; its old real-PostgreSQL job failed against
   a nonexistent `merge_target_appointments` fixture.
2. #198 encounter/billing conversion, decomposed into billing ownership,
   medication handoff, idempotency, and tenant/concurrency proofs before stacked
   #199 is considered.
3. #221 privacy-safe acquisition outcomes, reconciled with #200 before either
   reporting model advances.
4. #204 default-off SMS pilot controls before any fee-bearing pilot activation.

#205 and #222 remain evidence-only aggregate sources until focused successors
preserve their unique value. #199 and #203 remain blocked behind their stack
bases. The three Dependabot pull requests remain `recreate`, not merge or bulk
rebase candidates.

## High-priority branch-only recovery

These branches have valuable commits not represented by a current remote pull
request or a safe current branch. Their commits are present in the offline
bundle and dedicated safety refs.

| Source | Preserved tip | Main divergence at inventory | Decision | First review |
| --- | --- | --- | --- | --- |
| `feat/lifecycle-emails` | `24a3347ced908f725f72260667d6f48c2f701ee9` | 4 unique commits; 219 behind at inventory | `close-approved` via merged [#242](https://github.com/evangauer/openvpm/pull/242) | Rebuilt as a transactional outbox with immutable attempts, final eligibility fencing, ambiguous-outcome handling, provider-safe redrive, and executable PostgreSQL concurrency/RLS evidence |
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

The current canonical Development migration tail is `0097`. The next available
ordinal appears to be `0098` only until another migration merges; migration
recoveries must be serialized and regenerate from the then-current tail.
Current-base review identified these explicit P1 no-go sources:

- #199 carries old `0086`-`0088` migrations/snapshots; its dispense-charge
  event and operation-identity semantics require a new current-tail migration.
- #203 carries an old `0086` migration/snapshot and overlaps the current
  conversion-evidence and milestone schema.
- #205 carries the aggregate old `0086`-`0089` sequence and remains
  evidence-only.
- #222 carries old `0094`-`0095` MFA migrations that collide with canonical
  finance and treatment migrations. Its `0091`-`0093` SQL is byte-identical to
  canonical history; the snapshots have matching schema content and lineage
  IDs but formatting-different bytes, so they still cannot replace canonical
  append-only history.
- The dirty primary checkout's older finance schema omits current composite
  tenant foreign keys. The dirty nutrition-extension migration also orders a
  composite foreign key before its required unique index and fails on clean
  PostgreSQL. Neither worktree is a rebase or copy source.

The dirty primary checkout also contains generated local
`supabase/.temp/linked-project.json` state linked to the production project.
Do not run mutating Supabase CLI commands from that checkout or commit/copy the
metadata. Canonical `.gitignore` excludes the entire generated
`supabase/.temp/` directory as a preventive control; the existing local file is
left untouched.

## Recovery order

1. **Completed:** land and rehearse repository governance without changing the
   production application or database.
2. **Completed:** establish protected `development` and `staging` at the
   deployed baseline.
3. **Completed:** recover lifecycle email behavior as the first branch-only
   loss-risk item through PR #242.
4. Review #219 independently because patient identity and migration safety are
   release-blocking boundaries.
5. Decompose #198-#205 into domain-sized recovery pull requests.
6. Treat #222 as an evidence source and extract only changes not already
   recovered from the clinic-launch stack.
7. Recreate dependency updates from the then-current lockfile.
8. Publish a proposed closure list with successor links and a grace period.
9. Close or delete only entries that reach `close-approved`.

## Governance rollout evidence

PR #240 passed all required CI, CodeQL, RLS, and migration-integrity checks;
its required Vercel statuses succeeded through the deliberate ignored-build
Preview quarantine. An independent agent-team P0/P1 release review also
[recorded a GO verdict](https://github.com/evangauer/openvpm/pull/240#issuecomment-5414736065)
before the rebase merge. The actual merged SHA
`b2d07cd970dcb4b0fef276bcdeb0dbb105e6f6ca`—not the pull-request head—was
then used for the protected Production migration run and both post-merge
Vercel release gates. The app and demo custom domains now resolve to
deployments sourced from that SHA, both health endpoints returned HTTP 200,
and both release gates were cleared after verification.

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
was proven by documentation-only PR #241 as the first protected-flow exercise
of that path; it merged as `f75c8580`. PR #242 then became the first protected
Development recovery with application and migration work.

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

The cleanup grace period is 14 calendar days starting at the later of this
ledger update merging into `development` and creation plus verification of an
encrypted safety-directory copy on independent storage. It also requires at
least one complete governed Development-to-Staging-to-Production release after
isolated non-production resources are enabled, whichever ends later. Record
the independent-copy custodian without publishing its location or
secret-bearing contents. Until the full gate and grace period are satisfied,
do not remove or prune Orca worktrees, delete their branches, or remove safety
refs.

The read-only worktree classification accounts for all 22 registered Orca
worktrees: 12 are exact merged heads or incorporated ancestors, eight are clean
stale baseline/readiness clones with no unique commits, one clean old ancestor
requires owner confirmation, and one contains the already-preserved final-newline
journal change. No unpreserved unique Orca WIP was found. This classification
is a future cleanup order, not deletion authorization: readiness clones first,
then merged-head worktrees, the owner-confirmation item only after confirmation,
the dirty journal worktree only after independent encrypted preservation, and
Orca's stale `main` worktree last.

The retirement gate is currently NO-GO because no independent encrypted copy
with custodian/date is evidenced, the grace clock has not started, Development
and Staging lack isolated deployment resources, no complete governed
Development-to-Staging-to-Production cycle has occurred, and final live Orca
state plus manual GitHub App/OAuth-grant audits remain outstanding.

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

## Lifecycle-email recovery evidence

PR #242 was rebased onto `development@f75c8580` and independently reviewed at
exact head `66b5238383e4f0131bc5cfc7cfc149ca3dbb06b5`. Five release-blocking findings
were closed before merge: the final practice-state eligibility fence, safe
classification of ambiguous Resend outcomes, per-job poison containment,
immutable attempt evidence, and executable PostgreSQL concurrency/isolation
coverage. The final review found no remaining code P0/P1.

The pull request passed full test/build, migration history, RLS tenant
isolation, CodeQL, and quarantined Vercel statuses. It was squash-merged only
into `development` as `1e41d5d7b90906cddc3a227952f17def33c31e19`.
Post-merge CI run `32888444655` and CodeQL run `32888444416` both passed on
that exact merge SHA, including the lifecycle-email database contract.
`staging` and `main` remained at the deployed baseline.

The reviewed head and merged commit have the identical Git tree
`56f2c1d70bd5ef7b7d60be4b51203b40695bc6e3`. Only after that proof, the merged
successor branch `codex/recover-lifecycle-emails` and its clean non-Orca
worktree were deleted. Original evidence branch `feat/lifecycle-emails` remains
preserved at its inventoried tip. Two local PostgreSQL databases created solely
for the release gate were dropped after the post-merge gate passed; they
contained disposable fixtures and remain reproducible from the committed test
script.

## Dependency update routing

Dependabot scheduled version updates are explicitly targeted at `development`
for both npm and GitHub Actions. GitHub reads this configuration from the
repository default branch, so the routing becomes operational only after this
governance change completes the reviewed promotion path to `main`; merging it
into Development alone does not change Dependabot behavior. See GitHub's
[`dependabot.yml` location contract](https://docs.github.com/en/code-security/concepts/supply-chain-security/about-the-dependabot-yml-file)
and [`target-branch` reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#target-branch).

Dependabot security updates are a documented exception: GitHub always opens
them against the repository default branch, which remains deployed `main`.
The npm grouping and open-pull-request-limit settings under the non-default
target also do not apply to those security updates.
Those pull requests are not implicitly approved for direct production merge.
Use the incident/hotfix path for an urgent release and immediately forward-port
it, or recreate the fix from current Development and close the default-branch
PR only after the successor is preserved. Existing PRs #220, #224, and #230
remain `recreate`; this routing declaration does not make their stale diffs
current or approve them for merge.
