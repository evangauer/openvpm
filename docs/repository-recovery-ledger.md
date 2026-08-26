# Repository recovery and cleanup ledger

This ledger is the review record for the 2026-08-25 repository consolidation.
It turns the branch and pull-request backlog into explicit recovery decisions.
It is intentionally conservative: an item remains preserved until its successor
has passed current checks and an owner approves the recorded disposition.

The dated 2026-08-25 observations below remain part of the audit trail. They
must not be read as live inventory after the following authority checkpoint;
later dated checkpoints supersede current-state claims without rewriting the
earlier evidence.

The deployed baseline for this ledger is `staging` and `main` at
`b2d07cd970dcb4b0fef276bcdeb0dbb105e6f6ca`. Protected `development` has
advanced through reviewed recovery work to
`824913647c67e01c88d2c8afd534a86c82b8f78a`; that work has not been promoted
or deployed. The prior deployed baseline
`cc6fd16cc8d414f181d278546e2a1213300732a0` and the prior `staging` tip
`0f139422c331b1d57a7862a7d0aa7724055341db` remain in dedicated safety refs
and the verified offline all-refs bundle. The cleanup owner also holds separate
snapshots of every dirty worktree. Those archives may contain secrets or
private operational data and must not be pushed to GitHub or attached to a
pull request.

## Authority checkpoint — 2026-08-26

The protected `development` branch is now
`cb22872741db3b9d6a30784ec0b70e41dde03ce1`. The protected `staging` ref and
deployed `main` remain at `b2d07cd970dcb4b0fef276bcdeb0dbb105e6f6ca`;
Development-only recovery work has not been promoted, and this checkpoint does
not claim that Staging has a deployed artifact. The canonical Development
migration tail is now `0098_shallow_jackpot`; future schema work must generate
from the then-current tail and must not reuse a stale branch's `0098` or later
lineage.

### Current pull-request and recovery disposition

| Item | Current evidence | Decision and boundary |
| --- | --- | --- |
| [#256](https://github.com/evangauer/openvpm/pull/256) | Merged into Development as `cb228727`; reviewed head `fba0103b157ff990462c813fa42a6e652d876de3` and merge commit have identical tree `30e498c3192c9bdc2a83c7c204e3c5dda73e2420` | `close-approved`; pre-merge CI `32928960416` and CodeQL `32928958177`, and post-merge CI `32929333501` and CodeQL `32929332825`, all passed on their exact SHAs |
| [#202](https://github.com/evangauer/openvpm/pull/202) | [Closed unmerged as superseded/evidence-only](https://github.com/evangauer/openvpm/pull/202#issuecomment-5420726626) at retained remote head `bf2b16cc5f4e2a2c7d6e9941a27ed60879d2c3ea`; the draft remains conflicting against stale `main` | PR closure is `close-approved`; source code remains `evidence-only` and is not a merge, rebase, cherry-pick, file-copy, or migration source. #256 subsumes its near-expiry and exact Checkout/webhook identity behavior, current Development owns the authoritative `past_due` versus `unpaid` entitlement contract and recovery UI, and only the receipt/dunning rebuild remains through [#268](https://github.com/evangauer/openvpm/issues/268) |
| [#203](https://github.com/evangauer/openvpm/pull/203) | Closed unmerged after exact-head audit of preserved `8ccd86c63794c858f07e6d91b967fa65b209ae34`; current successors preserve approved value | PR closure is `close-approved`; source code remains `evidence-only`. Residual work is decomposed into [#257](https://github.com/evangauer/openvpm/issues/257), [#258](https://github.com/evangauer/openvpm/issues/258), [#259](https://github.com/evangauer/openvpm/issues/259), [#260](https://github.com/evangauer/openvpm/issues/260), and [#261](https://github.com/evangauer/openvpm/issues/261); never replay its colliding `0086` lineage |
| [#222](https://github.com/evangauer/openvpm/pull/222) | Closed unmerged after exact-head audit of preserved `bd82bbb2987a638776d3bf92dfe6809561cb8b19`; it remains conflicting and contains release-blocking provider, capability, MFA, and migration patterns | PR closure is `close-approved`; source code remains `evidence-only`. Residual work is decomposed into [#262](https://github.com/evangauer/openvpm/issues/262), [#263](https://github.com/evangauer/openvpm/issues/263), [#264](https://github.com/evangauer/openvpm/issues/264), [#265](https://github.com/evangauer/openvpm/issues/265), [#266](https://github.com/evangauer/openvpm/issues/266), and [#267](https://github.com/evangauer/openvpm/issues/267); never replay its colliding `0094`/`0095` lineage |
| Receipt/dunning recovery | `codex/recover-receipt-dunning-outbox@3dbc3ee42eb9c17f860d99a66c9bd7b6f15cbc98`, tree `b77ee94cd2c8da1bd7353f345b3ef8cd01611136` | Exact-head code-quality review is **GO**, but integration sequencing is **NO-GO**. [#268](https://github.com/evangauer/openvpm/issues/268) owns the current-base rebuild/rebase/release sequence. The evidence predates #256, overlaps the canonical quantity queue, and carries stale `0098`-`0100`; preserve it and rebuild/review the intended delta on then-current Development with fresh generated migration ordinals |
| Optional lifecycle marketing experiment | `codex/fix-lifecycle-email-provider-boundary@3fc5909aada2d5d16d55a9b9ec3eb5d0d75daae4`, tree `3c52bb47165360f859d95a5fdaa0ae6789da94a9` | `evidence-only`; its own commit is marked `[NO-GO]`, it is not a merge/cherry-pick source, and [#259](https://github.com/evangauer/openvpm/issues/259) owns a current-base durable provider-outside-transaction successor |

All twelve open issues are #257 through #268. Closing #202, #203, and #222 did
not delete their retained source branches, authorize a provider cutover, or
make their stale migrations reusable.

### Current inventory checkpoint

Read-only Git and GitHub inventory recorded 158 local branches, 151 `origin`
remote heads excluding `origin/HEAD`, and 105 registered worktrees. GitHub has
zero open pull requests, 253 closed-state pull requests (231 merged and 22
closed without merge), and twelve open issues. These 2026-08-26 counts
supersede, but do not alter, the dated 2026-08-25 counts below.

The dirty audit still identifies exactly five preserved areas: the primary
mixed checkout with 301 status entries, GTM/CRO planning with nine, nutrition
extension with 29, Resend incident hardening with one, and the Orca
`openvpm-83` history-filter worktree with one. No status was changed and no
branch, worktree, safety ref, or preserved source is approved for bulk deletion.

### Current promotion and approval gate

Development-to-Staging promotion remains **NO-GO**. The active canonical-branch
ruleset has no bypass actors and requires pull requests, strict build/migration/
RLS checks, resolved threads, linear history, and deletion/non-fast-forward
protection. It still requires zero approving reviews, no code-owner or last-push
approval, and no stale-review dismissal. GitHub still reports one collaborator,
who is the administrator. Staging and Production environment review names that
same user, permits self-review, and Development has no environment reviewer.
Development and Staging contain zero environment secrets and variables, so the
manual nonproduction migration paths remain intentionally inert.

The #256 exact-tree and green pre/post CI evidence approves that Development
merge only; it is not an independent GitHub approval and does not approve a
release. Before promotion, onboard an independent maintainer/release owner,
atomically enable independent branch and environment approvals, provision and
prove isolated Development credentials with a production-isolation canary,
build and record an immutable Staging artifact, and complete acceptance and
migration evidence for that exact artifact before advancing `staging` or
`main`.

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

## Pull-request register — 2026-08-25 observation

The counts and merge state below are the GitHub state observed on 2026-08-25.
They are evidence for triage, not acceptance evidence for the underlying code.

| PR | Topic | Observed state | Decision | Recovery boundary |
| --- | --- | --- | --- | --- |
| [#198](https://github.com/evangauer/openvpm/pull/198) | Encounter estimate conversion and medication charge handoff | Closed as superseded after #245 and #246 merged | `close-approved` | #245 owns refill closeout/history/locking; #246 owns atomic estimate conversion/versioning; original branch remains evidence-only provenance |
| [#199](https://github.com/evangauer/openvpm/pull/199) | Auditable medication charge workflow | Closed after exact-head no-go audit; stacked on #198 | `close-approved` | #247 recovered the live template medication-source guard; retained branch and remaining transition-ledger/exact-append concepts are evidence-only until fresh current-tail successors exist |
| [#200](https://github.com/evangauer/openvpm/pull/200) | Onboarding conversion funnel | Conflicting; 16 files | `recover` | Reconcile with #221 and current analytics/privacy contracts |
| [#202](https://github.com/evangauer/openvpm/pull/202) | Subscription conversion lifecycle | Draft, conflicting; 15 files | `recover` | Reconcile with current billing and webhook idempotency code |
| [#203](https://github.com/evangauer/openvpm/pull/203) | First-clinic-win subscription conversion | Draft, stacked on #202; 58 files | `recover` | Separate product behavior from generated or fixture-heavy changes |
| [#204](https://github.com/evangauer/openvpm/pull/204) | SMS pilot activation preflight | Draft, conflicting; 13 files | `recover` | Security/operations review; preserve all default-off and fee-bearing interlocks |
| [#205](https://github.com/evangauer/openvpm/pull/205) | Clinic-launch integration stack | Draft, conflicting; 130 files; all #198-#204 component heads are ancestors | `close-approved` | Its body says not to merge; retain the branch as aggregate provenance after closing the PR |
| [#219](https://github.com/evangauer/openvpm/pull/219) | Patient merge and migration safety | Closed after #244 merged the corrected current-base recovery | `close-approved` | #244 plus earlier #234 preserve the reviewed behavior and real-PostgreSQL/RLS proof; original branch remains evidence-only provenance |
| [#220](https://github.com/evangauer/openvpm/pull/220) | pnpm/action-setup update | Green but based on deployed main; both workflow files have since changed | `recover` | Apply only the immutable action SHA to current Development workflows, prove current CI, then close the original and retain its branch |
| [#221](https://github.com/evangauer/openvpm/pull/221) | Privacy-safe acquisition reporting | Draft, behind; 7 files | `recover` | Reconcile overlap with #200 and re-review reporting privacy |
| [#222](https://github.com/evangauer/openvpm/pull/222) | P0 one-click billing integration | Draft, conflicting; 136 files | `evidence-only` | High-risk integration aggregate; decompose billing, auth, migration, and operational changes into independently testable recoveries |
| [#224](https://github.com/evangauer/openvpm/pull/224) | Development dependency group | Stale main-based bot output; current email typecheck fails | `close-approved` | Retain the bot branch; regenerate from Development and split major toolchain upgrades |
| [#230](https://github.com/evangauer/openvpm/pull/230) | Production dependency group | Stale main-based bot output; current build/typecheck and Vercel checks fail | `close-approved` | Retain the bot branch; regenerate from Development and split security fixes from broad majors |
| [#240](https://github.com/evangauer/openvpm/pull/240) | Repository governance | Rebase-merged and deployed as `b2d07cd9`; exact-SHA migration/release rehearsal, health, and smoke checks passed | `close-approved` | Governance value is in all three protected canonical branches; source branch `codex/repository-governance` was deleted after PR #241 preserved the ledger evidence |
| [#242](https://github.com/evangauer/openvpm/pull/242) | Subscription lifecycle email recovery | Squash-merged into `development` as `1e41d5d7`; exact-head and exact-merge CI, CodeQL, migration, RLS, and PostgreSQL outbox gates passed | `close-approved` | Reviewed tree is preserved by the merge; successor branch `codex/recover-lifecycle-emails` and its clean worktree were deleted after tree-equivalence proof; original evidence branch `feat/lifecycle-emails` remains preserved |
| [#243](https://github.com/evangauer/openvpm/pull/243) | Cleanup control plane | Squash-merged into `development` as `2b0b6953` with exact-head and post-merge checks | `close-approved` | Repository governance and cleanup tests/ledger are canonical in Development; temporary branch removed after proof |
| [#244](https://github.com/evangauer/openvpm/pull/244) | Patient merge recovery | Squash-merged into `development` as `d8d12c4a` with current PostgreSQL/RLS evidence | `close-approved` | Corrected successor supersedes #219; evidence branch retained, temporary recovery branch removed |
| [#245](https://github.com/evangauer/openvpm/pull/245) | Visit-dispense closeout recovery | Squash-merged into `development` as `c7f3e25f`; source and merge trees match | `close-approved` | Current-base successor preserves the approved closeout slice from #198; temporary branch removed |
| [#246](https://github.com/evangauer/openvpm/pull/246) | Atomic estimate conversion recovery | Squash-merged into `development` as `38783d14`; source and merge trees match | `close-approved` | Current-base successor preserves conversion/version/inventory behavior from #198; temporary branch removed |
| [#247](https://github.com/evangauer/openvpm/pull/247) | Live medication-source template guard | Squash-merged into `development` as `570328eb`; forced deadlock schedules and exact post-merge checks passed | `close-approved` | First approved #199 successor slice; temporary branch removed after tree-equivalence proof |
| [#248](https://github.com/evangauer/openvpm/pull/248) | Environment control plane | Squash-merged into `development` as `82491364`; two review cycles, rebase-equivalence, and exact post-merge checks passed | `close-approved` | Inert code/runbooks only; no hosted resource, secret, mapping, quarantine, Staging, or Main change |

The stacked work represented by #198-#205 has one integration tip in #205.
That containment is a preservation fact only; it does not make #205 a safe
release candidate. #222 is a separate large aggregate with substantial overlap
and must not be merged beside or on top of #205.

### Current-base triage checkpoint — 2026-08-25

The ten still-open pull requests were independently re-audited against fixed
`development@824913647c67e01c88d2c8afd534a86c82b8f78a` after the environment
control-plane merge. None is safe to merge or rebase wholesale: every item
targets stale `main` or a stale feature base. Historical green checks are
inventory evidence, not release evidence against the current base.

The next safety/value queue is:

1. Reconcile #200 onboarding-funnel semantics with #221 privacy-safe acquisition
   outcomes and rebuild only a single current-base reporting model.
2. Rebuild #204 default-off SMS pilot controls against #248's fail-closed
   environment/provider contract before any fee-bearing activation.
3. Recover only independently validated trial/grace, entitlement, and
   webhook-CAS semantics from #202. The authoritative lifecycle-message
   delivery implementation is #242 and must not regress.
4. Decompose #203 after #202 into attribution schema, aggregate reporting,
   default-off campaign, and copy; generate any schema from the then-current
   migration tail.
5. Apply only #220's immutable `pnpm/action-setup` SHA to current Development
   workflows and re-run current supply-chain/CI gates.

#222 remains a high-risk evidence source until its unique Stripe money movement,
MFA/session/step-up, and replica-recovery behavior is separately inventoried.
#205 is approved for closure as an integration-only provenance stack; every
#198-#204 component head is independently preserved. #224 and #230 are also
approved for closure as reproducible, stale bot output that fails current
checks. Their source branches remain retained. #220 stays open until its narrow
current-base successor exists.

The stale migration lineages remain hard no-go inputs. #203's old `0086`
collides with canonical `0086`; #205 carries obsolete `0086`-`0089`; and #222's
MFA `0094`/`0095` collide with canonical finance/treatment history. Never replay
their journals or snapshots. Consolidate desired schema against current
Development and generate a serialized fresh-tail migration only when its
successor is implemented.

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

At this 2026-08-25 checkpoint, the canonical Development migration tail was
`0097`, and `0098` only appeared to be the next available ordinal until another
migration merged. Migration recoveries must be serialized and regenerate from
the then-current tail. The 2026-08-26 authority checkpoint above records the
subsequent canonical `0098_shallow_jackpot` merge.
Current-base review identified these explicit P1 no-go sources:

- #199 carries old `0086`-`0088` migrations/snapshots; its dispense-charge
  event and operation-identity semantics require a new current-tail migration.
- #203 carries an old `0086` migration/snapshot and overlaps the current
  conversion-evidence and milestone schema.
- #205 carries the aggregate old `0086`-`0089` sequence. Those obsolete
  migration artifacts remain evidence-only; closing the PR is approved while
  retaining its source branch.
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

## Phase 2 branch and worktree checkpoint

The 2026-08-25 follow-up inventory read current origin heads directly and
classified 153 local branches, 150 remote heads, and all 101 worktree
registrations present before the first cleanup. It also reconciled all 245 pull
requests: 223 merged, 12 closed without merge, and ten open.

The first cleanup removed exactly one dead Git metadata registration for the
nonexistent temporary path
`/private/tmp/openvpm-replica-diagnostic.loAEsk`. A repeated
`git worktree prune --dry-run --verbose` named only that path. No filesystem
content, branch, pull request, or commit was removed: its head `68959b3a` remains
at `codex/onboarding-first-day-density`, the dedicated active-tip safety ref,
and both verified safety bundles. A post-prune dry-run is empty.

The 100 valid worktrees in the audited pre-ledger cohort are intentionally
retained. This documentation review branch/worktree was created afterward and
is excluded from the checkpoint counts; it is a temporary merged-branch cleanup
candidate after exact post-merge proof.

| Classification | Count | Boundary |
| --- | ---: | --- |
| Canonical control | 1 | Clean non-Orca `pims-development` at exact protected Development |
| Orca-owned hold | 22 | Every registration below `/Users/evan/orca/workspaces/pims`; none may be removed before the retirement gate |
| Valuable preserved WIP | 11 | Dirty non-Orca worktrees plus clean worktrees backing open pull requests |
| Orphan or owner-unknown | 2 | Clean #219/#199 evidence worktrees; retain until product-value review completes |
| Merged or superseded candidates | 64 | Clean candidates only; future cleanup still requires grace-period and item-level approval |

Ninety-five audited worktrees are clean and five are dirty. The five dirty
areas remain the primary mixed checkout, GTM/CRO planning, nutrition extension,
Resend incident hardening, and the one-line Orca history-filter journal change.
Their tracked/untracked state is independently preserved. All 47 local-only
branch tips in the audited pre-ledger cohort are exact objects in the
complete-history bundle. The temporary ledger-review branch was created after
that bundle and is preserved by its eventual pull request and merge.

The local Orca `main` worktree is clean but stale at `676f0b09`; it is not
repository or production authority. No local `staging` branch/worktree exists;
the protected remote branch is authoritative. Four local refs differ from their
same-named origin refs (`codex/attachment-replication`,
`codex/validate-recovery-signature`, `feat/sms-provider-abstraction`, and
`main`) and must not be mistaken for current remote state.

## Promotion-control checkpoint — 2026-08-25

Development-to-Staging promotion remains **NO-GO** even though canonical branch
mutation controls are active and all required checks on Development `82491364`
passed. Pull requests, strict/current-base checks, linear history, resolved
threads, deletion protection, non-fast-forward protection, administrator
enforcement, and no-bypass rules are in place on all three canonical branches.

The remaining release-control blockers are explicit:

- canonical branches require zero approving reviews; code-owner review,
  stale-review dismissal, and last-push approval are disabled;
- the repository has only one collaborator, so no independent GitHub approval
  is currently possible;
- Staging and Production environment review is assigned to that same user,
  self-review and administrator bypass remain allowed, and Development has no
  reviewer;
- Development and Staging contain no deployment secrets or variables and their
  manual migration jobs are intentionally inert;
- Vercel continues to cancel Development, Staging, and pull-request candidates
  through the quarantine, while canceled contexts are reported as successful;
- the hosted app/demo configuration does not yet carry the required managed
  environment/release variables;
- no required-deployment rule or immutable artifact-promotion workflow proves
  that the artifact accepted in Staging is the artifact released from Main;
- CodeQL is not yet required on Development or Staging; and
- Production migration-ledger conformance remains intentionally deferred until
  historical `0086` provenance is reconciled.

Do not open a Development-to-Staging promotion pull request yet. First onboard
an independent maintainer/release owner, then atomically enable independent
branch and environment review. Provision isolated Development only after the
approved resource/credential gate, prove the credential-isolation canary, and
only then prepare replacement Staging and immutable promotion evidence.

## Recovery order

1. **Completed:** land and rehearse repository governance without changing the
   production application or database.
2. **Completed:** establish protected `development` and `staging` at the
   deployed baseline.
3. **Completed:** recover lifecycle email behavior as the first branch-only
   loss-risk item through PR #242.
4. **Completed:** replace #219 with the corrected current-base patient-merge
   recovery in #244.
5. **Completed for approved slices:** replace #198 with #245/#246 and recover
   the first approved #199 template-guard slice in #247. Remaining transition
   ledger/exact-append concepts stay evidence-only until fresh successors exist.
6. **Completed:** merge the inert, independently reviewed environment control
   plane in #248 without provisioning or changing hosted state.
7. Record and execute the first approved PR-closure batch (#205, #224, #230)
   while retaining all three source branches.
8. Reconcile #200/#221, then rebuild #204 on the current environment contract.
9. Recover only approved #202/#203 slices and serialize any new migration from
   the then-current tail.
10. Treat #222 as an evidence source and extract only changes not already
   recovered from the clinic-launch stack.
11. Recreate dependency updates from the then-current lockfile.
12. After independent storage and one governed promotion, publish the final
   branch/worktree deletion list and begin the 14-day grace period.
13. Close or delete only entries that reach `close-approved`; keep Orca and all
   dirty/unknown items on hold until their stricter gates pass.

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

PRs #243-#248 subsequently advanced only Development through independently
reviewed cleanup controls, patient merge, visit-dispense closeout, atomic
estimate conversion, medication template protection, and the inert environment
control plane. Final Development `82491364` passed exact post-merge CI run
`32907087580` and CodeQL run `32907087318`; its merge tree matches the reviewed
#248 source tree. Deployed `main` and `staging` remain `b2d07cd9`. No Supabase
or Vercel resource, credential, mapping, quarantine, Staging, or Main state was
changed by #248.

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

The cleanup grace period is 14 calendar days starting only after the latest of
all four prerequisites: this ledger update merges into `development`; an
encrypted safety-directory copy on independent storage is created and
verified; one complete governed Development-to-Staging-to-Production release
finishes after isolated non-production resources are enabled; and the exact
proposed deletion list is published with owner notice. Record the independent-
copy custodian without publishing its location or secret-bearing contents.
Until every prerequisite and the subsequent 14-day grace period are satisfied,
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
PR only after the successor is preserved. PR #220 remains open as `recover`
until its immutable action pin has a current-Development successor. PRs #224
and #230 are `close-approved` now as stale reproducible bot output; close their
pull requests while retaining both source branches, then regenerate future
dependency updates from current Development. This routing declaration does not
make any stale diff current or approve it for merge.
