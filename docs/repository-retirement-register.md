# Repository retirement register

This register is the public owner-notice surface for branch and worktree
retirement. It complements the
[repository recovery ledger](repository-recovery-ledger.md); it does not replace
the preservation bundles or authorize an operator to delete an entry merely
because it appears below.

## Authority and clock

Snapshot basis: 2026-08-26 (America/New_York), with protected
`development` at `a5d4ead83a8de15a0c19a92a24e03dfe485ac679`, the protected
`staging` ref at `b2d07cd970dcb4b0fef276bcdeb0dbb105e6f6ca`, and deployed
`main` at `b2d07cd970dcb4b0fef276bcdeb0dbb105e6f6ca`. Ref equality does
not prove that a Staging artifact is deployed.

The retirement grace clock has **not started**. An item may be removed only
after the latest of all of these events and then fourteen full calendar days:

1. this exact proposed list is merged into `development` and owner notice is
   recorded;
2. the safety directory is copied to encrypted independent storage and the
   copy, custodian, and checksum verification are recorded privately;
3. isolated Development and replacement Staging resources pass credential and
   target-fingerprint canaries;
4. one governed `development` → `staging` → `main` cycle promotes the same
   immutable artifact with independent review and post-production evidence; and
5. a final live Orca/GitHub App/OAuth-grant audit confirms that no repository
   operation still depends on Orca.

No actual earliest deletion date exists until every prerequisite has a recorded
completion date. If all missing prerequisites and owner notice had completed on
2026-08-26, the earliest illustrative date would be 2026-09-10 in
America/New_York; this example is not an authorization or scheduled action.

## Proposed batch A: retire local worktree registrations only

After the gate, remove the two clean non-Orca worktrees below and delete only
their same-named local branches with non-force deletion. Retain the remote refs
during this first batch so rollback remains immediate.

| Local branch | Exact head | Tree | Merged PR | Evidence | Proposed action after grace |
| --- | --- | --- | --- | --- | --- |
| `codex/activation-event-coverage` | `247d20d9c37e4064874e62d19e2ec2d0af80c7bf` | `90edc9d97d0958fea5f8526e9844d7f452dd6826` | #116, merge `324fce818e10361e772e038e8ad4254af7c3f409` | Clean; zero unique commits; exact head is an ancestor of Development, Staging, and Main; no migration or deployment files | Remove worktree registration and checkout, then `git branch -d`; retain `origin/codex/activation-event-coverage` |
| `codex/activation-recovery` | `9359885ea009a51223add6609da104e139d01166` | `0a73888bf58d5dcb4345ddcc388efd3a32cab9b4` | #117, merge `fdc764de30e7ea604a281893f766df42b839f638` | Clean; zero unique commits; exact head is an ancestor of Development, Staging, and Main; no migration or deployment files | Remove worktree registration and checkout, then `git branch -d`; retain `origin/codex/activation-recovery` |

Immediately before any action, recheck exact head, clean status including all
untracked files, absence of nested/private material, protected-ref ancestry,
and the live remote rollback ref. Any drift is a fail-closed stop.

## Proposed batch B: retire four remote merged branches

These branches have no local branch or registered worktree, no open pull
request or base dependency, no environment/deployment role, and no commits
outside either current Development or deployed Main. Each live remote SHA is
the exact head of its durable merged pull request and remains reachable through
protected history.

| Remote branch | Exact head | Tree | Merged PR | Merge commit | Proposed action after grace |
| --- | --- | --- | --- | --- | --- |
| `fix/lockfile-tiptap` | `01e1d7a7bd02e1f197ddc0e1d586ad6aa27d5a60` | `c32ae3e5539e1972cca9f713b50c10c99653ada6` | #3 | `0635d46f8121042dc02741ee37db85dbf4638d68` | Delete exact remote ref after final revalidation |
| `feat/site-feedback` | `66863957b7a8da59213fe7563da0578bcd0c58af` | `5876974daff4e391a11300e00053b4db7d058a47` | #4 | `2fbd387c9e5c8f71cf53f40133739b4460187313` | Delete exact remote ref after final revalidation |
| `chore/relicense-agplv3` | `9a1cc2c88de105fdbe94ec451890318157a1d5ca` | `550b28254df004e395fdee7126a010027633e471` | #11 | `23b017748428ccb4366c58557b64fb4e88119ed0` | Delete exact remote ref after final revalidation |
| `chore/remove-apps-www` | `0621f072fedc5a2b1052669efdaadf2f222443e2` | `4e1b9dde80d555fb15dceede04d7b3a1eb9cfba5` | #22 | `478281988c33b510609e3f32c0213148a35bab4e` | Delete exact remote ref after final revalidation |

Before deletion, verify the live remote SHA still equals the recorded SHA, no
new pull request/base/deployment/issue dependency exists, and the exact commit
is still reachable from both protected histories. Use an exact refspec; never
use a wildcard or bulk-prune command. A deleted branch is recreated by pushing
its recorded head SHA under the same name.

## Orca-owned hold

Every PIMS worktree registered under Orca remains on hold. The Orca app and
runtime are stopped and must remain stopped during the grace audit. Persisted
Git evidence currently accounts for 22 PIMS Orca worktrees: 21 clean and one
with a separately preserved one-line migration-journal change. No Orca
worktree, branch, safety ref, credential, or integration is authorized for
removal by batches A or B.

The independent persisted-state audit produced the following exact PIMS
register. `bundle` means the exact head is present in the verified
complete-history `openvpm-all-refs.bundle`; `remote` means a same-SHA hosted
branch also exists. An ahead count on a merged feature head is not unpreserved
work: its exact pull-request head and merged result were separately verified.

| Orca worktree label | Branch | Exact head | State | Durable evidence | Disposition after all gates and grace |
| --- | --- | --- | --- | --- | --- |
| `main` | local `main` alias | `676f0b09d30a0a6f8804736fc7475cbd1f408d1a` | Clean; zero unique commits | bundle; protected histories | Retire stale control alias last among clean aliases |
| `openvpm-61-migration-integrity` | `evangauer/openvpm-61-migration-integrity` | `f5070f9a2d8ace9e238a7943aced4cc30991ddc7` | Clean; merged | PR #225; bundle; remote | Retire in merged-feature group |
| `openvpm-61-qa` | `evangauer/openvpm-61-qa` | `68062d077abf12014e7c7a816826f43cc6345eb5` | Clean; zero unique commits | bundle; protected histories | Retire superseded intermediate |
| `openvpm-61-qa2` | `evangauer/openvpm-61-qa2` | `48c918844f373de302beab90358bd63125b58f8f` | Clean; zero unique commits | bundle; protected histories | Retire superseded intermediate |
| `openvpm-62-readiness-audit` | `evangauer/openvpm-62-readiness-audit` | `676f0b09d30a0a6f8804736fc7475cbd1f408d1a` | Clean; zero unique commits | bundle; protected histories | Retire stale readiness alias |
| `openvpm-63-readiness-audit` | `evangauer/openvpm-63-readiness-audit` | `676f0b09d30a0a6f8804736fc7475cbd1f408d1a` | Clean; zero unique commits | bundle; protected histories | Retire stale readiness alias |
| `openvpm-63-rls-pool-reuse` | `codex/openvpm-63-rls-pool-reuse` | `8d405c5af5565492318c68c9122cb0234f78ac85` | Clean; merged | PR #226; bundle; remote | Retire in merged-feature group |
| `openvpm-64-readiness-audit` | `evangauer/openvpm-64-readiness-audit` | `676f0b09d30a0a6f8804736fc7475cbd1f408d1a` | Clean; zero unique commits | bundle; protected histories | Retire stale readiness alias |
| `openvpm-65-readiness-audit` | `evangauer/openvpm-65-readiness-audit` | `676f0b09d30a0a6f8804736fc7475cbd1f408d1a` | Clean; zero unique commits | bundle; protected histories | Retire stale readiness alias |
| `openvpm-66-patient-owner-search` | `codex/openvpm-66-patient-owner-search` | `ed0206806110735be286589c46bda9b948b551ca` | Clean; merged | PR #227; bundle; remote | Retire in merged-feature group |
| `openvpm-66-readiness-audit` | detached at old baseline | `676f0b09d30a0a6f8804736fc7475cbd1f408d1a` | Clean; zero unique commits | bundle; local aliases; protected histories | Retire stale detached readiness checkout |
| `openvpm-71-patient-merge-transaction` | `codex/openvpm-71-patient-merge-transaction` | `469fd8e66c7aa0b68195ab3c59247815805874f0` | Clean; merged | PR #234; bundle; remote | Retire in merged-feature group |
| `openvpm-73-treatment-plan` | `codex/openvpm-89-treatment-composer` | `6a913515aecc58b9c041be1fca640ad5c19bbf57` | Clean; merged; label/branch mismatch retained | PR #238; bundle; remote | Retire in merged-feature group |
| `openvpm-75-template-catalog-search` | `codex/openvpm-75-template-catalog-search` | `b6a834a65f7ec40b5cc6a5a223e5d92e5c07f364` | Clean; merged | PR #228; bundle; local ref | Retire in merged-feature group; bundle is required rollback |
| `openvpm-80-demo-rls-preflight` | `codex/openvpm-80-demo-rls-preflight` | `f3e75031b774b3d01d0f5fa335b348771e1fabc8` | Clean; merged | PR #229; bundle; remote | Retire in merged-feature group |
| `openvpm-80-finance-adoption` | `codex/openvpm-80-finance-adoption` | `6e5792a5951f828b3c18cd7997a1cf8fd6f92792` | Clean; merged | PR #231; bundle; remote | Retire in merged-feature group |
| `openvpm-83-history-filter` | `codex/openvpm-83-history-filter` | `fe5c91c2b64c772feb87c340318b026fc81d2e43` | **Dirty hold:** one unstaged newline-only migration-journal change | PR #235; bundle; remote; dirty-head and synthetic WIP refs; independent patch | No action until explicit WIP disposition; retire last after grace |
| `openvpm-85-baseline-timeout` | `codex/openvpm-85-baseline-timeout` | `b92becdb97a5f1bf4ed5c65a163a6afc91e4c60c` | Clean; merged | PR #232; bundle; remote | Retire in merged-feature group |
| `openvpm-86-client-search-literals` | `codex/openvpm-86-client-search-literals` | `ff803673104c42ccbd60ab10955b30d49270bf1a` | Clean; merged | PR #233; bundle; remote | Retire in merged-feature group |
| `openvpm-clinic-evidence` | `evangauer/openvpm-clinic-evidence` | `676f0b09d30a0a6f8804736fc7475cbd1f408d1a` | Clean; zero unique commits | bundle; protected histories | Retire stale evidence alias |
| `openvpm-safety-baseline` | `evangauer/openvpm-safety-baseline` | `676f0b09d30a0a6f8804736fc7475cbd1f408d1a` | Clean; zero unique commits | bundle; protected histories | Retire stale safety alias |
| `wreckfish` | `evangauer/website-health-check` | `acbb62566dbda354075fd5907159fe60a07d770b` | Clean; obsolete lifecycle-email ancestor; owner confirmation still required | PR #31 provenance; bundle; protected history | Retire obsolete alias only after recorded owner confirmation |

Execution order after the clock expires is: clean zero-unique aliases first,
clean merged-feature worktrees second, the owner-confirmation item only after
confirmation, the preserved dirty journal worktree only after its recorded WIP
decision, and the stale Orca `main` alias last.
Remove a worktree registration before considering its branch; branch deletion
requires a separate exact preservation and dependency recheck.

The wider Orca audit also found three live dirty worktrees belonging to a
different repository and six stale non-PIMS metadata records whose paths no
longer exist. They are outside this repository's cleanup scope, are not covered
by the PIMS preservation bundle, and must not be touched by this register.

## Explicit holds

The following are excluded from these batches:

- all five dirty repository areas and every branch/worktree that owns them;
- canonical `development`, `staging`, and `main` refs or working copies;
- retained evidence for PRs #202, #203, and #222;
- receipt/dunning, optional-email, near-expiry, Checkout, safety, and recovery
  refs;
- branches involving migrations, providers, billing, messaging, CI,
  deployment, uncertain ownership, or squash-equivalent but non-ancestor
  provenance; and
- any item that changes after this notice or gains a new owner/dependency.

## Execution record

No entry has been executed. For each future action, append the operator,
reviewer, timestamp, pre-action SHA/status proof, exact command target,
post-action canonical reachability proof, rollback verification, and links to
the cleanup summary. A failure or discrepancy stops the batch without moving
to the next item.
