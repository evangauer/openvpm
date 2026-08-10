# Migrating to OpenVPM

Switching systems is the scary part of buying a PIMS. This guide makes it boring: export a few CSV files from your old system, import them in order, and your clinic is running with its own clients, pets, vaccine history, and medical history. The supported workflow runs a **dry run first** and shows exactly what will be added, reconciled, skipped as a duplicate, or rejected before anything is saved.

On OpenVPM Cloud we can guide a reviewed migration. Do not email raw clinic
exports or other patient/client data. Email support only to arrange an approved
secure transfer method and agree on the mapping, validation sample, cutoff, and
acceptance checks.

## What you can import today

| Data                          | File                | Links by                                                     |
| ----------------------------- | ------------------- | ------------------------------------------------------------ |
| Clients (pet owners)          | clients CSV         | source client ID (preferred), then email                     |
| Patients (pets)               | patients CSV        | source patient ID (preferred), or owner reference + pet name |
| Vaccine history               | vaccinations CSV    | source patient ID (preferred), or owner reference + pet name |
| Medical history (visit notes) | medical history CSV | source patient ID (preferred), or owner reference + pet name |

Vaccine history is worth the extra file: overdue-vaccine lists, reminders, and the AI assistant all light up with real answers on day one. Medical history brings each pet's past visit notes across so the record is whole from the first appointment; every note keeps its original visit date.

Appointments and invoices are not available in the self-serve CSV importer. For
a pilot, enter them manually unless OpenVPM has separately scoped and validated
an assisted converter for that clinic's exact export. A full OpenVPM backup JSON
can also be restored into a fresh practice through the documented operator
restore process; it does not convert another vendor's backup.

## Column names: we speak your export's language

Headers are matched loosely (case, spaces, and underscores do not matter) and common synonyms are accepted, so most exports import without editing:

- **Clients**: `clientId`/`owner id`/`account number` (preferred stable source ID), `firstName`/`first`/`owner first name`, `lastName`/`surname`, `email`, `phone`/`cell phone`/`mobile`, `address`/`address1`/`street`, `city`, `state`/`province`, `zip`/`postal code`. Each row needs an email or source client ID.
- **Patients**: `patientId`/`pet id`/`animal id` (preferred stable source ID), `clientId`/`owner id`/`account number` or `clientEmail`/`owner email`/`email` (required owner reference), `name`/`pet name`/`patient name`, `species` (accepts `dog`, `cat`, `bird`, `bunny`, `horse`, `lizard`, and more), `breed`, `sex` (accepts `M`, `F`, `MN`, `FS`, `neutered male`, `spayed female`), `dob`/`birthday`/`date of birth` (accepts `2019-03-05` and `3/5/2019` and `3/5/19`), `color`, `microchip`
- **Vaccinations**: `patientId` (preferred) or `clientId`/`clientEmail` plus `patientName`/`pet name`, `vaccine`/`vaccine name`, `date given`/`administered` (required), `next due date`/`due date`, `lot number`, `manufacturer`
- **Medical history**: `patientId` (preferred) or `clientId`/`clientEmail` plus `patientName`/`pet name`, `date`/`visit date`/`date of service` (required), and the note itself as either split SOAP columns (`subjective`/`history`, `objective`/`exam findings`, `assessment`/`diagnosis`, `plan`/`treatment`) or a single `notes`/`note`/`description` column. A standalone notes column fills the first empty SOAP section (Subjective when none are mapped), so nothing is dropped when your export keeps a separate reason-for-visit and notes column.

**A note on dates:** to be safe, use ISO dates (`2019-03-05`). Slash dates like `3/5/2019` are read as US month/day/year; if your old system exports day/month/year, save the date column as `YYYY-MM-DD` first so a visit is never filed under the wrong day.

## Exporting from your current system

- **AVImark**: Information Search → pull Clients and Patients → Results → Export → save as CSV. Vaccine history exports the same way from medical history. Your Covetrus rep can also produce full exports.
- **Cornerstone**: Reports → Client report and Patient report → save to CSV. IDEXX support can pull complete exports on request.
- **ezyVet**: Records dashboard → search Contacts and Animals → Export to CSV.
- **Shepherd**: Reports → export client and patient lists as CSV. For your full record set, ask Shepherd support for your data export; Shepherd is cloud based, so support sends the files.
- **Anything else**: any spreadsheet saved as CSV works. When in doubt, share a de-identified sample through the approved secure channel and we will confirm the mapping.

## Import order (it matters)

1. **Clients first.** Pets link to owners by the persisted source client ID or email, so owners must exist before pets.
2. **Patients second.** Rows whose source owner reference is not found are reported, not guessed.
3. **Vaccinations third.** Doses link by source patient ID or owner reference + pet name; duplicates (same pet, same vaccine, same date) are skipped automatically, so re-running the same reviewed file is safe.
4. **Medical history last.** Visit notes link by source patient ID or owner reference + pet name and keep their original visit date; duplicates (same pet, same date, same note) are skipped, so re-running the same reviewed file is safe. Imported notes are labeled **Imported** in the record (and on the printed Medical Record Summary), so a migrated visit note is never mistaken for one written in OpenVPM.

Where: **Settings → Data → Import**. Clients and patients can also be brought in during onboarding in the "Bring your real data" step; vaccine and medical history are done from Settings → Data. Each step shows a dry-run report first: rows parsed, rows that will import, duplicates, unmatched owners or pets, and per-row issues with row numbers.

## Pilot operator checklist

The smallest supported production pilot is a reviewed clients-and-patients migration into a new practice before staff enter live records. Add vaccinations and medical history only after the clinic accepts the owner/patient links.

1. Record the practice, source system, clinic approver, operator, immutable source file names, source row counts, and cutoff time. Use the same migration source value for every related file.
2. Transfer files through the approved secure channel. Never use real patient data in the demo practice.
3. Dry-run clients, resolve every structural error, and explain all duplicate and reconciliation counts. Commit only the exact file the clinic administrator approved.
4. Dry-run patients, resolve every unmatched owner, and commit only after approval. Compare source/destination counts and spot-check at least ten owner/patient links, including duplicate pet names and records without email when present.
5. If needed, repeat the review for vaccinations and medical history, then spot-check patient links and dates. Convert ambiguous non-US slash dates to ISO (`YYYY-MM-DD`) before upload.
6. Manually enter or separately scope future appointments, open invoices/balances, active prescriptions, attachments, lab results, treatment plans, inventory, reminders, and communications. They are outside the self-serve CSV path.
7. Before go-live, clinic staff must find records, complete a test encounter, verify vaccine history, create a test invoice/payment or no-charge closeout, test roles, and verify an export.

Stop if the dry run has structural errors, unexplained matches, unmatched rows, or a different file/source than the approver reviewed. There is no one-click rollback for a committed CSV import. If a commit is wrong, stop and create a practice-scoped correction plan with support; do not repeatedly edit and re-run files in production. Schedule large imports before go-live or in a maintenance window because they can hold database locks while processing.

## Getting your data OUT of OpenVPM

The door swings both ways, always: **Settings → Data → Export** gives per-entity CSVs (clients, patients, appointments, invoices) and a full JSON backup of every table, any time, no support ticket. Nightly encrypted backups run on Cloud automatically.

## Limits and safety

- Files up to 5 MB and 10,000 rows per import; split bigger exports.
- A structurally malformed file (including duplicate or blank headers and rows with extra columns) is rejected before row mapping or database writes. Omitted trailing fields are treated as blank.
- Reviewed imports add records, skip stable duplicates, and may attach a missing source identifier to an unambiguous existing client or patient. They do not replace existing clinical or contact values.
- Replaying the same committed reviewed import returns the recorded result; database uniqueness constraints provide an additional duplicate-write guard.
- Imports are tenant scoped, protected by database row-level security, and admin only. The migration ledger stores hashes and aggregate counts, not raw CSV content or row-level patient data.
- Never attach raw clinic exports to an ordinary email or public issue. Contact
  support first to arrange an approved secure transfer method.
- Use the [clinic pilot readiness guide](clinic-pilot-readiness.md) before
  switching live clinic workflows.
