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
          "When the client confirms, open the visit and choose [[Confirm]]. The pet shows in **Waiting** ((1)) on the [[Whiteboard]].",
          "When the pet arrives, choose [[Check In]]. It moves to **In Progress** ((2)), and to **Completed** ((3)) once checkout is done.",
        ],
        shot: {
          id: "whiteboard",
          focus: ["waiting-card", "in-progress-card", "completed-card"],
          pad: 104,
          callouts: ["waiting-head", "in-progress-head", "completed-head"],
          alt: "The whiteboard with Waiting, In Progress, and Completed columns, each with a pet card",
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
          "Take payment, or set the balance to pay later with a due date. Then set **Owner handoff** to printed or downloaded, reviewed verbally, or owner declined, and choose [[Complete visit]].",
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
          "You only see the areas your role can use. For example, only admins see [[Settings]].",
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
          "Only admins and front desk staff can change billing, including marking visit work as no charge and setting product prices or tax status. Some clinical corrections and all refunds need an admin.",
          "The controlled-substance log is visible only to admins and veterinarians.",
        ],
      },
    ],
    faq: [
      ["Why can't I add charges to a visit?", "Charges can be added by the front desk or an admin while the visit is [[In Exam]]. Vets and techs can see the charges but not change them. Before the exam starts, or once closeout is complete, charges are locked for everyone. The charges panel says which of these applies."],
      ["How do I change someone's role?", "An admin can change it in [[Settings]] → [[Staff]]. See [Invite and manage staff](/guides/invite-and-manage-staff)."],
    ],
    next: "book-an-appointment",
  },
  {
    slug: "ask-the-agent",
    title: "Ask the Agent about your clinic",
    summary: "Ask a question in plain words instead of clicking through charts and reports.",
    category: "start-here",
    area: "agent",
    audience: "Vets, admins",
    minutes: 3,
    keywords: ["ai", "assistant", "agent", "ask", "chat", "question", "summary", "overdue", "search"],
    steps: [
      {
        id: "ask",
        title: "Ask a question",
        body: [
          "Open [[Agent]] and type a question, or start with one of the suggestions ((1)). For example: “Which patients are overdue for vaccinations?” or “Summarize today's appointments.”",
          "The Agent looks up your clinic's records to answer. It only sees your practice's data.",
        ],
        shot: {
          id: "agent",
          focus: "prompts",
          pad: 16,
          callouts: ["prompts"],
          alt: "The OpenVPM Agent with four suggested questions",
        },
      },
      {
        id: "writes",
        title: "Let it make a change only when you mean to",
        body: [
          "By default the Agent only reads. To have it book an appointment or record vitals, tick [[Allow writes: appointments and patient vitals]] under the message box before you send. The box clears after each request.",
        ],
      },
      {
        id: "check",
        title: "Check the answer",
        body: ["Treat answers like a colleague's notes: open the chart before acting on anything clinical, and double-check doses against your own references."],
        important: "You're responsible for clinical decisions. The Agent helps you find things faster; it doesn't replace your judgment.",
      },
    ],
    faq: [
      ["I don't see the Agent, or it says it isn't available", "Only admins and veterinarians can use the Agent. On OpenVPM Cloud it's ready to go once your clinic has a card on file. If you run OpenVPM yourself, the server needs an AI provider set up first."],
    ],
    next: "find-anything-fast",
  },
];
