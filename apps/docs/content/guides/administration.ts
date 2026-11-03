import type { Guide } from "../types";

export const administration: Guide[] = [
  {
    slug: "set-up-your-clinic",
    title: "Set up your clinic",
    summary: "Enter your practice details, schedule setup, and price list before your first real day.",
    category: "administration",
    area: "settings",
    audience: "Admins",
    minutes: 8,
    keywords: ["setup", "onboarding", "practice info", "locations", "rooms", "appointment types", "tax", "timezone", "price list"],
    steps: [
      {
        id: "practice",
        title: "Fill in Practice Info",
        body: ["In [[Settings]] → [[Practice Info]], enter the clinic's name, contact details, timezone, country, currency, and tax details."],
        shot: {
          id: "settings",
          callouts: ["sections", "practice"],
          alt: "Settings, with the list of sections on the left and the Practice details form",
        },
      },
      {
        id: "schedule",
        title: "Set up the schedule",
        body: [
          "Add [[Locations]], [[Staff]], [[Appointment Types]], and [[Rooms]]. Use names the front desk will recognize at a glance.",
        ],
        shot: {
          id: "settings-appointment-types",
          alt: "The Appointment Types section of Settings, listing each type with its length and color",
        },
      },
      {
        id: "prices",
        title: "Build your price list",
        body: ["In [[Services & Pricing]], add the services and products your team charges for. Check prices and tax before you go live."],
      },
      {
        id: "test-day",
        title: "Run one test day",
        body: [
          "Create a test client and pet. Book the visit, check it in, chart it, invoice it, record a test payment, and run an export.",
          "If any step surprises you, fix the setup now rather than on a busy morning.",
        ],
      },
    ],
    next: "invite-and-manage-staff",
  },
  {
    slug: "invite-and-manage-staff",
    title: "Invite and manage staff",
    summary: "Give each teammate their own login and the right role.",
    category: "administration",
    area: "settings",
    audience: "Admins",
    minutes: 5,
    keywords: ["invite", "staff", "user", "account", "add user", "remove user", "role", "login", "disable"],
    steps: [
      {
        id: "add",
        title: "Add the teammate",
        body: ["Open [[Settings]] → [[Staff]]. Add their work email and name, and pick the role that matches their job."],
        shot: {
          id: "settings-staff",
          alt: "The Staff section of Settings, with Invite by email and Add Staff buttons above the team list",
        },
      },
      {
        id: "invite",
        title: "Send the invitation",
        body: ["Each teammate signs in with their own invitation and account. Don't share one front desk or doctor login. Individual logins keep the history accurate."],
      },
      {
        id: "review",
        title: "Keep access up to date",
        body: ["Change roles when jobs change. Turn off access as soon as someone leaves."],
      },
    ],
    next: "set-up-client-card-payments",
  },
  {
    slug: "set-up-client-card-payments",
    title: "Set up card payments",
    summary: "Connect Stripe so you can take cards from clients, then test it.",
    category: "administration",
    area: "settings",
    audience: "Admins",
    minutes: 6,
    keywords: ["stripe", "card", "credit card", "payments", "payouts", "bank", "connect", "merchant"],
    steps: [
      {
        id: "open",
        title: "Open client payment processing",
        body: ["Go to [[Settings]] → [[Plan & Billing]] and find **Client payment processing**. It shows whether cards and payouts are ready."],
        shot: {
          id: "settings-plan",
          alt: "Plan & Billing in Settings, showing Client payment processing as not configured",
        },
      },
      {
        id: "setup",
        title: "Finish the setup",
        body: [
          "On OpenVPM Cloud, Stripe may ask for your legal business and tax details, ID for a representative, and a bank account for payouts.",
          "If you run OpenVPM yourself, follow the [self-hosted Stripe setup](https://github.com/evangauer/openvpm/blob/main/docs/help/self-hosted-payments.md).",
        ],
      },
      {
        id: "verify",
        title: "Test before you use it for real",
        body: ["Refresh the status and make sure card payments and payouts are on. Then run a test invoice through checkout."],
        important: "A saved Stripe key doesn't mean everything works. Always run a test payment first.",
      },
    ],
    next: "import-your-data",
  },
  {
    slug: "import-your-data",
    title: "Import your data",
    summary: "Bring over clients, pets, vaccine history, and medical history from a CSV file.",
    category: "administration",
    area: "settings",
    audience: "Admins",
    minutes: 8,
    before: "Keep the original export untouched. Clean up a copy instead.",
    keywords: ["import", "migrate", "migration", "csv", "avimark", "cornerstone", "ezyvet", "switch", "move data"],
    steps: [
      {
        id: "order",
        title: "Import in order",
        body: ["Import clients first, then pets, then vaccine history and medical history. Each file needs the owners and pets from the one before."],
      },
      {
        id: "dry-run",
        title: "Do a dry run",
        body: [
          "Open [[Settings]] → [[Data]] → [[Import Data]]. Choose the system you're coming from and what you're importing, then upload the CSV.",
          "OpenVPM shows what will import, what matches an existing record, what's a duplicate, and what it can't use. Nothing is saved yet.",
        ],
      },
      {
        id: "check",
        title: "Fix problems, then import",
        body: ["Fix the rows it flagged and run the preview again. Then import. Compare record counts and spot-check some charts before you rely on the data."],
        important:
          "Future appointments, open balances, active prescriptions, attachments, labs, inventory, reminders, and messages aren't part of the CSV import. Plan those separately.",
      },
    ],
    faq: [["Where can I read more about switching?", "See [Migrating to OpenVPM](https://github.com/evangauer/openvpm/blob/main/docs/migrating-to-openvpm.md)."]],
    next: "export-and-back-up-your-data",
  },
  {
    slug: "export-and-back-up-your-data",
    title: "Export and back up your data",
    summary: "Your data is yours. Take a copy any time, and keep backups you've tested.",
    category: "administration",
    area: "settings",
    audience: "Admins",
    minutes: 7,
    keywords: ["export", "backup", "back up", "download data", "csv", "restore", "json", "portability"],
    steps: [
      {
        id: "export",
        title: "Export your records",
        body: [
          "Go to [[Settings]] → [[Data]]. Export clients, patients, appointments, or invoices as CSV files.",
          "[[Export Database Backup]] saves a JSON copy of your records and a list of attachments. It doesn't include the uploaded files themselves.",
        ],
        shot: {
          id: "settings-data",
          alt: "The Data section of Settings with export buttons for the database backup, clients, patients, appointments, and invoices",
        },
      },
      {
        id: "backup",
        title: "Back up the database and files together",
        body: ["If you run OpenVPM yourself, back up the PostgreSQL database and the file storage together. Keep encrypted copies somewhere other than the server."],
      },
      {
        id: "restore",
        title: "Practice a restore",
        body: ["Restore a backup to a separate test setup now and then. Check records, attachments, and logins. A backup only counts once you've restored it."],
      },
    ],
  },
  {
    slug: "run-a-solo-practice",
    title: "Run a solo practice",
    summary: "Handle the exam, the bill, and the follow-up yourself, from one account.",
    category: "administration",
    area: "settings",
    audience: "Solo vets, practice owners",
    minutes: 6,
    keywords: ["solo", "one vet", "owner", "small clinic", "mobile", "house call", "ambulatory", "field visit", "large animal"],
    steps: [
      {
        id: "account",
        title: "Use an admin account",
        body: [
          "If you do both the medicine and the money, sign in as an **admin**. Admins can chart and also charge, take payments, and refund. The **veterinarian** role is clinical only.",
          "Give anyone who helps, even part-time, their own login so the record shows who did what. See [Invite and manage staff](/guides/invite-and-manage-staff).",
        ],
        shot: { id: "settings-staff", alt: "The Staff section of Settings, listing each teammate and their role" },
      },
      {
        id: "visit",
        title: "Keep the whole visit in one place",
        body: [
          "Open the visit from [[Schedule]] and use that same visit for notes, treatments, charges, and closeout, so everything stays linked. Outside records go on the pet's [[Documents]] tab ([how](/guides/upload-a-patient-document)).",
        ],
        shot: {
          id: "visit",
          focus: ["header", "checklist"],
          pad: 12,
          callouts: ["checklist"],
          alt: "A visit page with the Finish this visit checklist",
        },
      },
      {
        id: "charge",
        title: "Charge and get paid yourself",
        body: [
          "While the pet is in the exam, add charges in **Charge capture** ((1)). Then create the invoice, take the payment, and check the balance that's left. See [Take a payment](/guides/take-a-payment).",
        ],
        shot: {
          id: "visit-exam",
          focus: "charge-capture",
          pad: 12,
          callouts: ["charge-capture"],
          alt: "The Charge capture section of a visit that's in the exam",
        },
      },
      {
        id: "follow-up",
        title: "Book the follow-up, don't just note it",
        body: [
          "A follow-up date in the discharge is a plan, not an appointment. In closeout, choose [[Schedule follow-up (opens new tab)]], book it, come back, and choose [[Refresh appointments]]. Then pick the visit you booked so it's linked.",
        ],
      },
      {
        id: "field",
        title: "Seeing patients on the road (optional)",
        body: [
          "For house calls and farm visits, an admin can turn on **Ambulatory workspace** in [[Settings]] → [[Practice Info]], pick your units and body condition scale, and save. Active patient charts then get a [[Start field visit]] button, so you can start a visit without booking it first.",
          "On a field visit, **Bill now, finish notes later** lets you take payment before the notes are done. **Unfinished field visits** on the [[Dashboard]] shows what still needs notes.",
        ],
        tip: "Don't see Ambulatory workspace in Settings? It hasn't been made available for your OpenVPM yet. On a self-hosted install, whoever runs the server turns it on first.",
        important: "Taking payment doesn't finish the medical record. Come back and complete the notes.",
      },
      {
        id: "trial",
        title: "Do a practice run first",
        body: ["Before your first real day, take a made-up patient through a whole visit: chart, charge, invoice, payment, discharge, and a booked follow-up. Then check the record and the bill look right."],
      },
    ],
    faq: [
      ["I entered a weight wrong", "On the pet's [[Weight History]] tab, choose [[Correct]] next to the weight, enter the right value, when it was measured, and a reason, then [[Save correction]]. The original stays on file. A weight that came from a visit's vitals shows [[Review vitals]] instead; correct it there."],
    ],
    next: "set-up-client-card-payments",
  },
];
