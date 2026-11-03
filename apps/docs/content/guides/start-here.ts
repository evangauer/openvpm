import type { Guide } from "../types";

export const startHere: Guide[] = [
  {
    slug: "your-first-day",
    title: "Your first clinic day",
    summary: "Follow one visit from booking to payment, and see who does each part.",
    category: "start-here",
    area: "dashboard",
    audience: "Everyone",
    minutes: 7,
    before: "Practice with sample pets in the [demo clinic](https://demo.openvpm.com/login) until the team feels comfortable.",
    keywords: ["overview", "walkthrough", "tour", "workflow", "getting started", "new"],
    steps: [
      {
        id: "book",
        title: "Book the visit",
        body: [
          "Open [[Schedule]] and click an open time. Pick the pet, visit type, doctor, room, and time, then save.",
          "See [Book an appointment](/guides/book-an-appointment) for every option.",
        ],
        shot: {
          id: "schedule",
          callouts: ["nav-schedule", "new-appointment"],
          alt: "The schedule, with Schedule highlighted in the sidebar and the New Appointment button highlighted",
        },
      },
      {
        id: "check-in",
        title: "Check the pet in",
        body: [
          "When the client confirms, open the visit and choose [[Confirm]]. When the pet arrives, choose [[Check In]].",
          "The pet now shows on the [[Whiteboard]] for the whole team.",
        ],
        shot: {
          id: "whiteboard",
          focus: ["waiting", "in-progress", "completed"],
          pad: 12,
          callouts: ["waiting", "in-progress", "completed"],
          alt: "The whiteboard with Waiting, In Progress, and Completed columns",
        },
      },
      {
        id: "chart",
        title: "Chart the visit",
        body: [
          "The vet or tech opens the visit to record vitals, vaccines, prescriptions, and lab work.",
          "A veterinarian or admin writes and finalizes the SOAP note.",
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
        id: "charge",
        title: "Add the charges",
        body: ["A front desk teammate or admin adds the services and products from the visit. Review the draft invoice before showing it to the client."],
      },
      {
        id: "pay",
        title: "Get paid and send them home",
        body: [
          "Take payment, or set the balance to pay later with a due date. Then record how you gave the owner their instructions, and finish the visit.",
        ],
        tip: "The [[Finish this visit]] checklist on the visit page shows what's left: clinical record, charges, reconciliation, owner handoff, and checkout.",
      },
    ],
    next: "book-an-appointment",
  },
  {
    slug: "find-anything-fast",
    title: "Find anything fast",
    summary: "Get around OpenVPM and jump straight to the right client or pet.",
    category: "start-here",
    area: "dashboard",
    audience: "Everyone",
    minutes: 3,
    keywords: ["search", "navigation", "menu", "sidebar", "lookup", "find client", "find patient"],
    steps: [
      {
        id: "sidebar",
        title: "Use the sidebar",
        body: [
          "The sidebar follows the clinic day. [[Schedule]] and [[Whiteboard]] show today. [[Patients]], [[Clients]], and [[Records]] hold the charts.",
          "[[Billing]], [[Inventory]], [[Inbox]], [[Reports]], and [[Settings]] cover the rest of the practice.",
        ],
      },
      {
        id: "search",
        title: "Search before you add",
        body: [
          "Press **⌘K** (or **Ctrl+K** on Windows) anywhere, then type a pet or owner name. Search first, so new work lands on the chart you already have instead of a duplicate.",
        ],
        shot: { id: "search", focus: "palette", pad: 16, alt: "The search box open with results for Max" },
      },
      {
        id: "verify",
        title: "Check you have the right household",
        body: ["Confirm the owner's name, phone, and pet before you edit or book anything."],
      },
    ],
    next: "understand-team-roles",
  },
  {
    slug: "understand-team-roles",
    title: "Understand team roles",
    summary: "Know what admins, vets, techs, and the front desk can each do.",
    category: "start-here",
    area: "settings",
    audience: "Everyone",
    minutes: 4,
    keywords: ["permissions", "access", "role", "admin", "viewer", "can't", "greyed out", "missing button"],
    steps: [
      {
        id: "roles",
        title: "Each teammate gets the role closest to their job",
        body: [
          "**Admins** run the clinic and handle high-risk actions. **Veterinarians** and **technicians** work in the medical record. **Front desk** staff run the schedule and billing. **Viewers** can look but not change anything.",
        ],
        shot: { id: "settings-staff", alt: "The Staff section of Settings, listing each teammate and their role" },
      },
      {
        id: "protected",
        title: "Some actions are protected",
        body: [
          "If a button is missing or read-only, check which role you're signed in with before assuming something is broken.",
          "Only admins and front desk staff can change billing. Some clinical corrections and all refunds need an admin.",
        ],
      },
    ],
    faq: [
      ["Charge capture says it's read-only for me", "Charges can be added by the front desk or an admin while the visit is [[In Exam]]. Vets and techs can see the charges but not change them. Before the exam starts, or after checkout, charges are read-only for everyone."],
      ["How do I change someone's role?", "An admin can change it in [[Settings]] → [[Staff]]. See [Invite and manage staff](/guides/invite-and-manage-staff)."],
    ],
    next: "book-an-appointment",
  },
];
