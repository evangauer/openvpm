# OpenVPM Roadmap

OpenVPM is building the modern, open, API-first foundation for veterinary software — the system AI agents and integrators can actually build on, and that clinics fully own.

This roadmap is a living document. The fastest way to influence it: [open an issue](https://github.com/evangauer/openvpm/issues), [start a discussion](https://github.com/evangauer/openvpm/discussions), or 👍 the ones that matter to you. ⭐ the repo to follow along.

For the operational boundary used in clinic evaluations, see the [Clinic Pilot Readiness Guide](docs/clinic-pilot-readiness.md). "Shipped" means the workflow exists in the product; external delivery, payment, and AI services still require the configuration called out below.

## ✅ Shipped

- Core PIMS: patients, clients, scheduling, medical records (SOAP, manually entered or in-house lab results, vaccinations, prescriptions), billing and invoicing, inventory, controlled-substance records, reporting, client portal, and an auto-refreshing shared whiteboard
- **Public REST API** (`/api/v1`) with scoped, per-practice API keys
- **OpenVPM Agent** — a typed tool layer with explicit write opt-in, available in-app or over `POST /api/v1/agent` when a supported model provider is configured
- **Scheduling engine** — strict conflict detection (doctor _and_ room), reschedule, open-slot availability
- **Clinical depth** — weight-based drug dosing calculator, vital signs, treatment plans linked to the problem list
- **Wellness plans / recurring billing**
- **Online appointment requests** via the client portal and public booking page; clinic staff confirm the final time
- **CSV import** for migrating clients & patients (pairs with full JSON export)
- **Appointment and vaccination reminder workflows** with administrator opt-in and configured delivery providers

## 🧪 Configuration-dependent / controlled pilot

- **Email delivery** requires a configured Resend provider and verified sending domain
- **Hosted SMS and two-way texting** require carrier-approved registration, recorded client consent, platform activation, and are limited to the controlled one-location clinic pilot
- **Client online card payments** require the clinic to complete Stripe Connect onboarding; manual payment recording works without it
- **OpenVPM Agent** requires a supported model API key, must be reviewed by clinic staff, and gates writes behind explicit opt-in
- **Migration and restore** require a dry run, validation, and operator-supported cutover for anything beyond the documented self-service CSV import

## 🔜 Next (no external dependencies — community PRs very welcome)

- Staff calendar UX: drag-to-reschedule on the live calendar (the API already supports it)
- Appointment waitlist
- Deeper agent tools and an audit trail for agent actions
- Embeddable online-booking widget for clinic websites

## 🌅 Later (needs integrations or larger design)

- Lab integrations (IDEXX, Antech, Zoetis) — order + auto-result matching
- **PIMS-compatibility connectors** — mirror an incumbent's public API so existing integrations work against OpenVPM, and so a clinic can keep a live, owned copy of their data
- Imaging / DICOM, electronic prescribing, card-present payment terminals, production multi-location operations, general-purpose bulk marketing campaigns, FHIR-inspired veterinary data standard, and a native mobile companion app

## How we prioritize

1. Does it help a real clinic do real work faster? (reduce staff hours)
2. Does it strengthen the open API / agent platform others build on?
3. Can the community own a piece of it? (we label [`good first issue`](https://github.com/evangauer/openvpm/labels/good%20first%20issue))

If something you need isn't here, tell us — that's how it gets prioritized.
