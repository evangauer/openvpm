# OpenVPM Full Production Pass — 2026-07-03

Ran against the local branch build (`feat/sms-provider-abstraction`) on
`localhost:3003` in hosted mode at **$79** with Stripe **test**-mode webhooks
forwarding. Seeded clinic: Neighborhood Veterinary (92 clients, 107 patients,
191 appointments).

## 1. Visual walkthrough — every screen

All 17 captured routes returned **HTTP 200 with zero console/page errors**.
Screenshots: `test-results/walkthrough2/`.

| Screen | Verdict |
|--------|---------|
| Dashboard | Clean; onboarding checklist, stat tiles, upcoming appointments |
| Schedule | Day/Week/Month; real patient names (after fix); ⚠️ overlapping-appt layout bug |
| Patients | Strong table (40 patients), species/owner/sex/status |
| Patient detail | Allergy alert banner, Overview/Weight/Vitals/Vaccinations tabs, Download Summary |
| Clients | Clean list, resolves owners |
| Records | Functional but bare: search-first, empty until a patient is searched |
| Billing | Invoice list + expandable detail, line items, PDF/email, Record Payment; "Take Card" correctly disabled until Connect |
| Inventory | Products/Suppliers, stock-health tiles, 50 real vet products w/ cost + reorder points |
| Inbox | Real shared inbox: conversations, channels, staff assignment, "Set up texting" for SMS |
| Whiteboard | Live Waiting/In-Progress/Completed patient board; ⚠️ "Dr. Dr." doubled prefix |
| Controlled Substances | DEA-grade log: schedules II–V, administered/wasted, witness co-sign, balance summary |
| Reports | Range presets, Revenue/Appointments/Services/Inventory tabs, daily chart, CSV/PDF export |
| Settings | 10 tabs; Plan & Billing shows **$79**, Stripe Connect surface present |

**Overall:** visually polished and genuinely market-competitive. Consistent
design system, real clinical depth (allergies, controlled substances, whiteboard
flow, inventory), no runtime errors.

## 2. Bugs found

### FIXED this pass
- **"Unknown Patient" on Schedule / Dashboard / Whiteboard.** The
  `appointments.list` patient-name join requires
  `patients.clientId === appointments.clientId`, but `packages/db/seed.ts`
  mispaired the appointment's client (used the patient's array index instead of
  its `clientIdx`), so 106 of 184 seeded appointments showed "Unknown Patient".
  Fixed the seed to map the client by the patient's own `clientIdx`; re-seeded
  and verified **191/191 appointments now resolve**. (Note: the hosted
  new-trial seed `seedDemoData` was already correct — real trial clinics were
  never affected; this only hit the `db:seed` demo, i.e. demo.openvpm.com.)

### Flagged (not fixed)
- **Schedule day-view overlaps (should-fix).** Concurrent appointments (multiple
  doctors at the same time) z-stack in one column and their text overlaps
  illegibly. Needs an interval-column-packing layout (side-by-side columns for
  overlapping events), like a standard calendar. Real multi-doctor clinics hit
  this constantly.
- **"Dr. Dr." doubled prefix (cosmetic).** `db:seed` stores vet names with the
  "Dr." honorific ("Dr. Sarah Chen") and the whiteboard renders `Dr. {name}`.
  Fix by standardizing: store `users.name` without the honorific (matches how
  real signups enter names). Touches a few render sites — do it deliberately.
- **Records landing is bare (minor UX).** Shows only a search box until a patient
  is searched; a recent-activity or recent-patients default would help.
- **Local-only artifact:** the `db:seed` clinic shows "Trial ended — read-only"
  under hosted billing because the seed doesn't set an active trial/subscription.
  Does not affect demo.openvpm.com (runs in billing-off demo mode) or real
  signups. Low priority; optionally have the seed set a trialing status.

## 3. Smoke test — $79 hosted flow (Stripe test mode)

`e2e/fresh-clinic-mock-launch.spec.ts` — 4 passed, 2 skipped:

- ✅ Hosted signup → card-collected Stripe Checkout at **$79/mo, 14-day trial,
  $0 due today**.
- ✅ `checkout.session.completed` webhook → practice `trialing` / `cloud` with
  real `cus_`/`sub_` IDs.
- ✅ Email verification gate → first login.
- ✅ Clinic-day writes through the UI: client, patient, appointment, SOAP note,
  invoices (sent/paid/draft).
- ✅ Patient photo upload round-trips to object storage (MinIO).
- ✅ Tenant isolation: a second clinic sees none of the first's data.
- ⏭️ **Stripe Connect Express onboarding** and ⏭️ **client invoice card payment**
  — SKIPPED. Blocked on a Stripe dashboard prerequisite (below).

## 4. Blocker: Stripe Connect platform profile

Connect is enabled, but creating a connected account still fails with
"Please review the responsibilities of managing losses for connected accounts."
Complete the **"responsibilities for managing losses"** section at
`dashboard.stripe.com/settings/connect/platform-profile`. This is a distinct
sub-step of the platform profile; once done, clinic Connect onboarding + client
card payments unblock, and the two skipped smoke-test legs will run.

## 5. What's left for a full real-PIMS go-live

External/decisions (see `docs/go-live-checklist-2026-07-03.md` for the full map):

- **Stripe:** create the LIVE $79 price; create the two LIVE webhook endpoints
  (client-invoice + Connect) and set their secrets; complete the Connect
  platform profile; decide `STRIPE_TAX_ENABLED`.
- **Resend:** webhook secret + support/company email addresses.
- **Ops:** `OPS_ALERT_WEBHOOK_URL` + `CRON_HEARTBEAT_URL` (both HARD health
  gates).
- **AI:** confirm the Gemini key is valid (or switch to Claude).
- **SMS:** Telnyx provisioning (deferred/advisory — safe to launch without).

Product polish for a "real PIMS" bar (post-launch OK):
- Schedule concurrent-appointment column layout.
- "Dr." name standardization.
- Records recent-activity default.
- Deeper multi-doctor / multi-room scheduling ergonomics.

Then: merge `feat/sms-provider-abstraction` → `app.openvpm.com` auto-deploys →
confirm `/api/health` green → real-card smoke test → live.
