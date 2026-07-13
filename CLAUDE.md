# CLAUDE.md

Instructions for Claude Code agents working in this repo.

## Project management — Jira (OpenVPM)

We run the OpenVPM build lifecycle on Jira. **Agents coordinate through the board:
read your queue there, and record your work there.**

- **Board:** Jira project **`OPENVPM`** via the Atlassian MCP (the site host + cloud id resolve at runtime and are kept out of this public repo).
- **Before working the board or picking up a ticket, read
  [`docs/agents/jira-operating-manual.md`](docs/agents/jira-operating-manual.md)** —
  it defines the workflow states, the label vocabulary, the Golden Ticket template,
  the comment protocol, and the guardrails.

Quick rules (full detail in the manual):

- **Your queue:** `project = OPENVPM AND status = "To Do" AND labels = agent-ready ORDER BY priority DESC`
- **Pick up** → move to *In Progress*, comment `[agent:<role>] plan: …`. WIP = 1 per agent.
- **Finish** → move to *In Review*, flip the acceptance-criteria ☐ to ✅, comment
  `[agent:<role>] done: … · PR: <url> · tests: <evidence>`.
- **Stuck** → move to *Blocked*, comment `[blocked] waiting on: … · @Evan`.
- Sign every comment with your role: `[agent:eng|qa|gtm|ops|design]`.
- **Never** delete issues, bulk-transition, or move a `risk:*` ticket to *Done* —
  those need a human.

## Public voice — PRs, commits, and issues

This is a public open-source repo. Pull request descriptions, commit messages,
and GitHub issues are community-facing. Write them for the project and the
clinics it serves, not as an internal changelog:

- Frame every change by the problem it solves for people using OpenVPM.
- No customer, prospect, or partner names. No team-member names or first-person
  founder references ("X promised", "X asked for").
- No internal specifics: deals, conversations and their dates, production log
  or request ids, dashboard links, account identifiers.
- Who asked, why now, and other context with names belongs in the private
  tracker (Jira) — link the ticket key instead.
- Product roadmap and decision records stay out of the repo. Internal
  journals, launch checklists, call notes, and strategy write-ups live in the
  private tracker. The exception is community-facing material that materially
  betters the open-source project (ROADMAP.md, user docs, runbooks).
