# OpenVPM — Agent Operating Manual (Jira)

**Read this before you touch Jira.** Jira is the agent team's shared brain and
control plane: the queue of what to do, the record of what happened, and the
coordination layer that keeps multiple agents from colliding. Treat every issue
as durable shared memory — the next agent (or Evan) only knows what the issue says.

The governing principle: **the ticket is the quality ceiling.** Your output is
capped by the quality of the ticket that triggered it. A ticket with real
acceptance criteria, the right file paths, and a test plan lands close to
production on the first pass. A one-line ticket produces one-line-quality work.

---

## The board

- **Project:** OpenVPM — **key `OPENVPM`**, a team-managed **Software** project on
  the team's Atlassian site. Reach it through the Atlassian MCP; the site host and
  cloud id resolve at runtime (via `getAccessibleAtlassianResources`) and are kept
  in the team's private notes, not in this public repo.
- **Hierarchy:** **Epic → Task / Bug → Subtask**.
- **Access:** the Atlassian MCP (`mcp__claude_ai_Atlassian__*`) writes as the
  connected account, so your identity lives in **labels + comment signatures**
  (see Attribution).

## Issue types

| Type | Use for | Who creates it |
|------|---------|----------------|
| **Epic** | A lifecycle workstream / theme (see Epic spine below). | Humans, or agents *after asking*. |
| **Task** | Any feature or engineering/ops work. | Anyone. |
| **Bug** | A defect. | Anyone. |
| **Subtask** | A slice of a Task/Bug an agent finishes in one sitting. | The owning agent. |

Every actionable Task/Bug is attached to an Epic and filled out with the
**Golden Ticket template** below.

## Workflow — the state machine

```
Proposed ──▶ To Do ──▶ In Progress ──▶ In Review ──▶ Done
                            │
                            └──▶ Blocked ──▶ (back to In Progress / To Do)
```

| State | Meaning | Entry rule |
|-------|---------|-----------|
| **Proposed** | An idea an agent surfaced. **Not approved. Do not start.** | Agent proposes; a human triages it to To Do. |
| **To Do** | Triaged and spec'd — Definition of Ready is met. | Safe for an agent to pick up. |
| **In Progress** | Exactly one agent owns it right now. | WIP limit = **1 In Progress per agent**. |
| **In Review** | Work done, PR open, acceptance criteria checked. | The **human-approval gate**. |
| **Blocked** | Waiting on a dependency, a decision, or an external clock. | Must have a `[blocked]` comment saying what it waits on. |
| **Done** | Merged/shipped **and** verified. | A **human** moves any `risk:*` ticket to Done. |

## Your queue (JQL recipes)

- **Ready for an agent to pick up:**
  `project = OPENVPM AND status = "To Do" AND labels = agent-ready ORDER BY priority DESC`
- **What I'm currently holding:**
  `project = OPENVPM AND status = "In Progress"`
- **Needs a human decision:**
  `project = OPENVPM AND labels = needs-human`
- **Stuck / waiting:**
  `project = OPENVPM AND status = Blocked`
- **A whole workstream:**
  `project = OPENVPM AND parent = OPENVPM-<epic-number>`

## Attribution & the comment protocol (the message bus)

Because every agent writes as Evan's account, **identity lives in an `owner:*`
label + a signed comment prefix.** Comments are the audit trail; write them as if
the next agent has zero context.

- **On pickup** → move to *In Progress*, comment:
  `[agent:eng] plan: <2–4 bullets; name the files/modules you'll touch>`
- **As you go** → comment decisions and findings. Future agents replay this.
- **On finish** → move to *In Review*, flip each acceptance-criteria ☐ to ✅ in the
  description, comment:
  `[agent:eng] done: <what changed> · PR: <url> · tests: <command/screen/evidence>`
- **When stuck** → move to *Blocked*, comment:
  `[blocked] waiting on: <thing> · @Evan`
- **Signatures:** `[agent:eng]` `[agent:qa]` `[agent:gtm]` `[agent:ops]` `[agent:design]`.

## Labels — controlled vocabulary (do not invent new namespaces)

| Namespace | Values | Purpose |
|-----------|--------|---------|
| `area:*` | billing, onboarding, consult, comms, sms, scheduling, records, infra, marketing | What part of the product. |
| `owner:*` | eng, qa, gtm, ops, design | Which agent role owns it (routing). |
| `stage:*` | launch, testing, scale | Lifecycle phase. |
| `risk:*` | prod, money, security, data | High blast radius — **escalate, never auto-close.** |
| _(flags)_ | `agent-ready`, `needs-human` | `agent-ready` = safe to auto-pick-up. `needs-human` = a human must decide. |

## Guardrails

- **WIP = 1** In Progress per agent. Finish or Block before picking up the next.
- **`risk:*` tickets:** do the work and move to *In Review*, but only a **human**
  moves them to *Done*. Never auto-close anything touching prod, money, security, or data.
- **No destructive moves:** never delete issues, never bulk-transition, never edit
  another agent's comments.
- **One PR per ticket.** Link the PR in the *In Review* comment.
- **Missing spec?** If Acceptance Criteria or Definition of Ready is absent or
  ambiguous, do **not** guess — move it back to *To Do*/*Proposed* and comment
  `needs spec: <what's unclear>`.

---

## The Golden Ticket template

Paste this into the **description** of every actionable Task / Bug. This
template is the single highest-leverage thing in this manual.

```markdown
## Context / Why
<1–3 sentences: the user-facing problem or goal. Link the plan/memory/PR.>

## Scope
- In scope: …
- Out of scope: …

## Acceptance criteria  (the Definition of Done — flip ☐ to ✅ on finish)
- ☐ …
- ☐ …

## Technical notes
- Repo / branch: …
- Files / modules likely involved: `path/to/file.ts`
- Prior art / related PRs: #NN
- Constraints: RLS · migrations · env / feature flags · billing · demo-mode

## Test / verification plan
<How we'll know it works: a command, a screen to check, an e2e spec.>

## Definition of Ready  (must all be true before → In Progress)
- ☐ Acceptance criteria are testable
- ☐ Entry-point files identified
- ☐ Dependencies / blockers noted

## Links
Epic: OPENVPM-NN · Depends on: OPENVPM-NN · Plan/memory: …
```

---

## Epic spine (the lifecycle)

The build lifecycle lives in six standing Epics. Attach new work to the right one.

1. **Launch / Go-Live** — everything gating paid production (maps to the Gate
   A/B/C plan: money & comms plumbing, hardening, core vet functionality).
2. **Early Testing & Dogfood** — beta.openvpm.com, restore drills, security review.
3. **Scale** — multi-tenant performance, reliability, cost, observability.
4. **Ops & Incidents** — production incidents, on-call, runbooks.
5. **Growth & GTM** — marketing, onboarding funnel, activation.
6. **Bugs & Quality** — defects and quality debt not tied to a feature Epic.
