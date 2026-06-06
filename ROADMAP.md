# OpenVPM Roadmap

OpenVPM is building the modern, open, API-first foundation for veterinary software — the system AI agents and integrators can actually build on, and that clinics fully own.

This roadmap is a living document. The fastest way to influence it: [open an issue](https://github.com/evangauer/openvpm/issues), [start a discussion](https://github.com/evangauer/openvpm/discussions), or 👍 the ones that matter to you. ⭐ the repo to follow along.

## ✅ Shipped

- Core PIMS: patients, clients, scheduling, medical records (SOAP, labs, vaccinations, prescriptions), billing & invoicing, inventory, controlled substances, reporting, client portal, real-time whiteboard
- **Public REST API** (`/api/v1`) with scoped, per-practice API keys
- **OpenVPM Agent** — a typed tool layer + Claude tool-use runner; operate the practice in natural language, in-app or over `POST /api/v1/agent`
- **Scheduling engine** — strict conflict detection (doctor *and* room), reschedule, open-slot availability
- **Clinical depth** — weight-based drug dosing calculator, vital signs, treatment plans linked to the problem list
- **Wellness plans / recurring billing**
- **Self-service online booking** via the client portal
- **CSV import** for migrating clients & patients (pairs with full JSON export)

## 🔜 Next (no external dependencies — community PRs very welcome)

- Staff calendar UX: drag-to-reschedule on the live calendar (the API already supports it)
- Appointment waitlist
- Reminder scheduling (queue + due-list; delivery pluggable)
- Deeper agent tools and an audit trail for agent actions
- Embeddable online-booking widget for clinic websites

## 🌅 Later (needs integrations or larger design)

- Payments (Stripe) — online invoice payment + wellness-plan charge capture
- SMS / email delivery (Twilio / Resend) for reminders and two-way client comms
- Lab integrations (IDEXX, Antech, Zoetis) — order + auto-result matching
- **PIMS-compatibility connectors** — mirror an incumbent's public API so existing integrations work against OpenVPM, and so a clinic can keep a live, owned copy of their data
- Imaging / DICOM, multi-location, FHIR-inspired veterinary data standard, mobile companion app

## How we prioritize

1. Does it help a real clinic do real work faster? (reduce staff hours)
2. Does it strengthen the open API / agent platform others build on?
3. Can the community own a piece of it? (we label [`good first issue`](https://github.com/evangauer/openvpm/labels/good%20first%20issue))

If something you need isn't here, tell us — that's how it gets prioritized.
