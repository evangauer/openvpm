# Lab result safety workflow

OpenVPM supports manual and in-house result recording today. External lab
ordering remains disabled until a real provider adapter is configured; this
workflow does not call a laboratory vendor.

## Clinic workflow

1. Add a result from **Records → Lab Results**. A result without values is
   `pending`. Entering values at creation records it as `completed`.
2. Open **Lab Inbox** to see every active clinic result, independent of whether
   its encounter is open or checked out.
3. Enter values for pending results. Set an explicit normal, abnormal, or
   critical flag when clinically assessed.
4. A veterinarian or administrator marks a completed result `reviewed`.
5. If client or patient work remains, assign follow-up to a named teammate,
   with an optional due time and instructions. Record follow-up completion in
   the same inbox.
6. If a manual result is a duplicate, typo, or belongs to the wrong patient,
   an administrator or veterinarian marks it **entered in error** with a
   permanent reason. The source leaves the active inbox, trends, and actions,
   but remains visible with attribution and its full event history.
7. Choose **Create replacement** when corrected evidence is needed. Confirm
   the destination patient (including a different patient for wrong-patient
   repair), then enter fresh values. The replacement and source link in both
   directions; the source row and evidence are never overwritten.

The current result row is an efficient projection. Every creation,
pending-to-completed transition, clinical review, follow-up assignment,
reassignment, and completion also appends attributed immutable evidence in
`lab_result_events`. Each event preserves the exact result value, unit,
reference range, and clinical flag visible at that transition, so a later
review remains tied to the values actually reviewed. Database triggers reject
update/delete of this history, and composite foreign keys plus RLS prevent
cross-practice attribution. The Lab Inbox exposes this timeline on demand.

Correction and amendment lineage is append-only too. The
`clinical_record_corrections` event identifies the entered-in-error source,
and `lab_result_replacements` identifies the exact new result, actor, and
operation. One source has at most one replacement, one replacement has at
most one source, and database constraints reject cross-clinic links and
cycles. Unresolved unbilled visit work is voided; charged and no-charge
financial history is retained. A replacement on an open same-patient visit
can create one new unresolved work item. The dashboard intentionally omits an
appointment for wrong-patient repairs; an API caller may deliberately attach
the correct destination patient's open appointment and create its work item.
Closed visits and source appointments from the wrong patient never inherit
billable work silently.

## Current boundary

This release covers manual entry, completion, review, follow-up, entered-in-
error correction, and attributed replacement. It is not an external-lab
ordering or cancellation integration; IDEXX, Antech, and Zoetis ordering stays
disabled until real provider adapters and credentials exist.

## Operational checks

- **Awaiting values** should contain only results for which the clinic still
  expects data.
- **Awaiting review** should be cleared by an authorized clinical reviewer.
- **Critical** is a cue, not an automated diagnosis. Clinic protocols still
  determine escalation.
- **Follow-up** must always show a named active teammate; ownership is stored
  on the lab result and does not depend on encounter status.
- Full-practice backups export and restore both the current result projection
  and immutable event/correction/replacement evidence. Older backups remain restorable and receive
  conservative completion/review timestamps from their last known record time.
