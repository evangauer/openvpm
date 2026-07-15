# Migrating to OpenVPM

Switching systems is the scary part of buying a PIMS. This guide makes it boring: export a few CSV files from your old system, import them in order, and your clinic is running with its own clients, pets, vaccine history, and medical history. Every import runs a **dry run first** and shows exactly what will be added, what is a duplicate, and what needs a fix, before anything is saved.

On OpenVPM Cloud we will also do this **for you**: send your exports to support and we hand back a ready clinic.

## What you can import today

| Data | File | Links by |
|---|---|---|
| Clients (pet owners) | clients CSV | deduped by email |
| Patients (pets) | patients CSV | owner's email |
| Vaccine history | vaccinations CSV | owner's email + pet name |
| Medical history (visit notes) | medical history CSV | owner's email + pet name |

Vaccine history is worth the extra file: overdue-vaccine lists, reminders, and the AI assistant all light up with real answers on day one. Medical history brings each pet's past visit notes across so the record is whole from the first appointment; every note keeps its original visit date.

Appointments and invoices can be brought over today via a guided (white-glove) migration; a full OpenVPM backup JSON can also be restored into a fresh practice.

## Column names: we speak your export's language

Headers are matched loosely (case, spaces, and underscores do not matter) and common synonyms are accepted, so most exports import without editing:

- **Clients**: `firstName`/`first`/`owner first name`, `lastName`/`surname`, `email`, `phone`/`cell phone`/`mobile`, `address`/`address1`/`street`, `city`, `state`/`province`, `zip`/`postal code`
- **Patients**: `clientEmail`/`owner email`/`email` (required, links the pet to its owner), `name`/`pet name`/`patient name`, `species` (accepts `dog`, `cat`, `bird`, `bunny`, `horse`, `lizard`, and more), `breed`, `sex` (accepts `M`, `F`, `MN`, `FS`, `neutered male`, `spayed female`), `dob`/`birthday`/`date of birth` (accepts `2019-03-05` and `3/5/2019` and `3/5/19`), `color`, `microchip`
- **Vaccinations**: `clientEmail`, `patientName`/`pet name`, `vaccine`/`vaccine name`, `date given`/`administered` (required), `next due date`/`due date`, `lot number`, `manufacturer`
- **Medical history**: `clientEmail`, `patientName`/`pet name`, `date`/`visit date`/`date of service` (required), and the note itself as either split SOAP columns (`subjective`/`history`, `objective`/`exam findings`, `assessment`/`diagnosis`, `plan`/`treatment`) or a single `notes`/`note`/`description` column. A standalone notes column fills the first empty SOAP section (Subjective when none are mapped), so nothing is dropped when your export keeps a separate reason-for-visit and notes column.

**A note on dates:** to be safe, use ISO dates (`2019-03-05`). Slash dates like `3/5/2019` are read as US month/day/year; if your old system exports day/month/year, save the date column as `YYYY-MM-DD` first so a visit is never filed under the wrong day.

## Exporting from your current system

- **AVImark**: Information Search → pull Clients and Patients → Results → Export → save as CSV. Vaccine history exports the same way from medical history. Your Covetrus rep can also produce full exports.
- **Cornerstone**: Reports → Client report and Patient report → save to CSV. IDEXX support can pull complete exports on request.
- **ezyVet**: Records dashboard → search Contacts and Animals → Export to CSV.
- **Shepherd**: Reports → export client and patient lists as CSV. For your full record set, ask Shepherd support for your data export; Shepherd is cloud based, so support sends the files.
- **Anything else**: any spreadsheet saved as CSV works. When in doubt, send us a sample row and we will confirm the mapping.

## Import order (it matters)

1. **Clients first.** Pets link to owners by email, so owners must exist before pets.
2. **Patients second.** Rows whose owner email is not found are reported, not guessed.
3. **Vaccinations third.** Doses link by owner email + pet name; duplicates (same pet, same vaccine, same date) are skipped automatically, so re-running a file is safe.
4. **Medical history last.** Visit notes link by owner email + pet name and keep their original visit date; duplicates (same pet, same date, same note) are skipped, so re-running a file is safe.

Where: **Settings → Data → Import**. Clients and patients can also be brought in during onboarding in the "Bring your real data" step; vaccine and medical history are done from Settings → Data. Each step shows a dry-run report first: rows parsed, rows that will import, duplicates, unmatched owners or pets, and per-row issues with row numbers.

## Getting your data OUT of OpenVPM

The door swings both ways, always: **Settings → Data → Export** gives per-entity CSVs (clients, patients, appointments, invoices) and a full JSON backup of every table, any time, no support ticket. Nightly encrypted backups run on Cloud automatically.

## Limits and safety

- Files up to 5 MB and 10,000 rows per import; split bigger exports.
- Imports never overwrite existing records; they only add, and duplicates are skipped by stable keys (client email; pet identity or microchip; dose identity; note identity of pet + visit date + text).
- Everything is tenant scoped and admin only.
