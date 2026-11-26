# Shepherd migration support plan

This document defines the public, vendor-level contract. Clinic archives,
filenames, values, identifiers, row errors, and mapping evidence never belong
in the repository, issues, pull requests, CI logs, or test fixtures.

## Goal

Move the operational record a clinic needs to work in OpenVPM while preserving
source identity and documenting every record that was imported, deferred,
reviewed manually, or excluded. The same pipeline must work for another
Shepherd clinic. Other PIMS vendors plug into the same normalized domain plan.

## Supported migration surface

The reusable Shepherd adapter now supports:

- owners, patients, vaccinations, and locked SOAP history with stable source
  identity;
- non-sending care reminders;
- billable services and active products, with imported product inventory
  explicitly untracked until a clinic enters a reviewed opening quantity;
- co-owner/contact history, historical appointments, prescriptions and fills,
  lab reports, financial documents, line items, payments, and allocations as a
  read-only migration archive; and
- allowlisted PDF, JPEG, PNG, and plain-text documents through checksum-verified
  managed storage. A document without an exact source relationship remains
  unlinked and visibly needs review.

The same normalized tables, source identities, retry semantics, review states,
and operator UI are clinic-independent. A new Shepherd clinic supplies a new
private manifest and reviewed coverage plan; it does not require clinic-specific
code or fixtures.

## Shepherd CSV field mapping

Field names only. The importer reads normalized Shepherd headers. A linked row
appears on the patient chart. An unlinked row stays needs review in the
archive. Financial fields stay archive-only. Scalar laboratory values use the
live lab result field names on the chart and are not written into the lab
review inbox.

| Shepherd table.field | OpenVPM field | Placement |
| --- | --- | --- |
| client.id | clients.external_id | in record |
| client.firstname | clients.first_name | in record |
| client.lastname | clients.last_name | in record |
| client.email | clients.email | in record |
| client_phone.phonenumber | clients.phone | in record |
| client_address.address | clients.address | in record |
| client_address.city | clients.city | in record |
| client_address.state | clients.state | in record |
| client_address.zipcode | clients.zip | in record |
| client_patient.clientid | patients.client_id via clients.external_id | in record |
| client_patient.patientid | patients.external_id | in record |
| patient.name | patients.name | in record |
| patient.dateofbirth | patients.dob | in record |
| patient.color | patients.color | in record |
| patient.microchipnumber | patients.microchip_number | in record |
| patient.sexid | patients.sex | in record |
| patient.statusid | patients.status | in record |
| patient.isdeceased | patients.status | in record |
| vaccination.patientid | vaccination_records.patient_id | in record |
| vaccination.vaccinename | vaccination_records.vaccine_name | in record |
| vaccination.administrationdate | vaccination_records.administered_at | in record |
| vaccination.duedate | vaccination_records.next_due_date | in record |
| vaccination.lotnumber | vaccination_records.lot_number | in record |
| soap.patientid | soap_notes.patient_id | in record |
| soap.datelocked | soap_notes.finalized_at | in record |
| soap_subjective.initialcomplaint | soap_notes.subjective | in record |
| soap_subjective.history | soap_notes.subjective | in record |
| soap_subjective.currentmedicationinfo | soap_notes.subjective | in record |
| soap_assessment.description | soap_notes.assessment | in record |
| soap_plan.recommendation | soap_notes.plan | in record |
| appointment.startdate | historical_appointments.started_at | in record, not calendar |
| appointment.enddate | historical_appointments.ended_at | in record, not calendar |
| appointment.visitreason | historical_appointments.reason | in record, not calendar |
| appointment.appointmenttypeid | historical_appointments.appointment_type | in record, not calendar |
| appointment_patient.patientid | historical_appointments.patient_id | in record, not calendar |
| prescription.patientid | external_prescriptions.patient_id | in record, not dispensable |
| prescription.writtenproduct | external_prescriptions.medication_name | in record, not dispensable |
| product.name | external_prescriptions.medication_name | in record, not dispensable |
| prescription.direction | external_prescriptions.directions | in record, not dispensable |
| prescription.quantity | external_prescriptions.quantity | in record, not dispensable |
| prescription.refillcount | external_prescriptions.refill_count | in record, not refillable |
| prescription.datecreated | external_prescriptions.prescribed_at | in record, not dispensable |
| refill.prescriptionid | external_prescription_fills.prescription_id | in record |
| refill.datefilled | external_prescription_fills.filled_at | in record |
| refill.quantitydispensed | external_prescription_fills.quantity_dispensed | in record |
| lab_order.patientid | external_lab_reports.patient_id | in record when linked, else needs review |
| lab_order.orderid | external_lab_reports.accession_number | in record when linked, else needs review |
| lab_order.datecreated | external_lab_reports.ordered_at | in record when linked, else needs review |
| lab_order.testname | lab_results.test_name | in record only when the observation is scalar |
| lab_order.resultvalue | lab_results.result_value | in record only when the observation is scalar |
| lab_order.resultunit | lab_results.unit | in record only when the observation is scalar |
| lab_order.referencerange | lab_results.reference_range_low and reference_range_high | in record only when the range is a single low-high pair |
| lab_order.resultflag | lab_results.result_flag | in record only when the flag is normal, abnormal, critical, or unknown |
| invoice.clientid | legacy_financial_documents.client_id | archive-only |
| invoice.subtotal | legacy_financial_documents.subtotal | archive-only |
| invoice.tax | legacy_financial_documents.tax | archive-only |
| invoice.discount | legacy_financial_documents.discount | archive-only |
| invoice.total | legacy_financial_documents.total | archive-only |
| invoice.balance | legacy_financial_documents.balance | archive-only |
| invoice_item.invoiceid | legacy_financial_line_items.document_id | archive-only |
| payment.clientid | legacy_financial_payments.client_id | archive-only, or needs review when unlinked |
| payment.amount | legacy_financial_payments.amount | archive-only |
| payment_allocation.closedamount | legacy_financial_allocations.amount | archive-only |

## Operational versus historical state

- Owners, patients, vaccinations, finalized notes, care reminders, services,
  and the untracked product catalog can support current clinic work after the
  practice review hold is released.
- Historical appointments never create upcoming calendar work.
- Imported prescriptions and fills are clinical history, not a new prescription
  or authorization to dispense.
- Financial documents and payments are historical evidence, not live invoices,
  receivables, credits, or opening balances.
- A product can be billed while inventory is untracked, but it cannot be used as
  clinic stock. Stock tracking starts only through an explicit opening-count
  action.
- Imported co-owners are client contacts. They receive no portal account,
  permission, consent, or communication access from the migration.

## Reusable domain boundaries

- Source adapters emit only normalized domain records; tenant rows never
  depend on Shepherd filenames or private archive paths.
- Every supported row carries a practice-scoped source identity and a
  deterministic payload fingerprint. An exact retry is convergent; the same
  source ID with changed content fails closed.
- A reviewed preview is bound to aggregate decisions and exact target versions
  before commit. The durable migration ledger contains only hashes, counts,
  source namespace, lifecycle state, and operator identity.
- Source rows that share an ambiguous name/code or patient relationship are
  deferred together. File order is never used to choose a winner.
- Care-reminder imports create internal staff work only. They cannot create a
  communication, restore consent, or schedule a provider send.
- Service imports cannot create products, change stock, create invoices, or
  mutate existing manual catalog rows.

## Deliberate exclusions

- Vendor authentication, credentials, runtime settings, audit logs, and staff
  accounts are never portable.
- Historical invoices and payments are reference-only until OpenVPM can prove
  the opening balance without altering live accounts receivable or inventory.
- A source lab panel is kept as a typed document when its structure cannot be
  represented by OpenVPM's scalar lab result without losing meaning.
- Communication history never restores SMS consent, provider delivery state,
  or an outbound send queue.
- Historical stock quantities, lots, and expirations are not trusted as current
  inventory. A clinic must verify and enter an opening count.
- Source diagnoses or procedures without an exact patient/event relationship are
  not synthesized into clinical events. Existing locked source notes remain the
  evidence until a reviewed adapter can preserve their semantics without
  duplication.
- Unlinked document bodies remain available only in the migration archive and
  require a human relationship review before being treated as patient evidence.

## Commit safety

- Put the practice under a recovery/review hold before the first write.
- Use one immutable bundle hash and a reviewed coverage-plan hash.
- Namespace every external identity by source and practice.
- Use deterministic entity IDs or an immutable entity-link receipt, plus a
  payload hash, so retrying is convergent and changed source data conflicts.
- Commit in dependency order with bounded transactions. Clinical content and
  its patient link commit together.
- Upload documents before linking them; require checksum, size, object version
  or ETag, and an `available` manifest state.
- Reconcile source, eligible, imported, deferred, excluded, and error counts.
  Those counts must add up exactly for every domain.
- Keep the hold until a reviewer checks owner/patient identity, medical
  timelines, reminders, medications, catalog behavior, documents, and the
  exception report in the application.

## Public-repository rules

- Tests use synthetic clinics and canary values only.
- Logs and evidence contain fixed reason codes, schema fingerprints, hashes,
  and aggregate counts. They contain no source paths, filenames, headers,
  record values, names, contact details, notes, or external IDs.
- Private operator manifests are owner-only files outside the repository.
- CI may run generated synthetic archives and a disposable Postgres drill. It
  must never access a clinic archive or production database.
