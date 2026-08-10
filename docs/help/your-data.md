# Your Data: Export, Backup, and Import

You own everything here. Export it any time. No lock-in, period.

Everything on this page lives in one place: **Settings → Data**.

## Export your data

- **CSV exports.** Download your clients, patients, appointments, or
  invoices as simple spreadsheet files.
- **Database backup.** Download your practice's structured data as one JSON
  file: every client, pet, saved SOAP draft, signed note with its attribution,
  correction, addendum, shot, lab, bill, payment, and attachment manifest.
  Click **Export Database Backup** and keep the file somewhere safe. Uploaded
  document and image bytes are not embedded in this JSON file.

On OpenVPM Cloud we also take this database backup every night and store it
outside the live database. Independent attachment-file replication is being
rolled out separately; until its recovery drill passes, do not treat the JSON
download as a complete attachment archive.

## Import your data

Switching from another system? Bring your clients, pets, and vaccine history
with you. Imports run in a strict order (clients, then patients, then
vaccines) and every import shows a **dry run** first, so you see exactly what
will happen before anything is saved. Imports never overwrite your records;
they only add.

The full step-by-step playbook, including how to export from AVImark,
Cornerstone, and ezyVet, is here:
[Switching to OpenVPM](../migrating-to-openvpm.md).

## Restore a database backup

A database backup can be restored into an empty practice. It rebuilds the
structured records, bills, and history. Restores check the file first, never
overwrite, and only add rows that do not already exist. If the backup contains
attachment manifests, that empty target must be the original practice; a
cross-practice restore fails before writing instead of creating broken links.

If you ever need this, we run it with you. The technical runbook is
[here](../backup-restore-runbook.md).

## Sample data

New practices start with a few sample pets so the app feels real on day one.
When you are ready for real work: **Settings → Data → Remove sample data**.
