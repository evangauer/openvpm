# Vet visit workflow research (OPENVPM-32)

**Purpose.** Ground the Clinical Workflow & Records epic (OPENVPM-27) in how a
real clinic actually runs a visit, instead of our assumptions. This doc feeds
OPENVPM-33 (visit documents), OPENVPM-34 (forms-tied e-sign), and OPENVPM-35
(multi-doctor day calendar).

**Sources.**
1. A 2026-06-30 call with a UK founder who runs a forked OpenVPMS build with
   live clinic users (full transcript reviewed; details on the internal board).
2. Industry research (~130 sources): AAHA/AVMA/AAVSB primary guidance, state
   practice acts, vendor help centers (Shepherd, ezyVet, Digitail, IDEXX Neo,
   Covetrus Pulse, Cornerstone), OpenVPMS docs + archetype source, and
   practice-management press (dvm360, Today's Veterinary Business, Clinician's
   Brief). Key links inline.
3. A code audit of our current build (`apps/web` + `packages/db`), 2026-07-11.

---

## 1. The forked-OpenVPMS call: what a working fork ships

The founder forked the open-source PIMS and built it into a product a couple of
UK clinics run daily. His demo (screenshare) confirmed the shape the rest of
this doc argues for:

- **Artifacts attach to the visit.** Photos are captured during a consultation
  ("pictures during consultation... for insurance purposes"). The insurance use
  case is why: a claim wants the wound photo tied to the consult that treated it.
- **E-signatures are bound to forms and dispatched to devices.** "You have your
  four tablets and you want to send a form to a tablet, someone just signs it.
  Or scan a QR code on your phone." The unit of signing is a *form* the clinic
  chooses, not a free-text blob.
- **Consult notes are auto-written** (AI-drafted documentation during/after the
  visit).
- **Integrations:** Xero (accounting), Stripe (payments), WhatsApp (client
  messaging), UK national veterinary services (clinical data).
- **Front-office pain is the wedge.** Practice admin is "wildly inconsistent,"
  built on 90s/2000s tools "bootstrapped on top of" until it is "18 clicks to
  send a text message." Nobody owns lead → booking → visit → records →
  follow-up, and data is locked inside incumbent PIMS.

The demo itself was screen-grabbed by Evan; the grabs (his consult screen, his
form library, how signed docs render on the record) are requested on the ticket.

---

## 2. The real visit lifecycle (US small-animal outpatient)

Twelve steps, with who acts and what the PIMS must record at each:

| # | Step | Who | What gets created |
|---|------|-----|-------------------|
| 1 | Booking | CSR / online | Client + patient records, appointment (type drives duration), reason for visit; prior-vet records request |
| 2 | Reminders | System | Confirmation log (7d / 24-48h / morning-of; text preferred 52% vs 29% phone), confirmation status; optionally a pre-visit intake questionnaire |
| 3 | Check-in | CSR | Status → checked-in (time + staff), room assignment, weight capture, forms collected, visit alert notes; expected charges staged (Cornerstone's Patient Visit List pattern) |
| 4 | Rooming / tech intake | Tech | Weight + TPR + BCS (weight at every visit is AAHA MR 18), history → SOAP Subjective; vitals start Objective; tech presents case to DVM |
| 5 | Doctor exam | DVM (+tech) | PE findings by body system in Objective; exam fee line |
| 6 | Diagnostics | Tech/DVM | Lab orders (in-house results flow back automatically; charge captured at order time), imaging (PACS link), pending send-outs create follow-up obligations |
| 7 | Assessment & plan discussion | DVM | SOAP Assessment (numbered problems + differentials) and Plan; **declined services documented** (Cornerstone: "Declined to History") |
| 8 | Estimate + approval | Tech presents | Itemized low/high estimate, **client signs even trusted regulars**, one copy to the record; signed items convert to charges |
| 9 | Treatments | Tech (DVM-only items excepted) | Treatment entries (drug/dose/route/site/who), vaccine records with manufacturer/lot/expiry/site per AAHA, inventory decrement, invoice lines |
| 10 | Discharge instructions | Tech | Written discharge doc attached to the visit (~6th-grade reading level), prescriptions + labels |
| 11 | Checkout / invoice | CSR | Invoice, payment, status → checked-out. Industry misses **5-10% of all charges** (~$200K/yr at a $2M hospital); AAHA found **17% of lab tests never billed** |
| 12 | Follow-up | Team | Forward-booked recheck (AAHA/AVMA-endorsed), role-assigned callbacks with due dates, new service reminders |

Sources: dvm360 "9 steps to the perfect appointment", Cornerstone check-in/PVL
docs (cornerstonehelphub.com), Today's Veterinary Business missed-charges series,
AAHA standards via instinct.vet's recordkeeping summary.

**Surgery/procedure days add five artifacts outpatient visits lack:** a signed
consent with an elective add-on menu (initialed per item, priced), an admission
questionnaire (last food/water, meds, prior anesthesia reactions), an anesthetic
record charted **every 3-5 minutes** (a permanent legal record; 47-60% of
anesthetic deaths happen post-op, most within 3 hours), a surgery report, and
structured recovery notes. Flow: drop-off window 7:00-8:30am → pre-anesthetic
PE/labs → procedure → recovery checks → pickup where CSR billing and tech
discharge-instruction delivery run in parallel (AAHA 2020 Anesthesia Guidelines;
Eden Veterinary Hospital surgical packet).

**Patient flow states.** The physical dry-erase whiteboard is the incumbent;
the failure mode is two versions of the truth (wall vs PIMS). Digital
equivalents (Digitail Flowboard, Cornerstone Census/Whiteboard, Shepherd
dashboard) share a canonical state set: scheduled → confirmed → checked in →
roomed → with doctor → in treatment → (hospitalized → recovery) → ready for
checkout → invoiced → checked out. The winning trait: **states update as a side
effect of normal work** (SOAP created, treatment completed, invoice posted),
never as separate bookkeeping.

---

## 3. What attaches to the visit vs the patient

Digitail states the industry doctrine outright: general forms live on the
patient's Documents page; "forms specific to visits, such as Consent Forms for
procedures like surgeries or anaesthesia, should be added directly on the
Record" (help.digitail.io article 5043103).

**Visit-scoped:** SOAP note; vitals/weight for that visit; lab results and
imaging for that visit's orders; the estimate; procedure consent forms;
discharge instructions; anesthesia sheets + surgery report; per-episode
referral/consult reports; insurance claim docs (insurers want the visit's
itemized invoice + records).

**Patient-scoped:** vaccine history + rabies certificates; patient profile/ID
photos; master problem list + alerts; prior-practice records; dental charts
(created per procedure, read longitudinally); health certificates.

**Photos in practice:** wound/lesion progression across rechecks, dermatology
documentation, intraoral photos alongside dental charts (the AVDC chart has a
"Rads / Digital Photos" line), before/after procedure shots, patient ID photo at
check-in, insurance claim support. Social posting requires a separate media
release. The practical pattern everywhere: **created in a visit context,
reachable from the patient's chronological history.**

---

## 4. How other PIMS model the visit and its documents

| System | Visit entity | Documents | E-sign | Charge capture |
|--------|-------------|-----------|--------|----------------|
| **Shepherd** | The SOAP (Quick or Comprehensive), created at check-in; statuses Active → Locked (+addenda) | Visit-level Documents/Forms sections on the SOAP; completed forms also on client + patient profiles | Form template builder (signature + initial fields); send by email/link/tablet; **auto-send when a matching appointment type is booked** | "If it's on the medical record, it's on the invoice": administered treatments auto-bill |
| **ezyVet** | "Clinical Record"/Consult, distinct from + linked to the appointment; relational SOAP (assessments, plans, exams, diagnostics as child entities; see developers.ezyvet.com) | Consult has an Attachment tab (attachments + created documents); template-generated docs | In-person (3 signature variables/doc) + remote (email/SMS link); **appointment-type-triggered consent auto-send** (e.g. day before surgery) | "Billing triggers" on appointment types + clinical procedures append invoice lines |
| **Digitail** | The "Record" (Draft → Open → Closed/locked), linked to appointment | Two levels by doctrine: SOAP Files tab (visit) + patient Documents page (forms, auto-generated certificates) | Template editor with shortcodes; only docs containing the client-signature shortcode are e-signable; forms attach to appointments at booking | Plan items land in the record's Billing section; invoice auto-created |
| **IDEXX Neo** | **The consultation IS the invoice** (one entity; status = Draft → Paid); notes lock separately | Files tabs on client, patient, AND consultation | `[signature]` merge variable, in-clinic touch only (no remote); Accept locks irreversibly | No transfer step: lines live on the consultation; draft-consult list = the missed-charge queue |
| **Covetrus Pulse** | **No visit entity**: chronological stream of typed entries; state machine lives on appointment "visit statuses" | Three scopes (client, medical-record upload, non-record patient docs) | `Signature*` merge field, touch device, signed docs lock | "Treatments are also considered an invoice"; per-item Is Complete checkbox |
| **OpenVPMS** | `act.patientClinicalEvent` ("Visit", IN_PROGRESS/COMPLETED), created at check-in, linked to the appointment | Archetype-typed + versioned document acts (Form/Letter/Attachment/Image), each linkable to max 1 visit + 1 problem; patient Documents tab aggregates | **None built in** (print → paper → scan back). Its biggest gap vs moderns | Invoice lines link into the visit via act relationships (`chargeItems`); editing a line edits its clinical children |

**OpenVPMS deep shape** (our heritage, and what the UK fork builds on): the
visit contains typed child items (note, addendum, **problem**, weight,
medication, investigation, document); **problems span visits** (same problem
act is a child of many visits, UNRESOLVED/RESOLVED); records lock after a
configurable period with audited addenda; estimates are first-class
(low/high per line, dose-based quantities from patient weight, INVOICED status,
converts at high values).

**Synthesis:**
1. All six separate scheduling (appointment) from the clinical container
   (visit), with three billing couplings: fused (Neo), auto-mirrored
   (Shepherd/Digitail/ezyVet), fully normalized (OpenVPMS). Pulse, the only one
   with no visit entity, is the outlier nobody praises.
2. **Dual document scope is table stakes**: visit-optional, patient-required,
   with type discrimination and (OpenVPMS) versioning.
3. **E-sign convergent design**: signature merge-field in an ordinary document
   template; in-clinic touch signing + remote link; signed doc locks and lands
   on the patient (and visit). ezyVet's appointment-triggered auto-send is the
   best idea in the market. A native "auto-send on booking → sign on phone →
   locked PDF on the visit" flow matches or beats every incumbent.
4. **Record locking with audited addenda** is universal and an AAHA standard
   (MR 48.1: auto-lock within 24h, amendments audit-trailed).
5. Regulatory note directly relevant to us: the **AAVSB 2025 model regulations
   require that AI-created or AI-updated record entries be noted as such** in
   the record. Our AI SOAP drafts should stamp this automatically.

---

## 5. The standard consent form library

AVMA doctrine: inform the client of options, risks, prognosis, and an estimate
of charges; document the consent. AVMA PLIT (liability insurer) lists the three
records most often missing from charts in claims: the anesthesia record,
**documented declined treatments**, and **signed consent forms**. The classic
error is one generic form for everything.

The standard set, roughly in order of how often clinics need them:

1. **Surgical/anesthesia consent** (at admission): named procedure + site,
   day-of phone, empowered emergency contact, fasting attestation, anesthesia
   authorization, risk + unforeseen-conditions clause, **elective add-on menu
   initialed per item with prices** (pre-anesthetic bloodwork, IV fluids,
   microchip, e-collar, histopath), **CPR/DNR election**, financial
   responsibility.
2. **Dental with extractions authorization**: the distinctive feature is
   advance authorization for findings visible only under anesthesia, via a
   staged permission ladder (clean → x-rays → pre-authorized extractions at
   $/tooth → **"my maximum budget for today is $___"**), avoiding
   call-mid-anesthesia.
3. **Treatment/hospitalization consent + estimate approval**: low/high range,
   deposit convention (50% of high or 100% of low), treat-if-unreachable
   election, CPR election, visitation rights, abandonment clause.
4. **Euthanasia consent + disposition** (AVMA model form): ownership
   attestation, authorization, rabies/bite observation caveat, **remains
   disposition election** (private cremation / communal / burial / hospital),
   necropsy election, witness line.
5. **Vaccination declination/waiver**: declined vaccines, disease-risk
   disclosure, unvaccinated-status consequences, liability release.
6. **Boarding agreement**: vaccine currency, emergency treatment authorization
   with **spend cap + unreachable-window rule**, abandonment clause.
7. **Grooming agreement**: injury disclosure, sedation authorization gated on
   vet + phone approval, mat-removal/shave-down disclaimer.
8. **Telemedicine consent**: identity/location (jurisdiction), VCPR
   acknowledgment (cannot be established solely by telemedicine), limitations.
9. **Photo/media release** (separate from the medical record's clinical
   photos): publication scope, duration, pet-name use.
10. **Financial responsibility/payment policy** (once, at registration).
11. **Medical records release** (on request; ~35 states have vet-record
    confidentiality statutes waivable by client authorization).
12. **Against-medical-advice / declined treatment waiver**: risks of refusal,
    both client AND veterinarian sign. Per PLIT, missing declination records
    are a top defense weakness.

**Design patterns across real forms:** initial-per-clause (not just
sign-at-bottom) with mutually exclusive elections; every consent is also a
financial instrument (ranges, deposits, priced add-ons); reachability is a
first-class field (day-of phone, empowered contact, timeout rules); the
unforeseen-conditions clause appears on every surgical form; witness lines on
the highest-stakes forms.

**E-sign legality:** ESIGN + UETA make e-signed vet consents enforceable
nationwide given intent, consent to electronic business, attribution (audit
trail: who/when/IP/doc version), and durable reproducible copies. Our existing
snapshot + audit-log approach is the right base.

---

## 6. What a multi-doctor day actually looks like

- **Shape of a practice:** ~2.6 FTE DVMs, 3.5 exam rooms, ~15 appointments per
  DVM per day at ~30 min each (AVMA 2025 survey).
- **The grid grammar is 10-minute increments**; appointments block 1-4 cells by
  type (adult wellness 20, senior 30, first puppy/kitten 40, sick 30-40,
  recheck 10-20, new client 30, **euthanasia 40+ in a quiet first/last slot**).
  OpenVPMS models this exactly: per-schedule slot size, per-type slot count.
- **Day structure:** surgery block in the morning (or a midday block when
  appointments are lightest), lunch + phone/callback blocks, drop-offs filling
  gaps (some practices cap by a point system), **4-6 pre-blocked urgent slots
  per doctor staggered ~90 min** (two doctors offset by an hour), 15-20% of
  capacity held for same-day and released on a timer.
- **Deliberate double-booking is a feature, not a bug:** Cornerstone renders
  per-slot booking density (yellow = double, red = triple); OpenVPMS has a
  per-schedule "Allow Double Booking" checkbox. No-show rates run 10-20%.
- **Columns are polymorphic everywhere:** Shepherd columns "can represent
  individual doctors, exam rooms, or team units"; Neo columns are rooms; ezyVet
  resources are staff/room/equipment; Digitail day view is a column per staff
  member; Cornerstone shows doctor columns plus Technician/Groomer/Admits
  columns. A 2-4 doctor clinic typically runs **doctor columns + a tech
  column** (tech appointments: nail trims, blood draws, suture removal).
- **Rendering conventions:** appointment-type color is the primary visual
  channel, status the secondary (icon/label); lunch/unavailable render as muted
  background blocks; recurring availability templates render as muted overlays;
  a current-time line.

---

## 7. Where our build is today (code audit, 2026-07-11)

Schema lives in `packages/db/schema/*`; app surfaces in `apps/web`.

**There is no visit/consultation entity.** The visit is an `appointments` row
(`packages/db/schema/scheduling.ts`), with a status machine
`scheduled/confirmed → checked_in → in_exam → checked_out` plus
`no_show/cancelled` (`apps/web/lib/scheduling/appointment-status.ts`). Clinical
artifacts (SOAP notes, lab results, procedures, vitals) attach to the
**patient**, each with an *optional* `appointmentId` (`clinical.ts`). Nothing
aggregates "everything that happened in this visit."

**One generic file bucket, patient-scoped.** `files`
(`packages/db/schema/files.ts`) is polymorphic (`entityType`/`entityId` +
`category` varchar). Photos (`category="patient-photos"`) and signed consents
(`category="consents"`) both attach to `entityType="patient"`. Files have no
`appointmentId` at all.

**E-sign works but is form-less and invisible after signing.**
`consentRequests` (`packages/db/schema/consents.ts`) snapshots a free-text
title/body (default "Consent to treatment",
`apps/web/lib/consult/consent-template.ts`), dispatches by QR
(`/sign/<token>`, 60-min TTL), captures a drawn signature + typed name, builds
a PDF, stores it in `files`, and audit-logs the signing. But:
- There is **no form type**. The request cannot answer "what did they sign?"
  beyond the snapshotted free text.
- The signed PDF is viewable **only inside the dispatch modal while it is
  open** (`apps/web/components/records/consent-sign.tsx`). No surface on the
  patient chart lists consents afterward.

**Photo capture is a patient bucket that leaks PDFs.** The Capture-photos modal
(`apps/web/components/records/capture-photos.tsx`) lists via
`records.listCaptureFiles`, which returns **every** file on the patient with no
category or mime filter. A consent signed while a capture session is open shows
up in the photo grid and renders as a broken `<img>`. This is the exact bug in
OPENVPM-33's screenshot.

**No Documents surface anywhere.** The patient page
(`apps/web/app/(dashboard)/patients/[id]/page.tsx`) has tabs Overview · Medical
Records · Appointments · Weight History · Vitals · Vaccinations · Invoices.
Captured photos and signed consents are persisted but unreachable once their
modals close.

**No SOAP → invoice bridge.** `records.createSoapNote` writes the note and
fires a webhook; invoices are built independently in Billing with only an
optional `invoices.appointmentId` linking back. (Charge capture is Gate C work,
noted because the visit container we pick must eventually carry charges. The
industry numbers above say this is where the money is.)

**Calendar: single lane, no overlap handling.** The Schedule day view
(`apps/web/app/(dashboard)/schedule/page.tsx`) absolutely positions each
appointment `left-1 right-1` (full width), so concurrent appointments stack on
top of each other (the "Biscuit" bug in OPENVPM-35). A doctor *filter* exists,
but there are no per-doctor lanes. `appointments.doctorId` and user roles
(`veterinarian` etc.) already exist, so lanes are a pure front-end build.

## 8. Gaps (current build vs how a clinic works)

1. **No visit aggregate.** Nothing collects what happened in a visit: notes,
   photos, consents, documents, charges.
2. **Files cannot attach to a visit.** `files` has no appointment linkage.
3. **E-sign has no form concept.** Cannot answer "what are they signing?"; no
   library of standard consent forms.
4. **Signed documents are write-only.** Persisted, then invisible: no Documents
   surface on the patient record or the visit.
5. **The photo grid is really an "all patient files" grid.** PDFs leak in.
6. **Day view cannot show a real clinic day.** No overlap layout, no provider
   lanes, sparse demo data.

---

## 9. Recommendation: OpenVPM's visit → documents model

**Principle (from every system surveyed): artifacts are created in a visit
context and reachable from the patient's history. Dual scope: patient-required,
visit-optional.**

### Data model (minimal-migration path)

**The appointment row IS the visit container for this pass.** It already has
the status machine, `patientId`, `doctorId`, and `invoices.appointmentId`.
Neo proves the fused model works for small practices. We name the concept
"Visit" in the UI without introducing a parallel entity now; if/when we need
problems-spanning-visits or hospitalization, we revisit with the OpenVPMS acts
shape (section 4) as the target.

Schema changes, in build order:

1. **`files.appointmentId`** (nullable FK + index) — OPENVPM-33. Files keep
   their patient linkage (`entityType`/`entityId`) and *optionally* gain the
   visit. Capture sessions and consent requests created from a visit context
   stamp it; standalone captures stay patient-only.
2. **`consentForms` table** — OPENVPM-34. `practiceId`, `slug`, `title`,
   `body`, `category` (surgical, dental, euthanasia, treatment-estimate,
   vaccine-declination, boarding, grooming, telehealth, media-release,
   financial, records-release, ama), `isActive`, `sortOrder`. Seeded per
   practice from a starter library (section 5, items 1-12) at practice creation
   + a backfill for existing practices. Practices can edit the text; the
   existing snapshot-at-dispatch semantics already protect signed history.
3. **`consentRequests.formId`** (nullable FK, null = legacy/custom) and
   **`consentRequests.appointmentId`** (nullable) — OPENVPM-34.

Explicitly deferred (flagged for later tickets): estimate lifecycle entity,
record locking + addenda (AAHA MR 48.1), per-clause initials/elections on
forms, appointment-type-triggered auto-send of consents (ezyVet's pattern, the
natural v2), SOAP → invoice charge capture (Gate C), AI-authorship stamp on
AI-drafted notes (AAVSB 2025; cheap, should be its own small ticket).

### UI

1. **Documents tab on the patient page** (OPENVPM-33): all `files` for the
   patient, filter chips (All / Photos / Consents / Documents), thumbnail grid
   for images, rows with type icon + title + form type + timestamp + visit link
   for documents, view/download. This alone fixes "the signature came through
   but I can't see it."
2. **Visit documents** (OPENVPM-33): the per-appointment view (patient
   Appointments tab row expansion or appointment detail) lists that visit's
   photos + documents + consents with timestamps.
3. **Fix the capture grid** (OPENVPM-33): `listCaptureFiles` filters to
   `category="patient-photos"` + image mime types.
4. **Form picker on e-sign dispatch** (OPENVPM-34): choosing a form type is
   required; it prefills title/body from the library (still editable, still
   snapshotted); the signed PDF lands in Documents (patient + visit) and shows
   the form type.
5. **Calendar** (OPENVPM-35): (a) overlap algorithm — cluster concurrent
   appointments, split the column width, render side by side; (b) day view
   lanes per doctor (color by appointment type, status as secondary), tech
   lane included; (c) richer demo seed: 2-3 doctors on a 10-minute grid with a
   morning surgery block, staggered urgent slots, tech appointments, and lunch
   blocks, per section 6.

### Build order

OPENVPM-33 (files.appointmentId + Documents tab + capture filter) →
OPENVPM-34 (consentForms + form picker + signed-doc visibility) →
OPENVPM-35 (calendar). 33 before 34 because the Documents surface is where
34's output becomes visible.

---

## 10. Open questions for Evan

1. **Screen grabs from the 2026-06-30 demo call** — the consult screen, the
   form library UX, and how signed docs render on his patient record would
   sharpen OPENVPM-33/34 before build.
2. **Visit container:** OK to treat the appointment row as the visit for this
   pass (UI says "Visit"), deferring a separate consultation entity? That is
   the recommendation; a standalone entity is a bigger migration with no
   user-visible payoff yet.
3. **Consent library v1 scope:** fixed starter texts, editable per practice, no
   form builder — right bar? And are per-clause initials/elections (CPR/DNR,
   budget caps) v1 or later? Recommendation: later.
4. **Legal posture:** starter consent texts will ship with a "template, have
   your attorney review" disclaimer (PLIT recommends practice-specific review).
   Comfortable with that framing?
5. **Client copy:** should the signed PDF also be emailed to the client
   automatically (ESIGN favors the client retaining a copy)? Cheap to add while
   in there.
6. **Calendar lanes:** doctor lanes only for v1, or doctor + room/tech lanes
   (polymorphic columns like Shepherd/Cornerstone)? Recommendation: doctor
   lanes + a single tech lane; polymorphic columns later.
7. **AI-authorship note:** AAVSB 2025 model regs require noting when AI
   creates/updates a record entry. Want a small ticket to auto-stamp AI-drafted
   SOAP notes? Recommendation: yes.
8. **Public-repo naming:** this doc anonymizes the UK founder (public repo,
   standing rule about real names in public content). The board ticket keeps
   full attribution. Confirm that split is right.
