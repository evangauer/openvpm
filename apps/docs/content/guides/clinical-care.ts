import type { Guide } from "../types";

export const clinicalCare: Guide[] = [
  {
    slug: "document-a-visit",
    title: "Document a visit",
    summary: "Record everything about the visit in one place, then close it out.",
    category: "clinical-care",
    area: "schedule",
    audience: "Vets, techs, admins",
    minutes: 7,
    before: "Check the pet in first. Then open the visit from [[Schedule]] or the [[Whiteboard]].",
    keywords: ["encounter", "exam", "chart", "medical record", "visit page", "closeout"],
    steps: [
      {
        id: "open",
        title: "Open the visit and start the exam",
        body: [
          "Click the visit on the schedule and choose [[Open visit]]. Then choose [[Start exam]] ((1)).",
          "The **Finish this visit** checklist ((2)) shows what's left before checkout.",
        ],
        shot: {
          id: "visit",
          focus: ["header", "checklist"],
          pad: 12,
          callouts: ["start-exam", "checklist"],
          alt: "A visit page with the Start exam button and the Finish this visit checklist",
        },
      },
      {
        id: "review",
        title: "Review the pet first",
        body: ["Check alerts and allergies, current problems and medications, vaccine history, recent labs, and the reason for the visit."],
      },
      {
        id: "record",
        title: "Record the work",
        body: [
          "Once the exam has started, **Clinical work** has a button for each kind of record ((1)): [[Write SOAP note]], [[Prescribe]], [[Vaccination]], [[Lab result]], and [[Procedure]]. Vitals go in the **Visit vitals** card below it. Each record has its own place, so it stays searchable and shows up in reports.",
          "Vets, techs, and admins can record vitals, vaccinations, and lab results. Only vets and admins write SOAP notes, prescribe, and record procedures.",
        ],
        important: "These buttons only appear while the pet is **In Exam** and before the clinical record is finalized.",
        shot: {
          id: "visit-work",
          focus: "clinical-work",
          pad: 12,
          callouts: ["actions"],
          alt: "The Clinical work section of a visit in the exam, with Write SOAP note, Prescribe, Vaccination, Lab result, and Procedure buttons",
        },
      },
      {
        id: "close",
        title: "Finish the clinical record",
        body: [
          "Open the draft SOAP note and choose [[Finalize SOAP note]].",
          "Then, in the visit's closeout, confirm the diagnosis, discharge instructions, warning signs, and follow-up, and choose [[Finalize clinical handoff]].",
        ],
        important: "Finalized notes can't be quietly changed. To add to one, choose [[Add addendum]] on it. The original stays on file.",
      },
    ],
    next: "record-vitals",
  },
  {
    slug: "record-vitals",
    title: "Record vitals",
    summary: "Save weight, temperature, and other measurements so trends are easy to spot.",
    category: "clinical-care",
    area: "patients",
    audience: "Vets, techs, admins",
    minutes: 3,
    keywords: ["weight", "temperature", "temp", "heart rate", "pulse", "respiration", "pain score", "tpr"],
    steps: [
      {
        id: "patient",
        title: "Open the right pet and visit",
        body: [
          "During a visit, use the **Visit vitals** card on the visit page, so the vitals are linked to that visit. Otherwise, open the pet's chart.",
          "Double-check it's the right pet before you enter anything.",
        ],
      },
      {
        id: "enter",
        title: "Enter what you measured",
        body: [
          "On the chart's [[Vitals]] tab ((1)), enter temperature, heart rate, respiration, weight, body condition, pain score, and anything else you took. Then choose [[Record vitals]] ((2)).",
          "Units are set for the whole clinic and shown in each label, like **Temp (C)** or **Weight (kg)**. Leave a field empty if you didn't measure it.",
        ],
        shot: {
          id: "patient-vitals",
          focus: ["pet", "tab", "record"],
          pad: 12,
          callouts: ["tab", "record"],
          alt: "The Vitals tab on a patient chart with fields for temperature, heart rate, respiration, weight, and more",
        },
      },
      {
        id: "check",
        title: "Look twice at anything unusual",
        body: ["Check surprising numbers before you save. If the weight changed, look at [[Weight History]], especially if it affects a dose."],
      },
    ],
    next: "write-a-soap-note",
  },
  {
    slug: "write-a-soap-note",
    title: "Write and finalize a SOAP note",
    summary: "Keep the clinical reasoning for the visit organized and on file.",
    category: "clinical-care",
    area: "records",
    audience: "Vets, admins",
    minutes: 6,
    keywords: ["soap", "medical note", "subjective", "objective", "assessment", "plan", "template", "amend", "addendum"],
    steps: [
      {
        id: "start",
        title: "Start the note",
        body: [
          "Open the visit once the exam has started and choose [[Write SOAP note]] under **Clinical work**. Use one of your clinic's templates if it fits, then fill in each section for the work you actually did.",
          "If you leave and come back, the button says [[Resume SOAP draft]].",
        ],
      },
      {
        id: "linked",
        title: "Record the work in its own place too",
        body: ["Problems, prescriptions, vaccines, labs, and procedures should be recorded in their own sections as well as described in the note. That keeps them searchable and in reports."],
      },
      {
        id: "finalize",
        title: "Finalize it",
        body: [
          "Fill any gaps, then choose [[Finalize SOAP note]]. Finalized notes appear on the pet's [[Medical Records]] tab ((1)).",
          "To add to a finalized note, choose [[Add addendum]]. The original stays on file.",
        ],
        shot: {
          id: "patient-medical-records",
          callouts: ["tab"],
          alt: "The Medical Records tab showing a finalized SOAP note",
        },
      },
    ],
    next: "record-lab-results",
  },
  {
    slug: "record-lab-results",
    title: "Record and review lab results",
    summary: "Enter results, have a vet review them, and make sure follow-up happens.",
    category: "clinical-care",
    area: "lab-inbox",
    audience: "Vets, techs",
    minutes: 6,
    keywords: ["lab", "bloodwork", "results", "idexx", "antech", "review", "critical", "entered in error"],
    steps: [
      {
        id: "enter",
        title: "Enter the result",
        body: [
          "For a test that's waiting on values, open [[Lab Inbox]], pick the result, and choose [[Enter values and complete]]. Enter the values with the right units and reference range.",
          "To record a new test from a visit, choose [[Lab result]] under **Clinical work** while the pet is in the exam. You can also add one from [[Records]] → the pet → [[Lab Results]].",
        ],
      },
      {
        id: "review",
        title: "Have a clinician review it",
        body: [
          "A result isn't finished until the right clinician reviews it. Choose [[Mark reviewed]] ((1)) instead of relying on a message or a word in the hallway.",
        ],
        shot: {
          id: "lab-inbox",
          focus: ["filters", "result"],
          pad: 12,
          callouts: ["mark-reviewed"],
          alt: "A lab result in the Lab Inbox with the Mark reviewed button highlighted",
        },
      },
      {
        id: "follow-up",
        title: "Assign the follow-up",
        body: ["If the client or pet needs follow-up, choose [[Assign follow-up]] ((1)) and pick a named teammate. Record what happened when it's done."],
        shot: {
          id: "lab-inbox",
          focus: "result",
          pad: 12,
          callouts: ["assign-follow-up"],
          alt: "A lab result in the Lab Inbox with the Assign follow-up button highlighted",
        },
      },
    ],
    faq: [
      [
        "I entered a result on the wrong pet",
        "A vet or admin opens [[Records]], finds the pet, and on the [[Lab Results]] tab chooses [[Mark entered in error]] with a reason. Then choose [[Create replacement]] and pick the right pet. The original stays in the chart history.",
      ],
    ],
    next: "create-a-prescription",
  },
  {
    slug: "create-a-prescription",
    title: "Create a prescription",
    summary: "Write clear directions and, when it's from your stock, record what you dispensed.",
    category: "clinical-care",
    area: "patients",
    audience: "Vets, admins",
    minutes: 5,
    keywords: ["prescribe", "medication", "drug", "rx", "dispense", "refill", "dose"],
    steps: [
      {
        id: "medication",
        title: "Choose the medication",
        body: [
          "On the visit, while the pet is in the exam, choose [[Prescribe]] under **Clinical work**. Or open [[Records]], find the pet, and use the [[Prescriptions]] tab.",
          "Pick the product in [[Inventory Item]] so stock is tracked, or just type the [[Medication]] when it isn't stocked.",
        ],
      },
      {
        id: "directions",
        title: "Enter complete directions",
        body: [
          "Fill in [[Dosage]], [[Frequency]], [[Quantity]], [[Refills]], [[Start Date]], and [[Instructions]] for the client. Add an [[End Date]] if it has one.",
          "There's no separate route field, so put the route in the dosage, like “75 mg by mouth.” Check your math against the pet's current weight.",
        ],
      },
      {
        id: "dispense",
        title: "Confirm what you dispensed",
        body: [
          "With an inventory item picked, [[Quantity]] is the total you're dispensing, in the same units as stock. Choosing [[Save Prescription]] takes it out of stock. [[Refill]] dispenses another round later.",
          "The charge shows up for billing to review at checkout. It isn't added to the bill on its own.",
        ],
        tip: "Dispenses that haven't been billed yet wait in **Unbilled medication dispenses** on the [[Billing]] screen, so nothing slips through.",
      },
    ],
    next: "record-a-vaccine",
  },
  {
    slug: "record-a-vaccine",
    title: "Record a vaccine",
    summary: "Log each vaccine so certificates, reminders, and overdue reports are right.",
    category: "clinical-care",
    area: "patients",
    audience: "Vets, techs, admins",
    minutes: 4,
    keywords: ["vaccination", "rabies", "dhpp", "booster", "shot", "certificate", "lot number", "due date"],
    steps: [
      {
        id: "open",
        title: "Open the vaccine form",
        body: [
          "On the visit, while the pet is in the exam, choose [[Vaccination]] ((1)) under **Clinical work**. Or open [[Records]], find the pet, and use the [[Vaccinations]] tab.",
        ],
        shot: {
          id: "visit-work",
          focus: "clinical-work",
          pad: 12,
          callouts: ["vaccination"],
          alt: "The Clinical work section of a visit with the Vaccination button highlighted",
        },
      },
      {
        id: "details",
        title: "Enter how it was given",
        body: [
          "Enter the vaccine, then the product, manufacturer, lot number, product expiration, dose type (initial or booster), licensed duration, the supervising veterinarian, and the next due date. Add the tag number for rabies.",
          "For rabies, everything except the tag number is required, so the certificate is complete.",
        ],
      },
      {
        id: "verify",
        title: "Check the due date and certificate",
        body: [
          "Make sure the next due date matches your clinic's protocol. It drives the recall list.",
          "Every vaccine shows on the [[Vaccinations]] tab ((1)) of the pet's chart. If the client needs proof, choose [[Download vaccination certificate]] ((2)).",
        ],
        shot: {
          id: "patient-vaccinations",
          focus: ["pet", "tab", "certificate"],
          pad: 12,
          callouts: ["tab", "certificate"],
          alt: "The Vaccinations tab on a patient chart with the Download vaccination certificate button",
        },
      },
    ],
    faq: [
      ["I recorded a vaccine by mistake", "A vet or admin chooses [[Mark entered in error]] on that vaccine and gives a reason. The record stays in the history but stops counting for reminders and certificates."],
    ],
    next: "complete-discharge-and-follow-up",
  },
  {
    slug: "complete-discharge-and-follow-up",
    title: "Complete discharge and follow-up",
    summary: "Give the owner clear instructions and make sure someone owns the follow-up.",
    category: "clinical-care",
    area: "schedule",
    audience: "Vets, techs",
    minutes: 5,
    keywords: ["discharge", "go home", "instructions", "follow up", "recheck", "handoff", "closeout"],
    steps: [
      {
        id: "instructions",
        title: "Write the instructions",
        body: [
          "Record a short diagnosis summary, home-care instructions, medications, warning signs to watch for, and any follow-up.",
          "If there's nothing extra to tell the owner, say why.",
        ],
      },
      {
        id: "follow-up",
        title: "Assign the follow-up",
        body: ["If the pet needs follow-up, set a due date and a named teammate, or link the recheck appointment you booked."],
        tip: "Open follow-ups show on the [[Dashboard]] in the **Follow-up work queue** until someone closes them.",
      },
      {
        id: "handoff",
        title: "Record how the owner got them",
        body: [
          "In the visit's closeout, set **Owner handoff** to printed or downloaded, reviewed verbally, or owner declined. Then choose [[Complete visit]].",
        ],
      },
    ],
    next: "capture-visit-charges",
  },
  {
    slug: "upload-a-patient-document",
    title: "Add an outside record or lab report",
    summary: "Keep referral letters, scans, and outside lab PDFs on the pet's chart.",
    category: "clinical-care",
    area: "patients",
    audience: "Vets, techs, front desk, admins",
    minutes: 3,
    keywords: ["upload", "attach", "pdf", "scan", "referral", "outside records", "external lab", "file", "document"],
    steps: [
      {
        id: "open",
        title: "Open the pet's Documents tab",
        body: ["Go to [[Patients]], open the pet, and choose the [[Documents]] tab ((1))."],
        shot: {
          id: "patient-documents-upload",
          focus: ["tab", "form"],
          pad: 16,
          callouts: ["tab"],
          alt: "A patient chart open on the Documents tab with the Add a patient document form",
        },
      },
      {
        id: "upload",
        title: "Pick the kind of file and upload it",
        body: [
          "Under **Add a patient document**, set [[Document category]] ((1)) to **External record** or **Lab report**. Choose the file ((2)), then [[Upload document]] ((3)).",
          "PDF, JPG, PNG, and WebP files work, up to 4 MB each. Compress a large scan, or split a long record into smaller PDFs and upload each part.",
        ],
        shot: {
          id: "patient-documents-upload",
          focus: "form",
          pad: 96,
          callouts: ["category", "file", "upload"],
          alt: "The Add a patient document form with Lab report chosen and a PDF selected",
        },
        tip: "Give files a useful name before you upload, like 2026-09-13-referral-part-1.pdf. The original file name shows in the list.",
      },
      {
        id: "find",
        title: "Find it again",
        body: [
          "The file appears in the list below the form. Use the **Lab reports** filter to see only outside lab files, and **View** or **Download** to open one.",
        ],
        important: "A lab report is saved as the original file. OpenVPM doesn't read the results out of it, so enter any values you need to track in [Lab results](/guides/record-lab-results).",
      },
    ],
    faq: [
      ["The upload stopped or I'm not sure it worked", "Choose [[Retry upload]] and keep the page open. OpenVPM checks and finishes the same upload, so you won't end up with two copies."],
      ["Who can upload?", "Anyone on the team who can make changes. Viewer accounts can open and download documents but can't add them."],
    ],
    next: "record-lab-results",
  },
];
