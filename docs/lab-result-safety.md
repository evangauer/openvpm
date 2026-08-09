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

The current result row is an efficient projection. Every creation,
pending-to-completed transition, clinical review, follow-up assignment,
reassignment, and completion also appends attributed immutable evidence in
`lab_result_events`. Each event preserves the exact result value, unit,
reference range, and clinical flag visible at that transition, so a later
review remains tied to the values actually reviewed. Database triggers reject
update/delete of this history, and composite foreign keys plus RLS prevent
cross-practice attribution. The Lab Inbox exposes this timeline on demand.

## Current boundary

This release intentionally covers manual entry, completion, review, and
follow-up evidence. It does not yet provide an entered-in-error,
correction/replacement, or cancellation workflow for a completed result. Do
not represent this as a full external-lab lifecycle or overwrite historical
values to simulate a correction. That attributed correction path is a
separate launch-blocking follow-up.

## Operational checks

- **Awaiting values** should contain only results for which the clinic still
  expects data.
- **Awaiting review** should be cleared by an authorized clinical reviewer.
- **Critical** is a cue, not an automated diagnosis. Clinic protocols still
  determine escalation.
- **Follow-up** must always show a named active teammate; ownership is stored
  on the lab result and does not depend on encounter status.
- Full-practice backups export and restore both the current result projection
  and immutable evidence. Older backups remain restorable and receive
  conservative completion/review timestamps from their last known record time.
