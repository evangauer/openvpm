# Clinic pilot readiness

OpenVPM is ready for a controlled, connected-mode clinic pilot. It should not
yet be sold as a universal replacement for every veterinary workflow. This
page defines the boundary so a clinic can make a clear decision before moving
live work.

## Best fit today

The strongest first pilots are companion-animal or house-call clinics that:

- can use a connected browser on a computer, phone, or iPad;
- chart one patient at a time;
- are willing to run OpenVPM alongside their current PIMS for a short
  validation period;
- can name one clinic owner and one day-to-day workflow champion; and
- want scheduling, records, billing, client access, data ownership, and
  optional AI in one system.

## Capability boundary

| Area                                                                                                                                  | Status                          | What the clinic should expect                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clients, patients, schedule, whiteboard, records, SOAP notes, vitals, vaccines, manual labs, inventory, invoices, and manual payments | Supported now                   | Use in a connected browser. Core clinic-day work is tenant scoped and role controlled.                                                                                                                      |
| Phone and iPad use                                                                                                                    | Supported now                   | Core clinic-day screens are responsive. An internet connection is required. Server-saved drafts can recover; OpenVPM does not store clinical drafts in browser storage.                                     |
| Client portal and appointment requests                                                                                                | Supported now                   | Clinics review and accept appointment requests. This is not unrestricted instant booking.                                                                                                                   |
| Client card payments                                                                                                                  | Supported after setup           | The clinic must complete its own Stripe Connect setup before pet-owner card payments can be enabled.                                                                                                        |
| Data import                                                                                                                           | Supported now for reviewed CSVs | Administrators can dry-run and then import clients, patients, vaccine history, and visit notes. Imports are additive and tenant scoped.                                                                     |
| Export and backup                                                                                                                     | Supported now                   | Clinics can export CSVs and a full JSON backup. Hosted deployments also run managed backups.                                                                                                                |
| Hosted texting                                                                                                                        | Controlled pilot                | SMS stays off until carrier registration, provider verification, consent workflow review, and an explicit clinic/location allowlist are complete. Email reminders can be used while texting is unavailable. |
| Larger or unusual migrations                                                                                                          | Assisted pilot                  | Appointment, invoice, attachment, or vendor-specific history migrations need an agreed mapping, sample validation, and secure transfer plan before a full move.                                             |
| Production multi-location rollout                                                                                                     | Not supported                   | The current hosted pilot is one location. Multi-location data structures exist, but production operations have not been validated broadly enough to sell or depend on yet.                                  |
| Optional AI                                                                                                                           | Supported with review           | AI can help draft or answer questions, but clinic staff remain responsible for clinical review and final records.                                                                                           |
| Offline charting                                                                                                                      | Not supported                   | Do not rely on OpenVPM without internet access. The app warns and protects unsaved work, but it is not an offline PIMS.                                                                                     |
| Herd or group medicine                                                                                                                | Not supported                   | Current records and billing are patient based. Herd quantities, group treatments, and production-animal workflows are not ready.                                                                            |
| Direct lab, distributor, reference, or legacy-PIMS integrations                                                                       | Not supported                   | IDEXX, Antech, Zoetis, Vetcove, Rhapsody, e-prescribing, accounting sync, and similar vendor connections are not generally available today.                                                                 |
| Automated regulatory reporting                                                                                                        | Not supported                   | Clinics must keep using their existing state and federal reporting process unless a specific integration has been validated.                                                                                |

## Pilot launch path

1. **Confirm fit.** Agree on the clinic, location, users, devices, target
   workflow, and any capability that would block adoption.
2. **Start alongside.** Keep the current PIMS as the source of truth while the
   team completes guided setup and learns OpenVPM with sample data.
3. **Import a small real sample.** Dry-run a few clients and patients first,
   then vaccine and visit history. Resolve every unexpected match or skipped
   row before a larger import.
4. **Complete one real visit.** Book, check in, chart, record vitals, close out,
   invoice or document a no-charge reason, and verify the client handoff.
5. **Validate the edges.** Confirm roles, exports, appointment requests,
   payments, communications, an interrupted connection, and the clinic's
   rollback path.
6. **Run a pilot week.** Use the agreed workflow for at least five clinic days.
   Record friction and review it with the clinic champion each day.
7. **Make a go-live decision.** Move more work only after the clinic signs off
   on record accuracy, billing, team handoffs, support coverage, and data exit.

## Migration safety rules

- Never send patient, client, financial, or credential data through a public
  issue or ordinary email attachment. Email support only to arrange an approved
  secure transfer method.
- Use an administrator account for imports. Start with a small representative
  sample and always review the dry run before confirming.
- Use the same migration source for every related file so external owner and
  patient IDs remain linked.
- Keep the source export unchanged until the migration is accepted. Store the
  source file and import issue report according to the clinic's retention
  policy.
- Compare source and destination counts, then spot-check active patients,
  inactive patients, duplicate names, missing emails, vaccines, and dated
  notes.
- Agree on a cutoff time before the final import. Record any work entered in the
  old system after that time and reconcile it explicitly.
- Export an OpenVPM backup after acceptance and before expanding the rollout.

## Go-live evidence

The clinic owner and OpenVPM operator should record:

- the supported workflow and location in scope;
- the staff roles that were tested;
- import counts, issues, and sample-validation results;
- completed-visit and billing evidence using non-sensitive identifiers;
- payment, booking, email, and SMS status;
- backup/export confirmation;
- known limitations and the rollback owner; and
- the decision date and approvers.

No single green dashboard makes a clinic ready. Readiness is the combination of
working software, a validated clinic workflow, honest limits, recoverable data,
and a team that knows what to do when something goes wrong.
