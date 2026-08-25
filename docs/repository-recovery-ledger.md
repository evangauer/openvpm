# Repository recovery and cleanup ledger

This ledger is the review record for the 2026-08-25 repository consolidation.
It turns the branch and pull-request backlog into explicit recovery decisions.
It is intentionally conservative: an item remains preserved until its successor
has passed current checks and an owner approves the recorded disposition.

The deployed baseline for this ledger is `main` at
`cc6fd16cc8d414f181d278546e2a1213300732a0`. The cleanup owner holds a verified
offline all-refs bundle plus separate snapshots of every dirty worktree. Those
archives may contain secrets or private operational data and must not be pushed
to GitHub or attached to a pull request.

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
| [#240](https://github.com/evangauer/openvpm/pull/240) | Repository governance | Draft; core checks pass | `governance` | Complete environment credentials, independent ownership, and release rehearsal before merge |

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
| `feat/lifecycle-emails` | `24a3347ced908f725f72260667d6f48c2f701ee9` | 4 unique commits; 219 behind | `recover` | Email event correctness, retries, privacy, and subscription-state semantics |
| `feat/activation-funnel` | `09e4fadd41742103e6c8092a9497134138100759` | 3 unique commits; 219 behind | `recover` | Product fit, current onboarding behavior, and analytics privacy |
| `codex/onboarding-first-day-density` | `68959b3a3ca088b00144ac846e91e4ab266f5af6` | 1 unique commit; 32 behind | `recover` | Separate the committed onboarding polish from the much larger dirty worktree |

Twenty-two locally held worktree heads were absent from cached remote refs at
inventory time. They are preserved in the verified bundle. Each remains
`hold` until a domain owner maps it to current product behavior; no bulk push
or deletion is authorized.

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
