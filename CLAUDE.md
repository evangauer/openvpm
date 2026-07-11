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
