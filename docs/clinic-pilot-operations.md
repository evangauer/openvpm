# Controlled clinic pilot operations

This runbook turns the [clinic pilot readiness boundary](clinic-pilot-readiness.md)
into a repeatable operating process. The first cohort is limited to connected,
single-location United States general-practice and house-call pilots. It is not
approval to market OpenVPM as a universal PIMS replacement.

The platform-admin pilot workspace keeps two kinds of evidence separate:

- **Product evidence** is derived from the underlying records: setup,
  activation, completed visit closeout, distinct clinic-use days, payment
  method, positive payment, and messaging readiness. An operator cannot edit
  these facts.
- **Operating decisions** are bounded, PHI-free fit checks, readiness checks,
  blocker codes, support cadence, next action, review time, and the pilot
  decision. Every change creates an immutable snapshot.

Saving a pilot review never sends a message, enables texting, buys or assigns a
number, changes a subscription, adds a payment method, or charges a clinic.

## 1. Qualify within one business day

Confirm every clinic-fit check before marking a candidate eligible:

1. The clinic is a supported general-practice or house-call workflow.
2. The clinic operates in the United States and accepts the first-cohort
   jurisdiction boundary.
3. One location is in scope.
4. The clinic accepts that a reliable internet connection is required.
5. The clinic will keep its existing PIMS authoritative during validation.
6. A clinic owner and a day-to-day champion are confirmed.
7. The target workflow is explicit and supported.
8. No unsupported feature is a must-have for the pilot.

Choose `not a fit` when a must-have depends on offline use, multi-location
production, herd/group medicine, automated regulatory reporting, or an
unavailable vendor integration. Record only the blocker category. Never paste
messages, patient or client details, credentials, payment data, or clinical
notes into pilot operations.

## 2. Approve readiness before real clinic work

All readiness checks, a verified clinic administrator, exactly one active
location, and zero open blockers are required before approval:

1. Test each in-scope staff role and device.
2. Agree on assisted migration or manual-entry scope.
3. Dry-run and reconcile a small representative sample.
4. Schedule the first real visit and name the staff involved.
5. Confirm export, backup, and rollback responsibilities.
6. Set the support cadence and next review time.

Select and successfully test the client communication path. Keep SMS out of
scope unless the separate carrier registration, consent, provider verification,
and exact clinic/location allowlist are complete. A tested email path is the
fallback while texting is unavailable.

## 3. Validate one golden clinic day

Run one real visit through the complete supported handoff:

1. Create or verify the client and patient.
2. Schedule and check in the appointment.
3. Record vitals and the encounter.
4. Finalize clinical documentation.
5. Record applicable services, vaccines, prescriptions, manual lab work, and
   consumables.
6. Complete billing or document the no-charge reason.
7. Complete discharge instructions, follow-up, and client handoff.
8. Export or retrieve the resulting record and confirm the rollback path.

The platform observes a candidate only when the non-seeded appointment has a
completed visit closeout. An operator must then explicitly validate that the
observed closeout represents real clinic work; system activity alone cannot
advance the pilot week. Creating a client and appointment is activation, not
proof of a completed clinic day.

Pause immediately for patient-safety, record-integrity, billing-integrity,
tenant-isolation, or unrecoverable workflow problems. Keep the prior PIMS as
the source of truth while the issue is investigated.

## 4. Run five clinic days

After the first visit succeeds, run the agreed workflow on five distinct local
clinic dates. Use a daily support cadence during this phase unless the clinic
and operator deliberately choose otherwise.

At each review:

- confirm the prior day's visits and billing closed correctly;
- inspect record, lab, follow-up, email, payment, and export exceptions;
- record only bounded blocker categories and the next action;
- set the next review time; and
- preserve the clinic's independent rollback path.

Five dates measure repeated use, not volume. A high appointment count on one
day does not substitute for a pilot week. Before graduation review, the
operator must attest that the five observed dates were real clinic operations,
not staff-created test work.

## 5. Decide within two business days

Graduation requires:

- completed clinic-fit and readiness checks;
- a verified administrator and one active location;
- no open blockers;
- activation and an operator-validated completed real visit;
- five distinct, operator-validated clinic-use days;
- a successfully tested email path, plus operational SMS when SMS is in scope;
- a payment method collected through signed subscription Checkout evidence;
- current hosted write access through an unexpired trial or active paid tier;
  and
- explicit golden-day and go-live acceptance attributed to a current verified
  clinic administrator.

Positive payment remains a separate signed Stripe milestone and is never
entered manually. A clinic can graduate while a legitimate free trial is still
running; the workspace must continue to show payment pending until a positive
subscription invoice succeeds.

Use these outcomes:

- **Graduated:** the supported workflow is accepted and the clinic can move to
  the agreed production scope.
- **Paused:** a safe, owned blocker has a clear next review date.
- **Not a fit:** a required workflow is outside the supported boundary. Close
  the pilot without implying that missing evidence is zero.

Do not extend a pilot to hide an undefined problem. An extension needs a
bounded blocker, an owner outside the patient record, a next action, and a
review date.

## 6. Evidence and retention

Retain the source export until migration acceptance, preserve reconciliation
counts, and take an OpenVPM export after acceptance. Pilot operations should
contain only non-sensitive codes and timestamps. Product records, billing
evidence, and provider evidence remain in their authoritative ledgers.

Platform operators may correct the current pilot projection through the admin
workspace. Every projection version must have a matching event at database
commit; each event preserves a PHI-free snapshot of the canonical source IDs,
timestamps, current billing access, and messaging state that passed the gate.
The application role cannot rewrite or delete event history. Ordinary clinic
sessions cannot read any pilot-cohort state.

## Escalation

- **Patient or record safety:** pause clinic work in OpenVPM and preserve all
  evidence.
- **Billing or payment integrity:** stop the affected checkout flow; do not
  retry charges blindly.
- **Data isolation or security:** treat as an incident and follow the security
  process.
- **Connectivity:** use the agreed connected-mode fallback; OpenVPM does not
  offer offline charting.
- **SMS:** disable clinic sending and use email until carrier and consent
  evidence are reviewed.

No dashboard can replace clinic sign-off. Graduation is a documented operating
decision supported by exact product evidence, an accepted workflow, recoverable
data, and a team that knows the fallback.
