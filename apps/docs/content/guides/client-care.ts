import type { Guide } from "../types";

export const clientCare: Guide[] = [
  {
    slug: "give-client-portal-access",
    title: "Give a client portal access",
    summary: "Send an owner a one-time link into a private portal with their pets, visits, and bills.",
    category: "client-care",
    area: "clients",
    audience: "Front desk, admins",
    minutes: 3,
    keywords: ["portal", "client portal", "owner login", "link", "pet parent", "online"],
    steps: [
      {
        id: "open",
        title: "Open the client",
        body: ["Go to [[Clients]], search for the owner, and open the right household."],
      },
      {
        id: "link",
        title: "Create and copy the private link",
        body: [
          "Find **Client Portal** and choose [[Create Link]] ((1)), then [[Copy]]. The link works once and expires after 15 minutes, so create it when you're ready to send it.",
          "If the client has had a link before, the button says [[Reset Access]]. Resetting cancels the old link and signs the client out of the portal everywhere.",
          "The portal shows the household's pets, upcoming visits, health records, invoices, and online payment. Clients don't need a password.",
        ],
        shot: {
          id: "client",
          focus: "portal",
          pad: 16,
          callouts: ["create-link"],
          alt: "The Client Portal section on a client's page, which explains that links are one-time and expire after 15 minutes",
        },
      },
      {
        id: "share",
        title: "Send it securely",
        body: [
          "Send it right away by your clinic's usual email or text. It only shows that household's information.",
          "When the client opens it and chooses **Continue securely**, it starts a portal session on their device and the link stops working. If they're signed out later, create a new one.",
        ],
        important: "Don't open the link yourself to test it. That uses it up, and the client will need a new one.",
      },
    ],
    next: "manage-appointment-requests",
  },
  {
    slug: "manage-appointment-requests",
    title: "Handle appointment requests",
    summary: "Review times clients asked for online before they go on the schedule for good.",
    category: "client-care",
    area: "inbox",
    audience: "Front desk, admins",
    minutes: 4,
    keywords: ["online booking", "request", "portal booking", "book online", "requested appointment"],
    steps: [
      {
        id: "review",
        title: "Read the request",
        body: [
          "Open [[Inbox]] and find the request. Check the client, pet, reason, preferred time, and any message.",
          "OpenVPM also puts a provisional **Scheduled** appointment in the requested slot.",
        ],
      },
      {
        id: "adjust",
        title: "Adjust the provisional appointment",
        body: ["Open it on [[Schedule]] and choose [[Edit appointment]] to set the right visit type, doctor, room, length, or a different time. Call or message the client if the time doesn't work."],
      },
      {
        id: "confirm",
        title: "Confirm it",
        body: ["Once the client agrees, choose [[Confirm]], pick phone or email, and record the confirmation. Send a reminder or message separately if needed."],
      },
    ],
    next: "send-a-client-message",
  },
  {
    slug: "send-a-client-message",
    title: "Message a client",
    summary: "Keep email, texts, and portal messages in one shared history.",
    category: "client-care",
    area: "inbox",
    audience: "Front desk, admins",
    minutes: 4,
    keywords: ["message", "text", "sms", "email", "communication", "inbox", "conversation", "reply"],
    steps: [
      {
        id: "open",
        title: "Open the conversation",
        body: [
          "Open [[Inbox]] and pick the client from the list ((1)), or choose [[New Message]] ((2)). Make sure you have the right household and recipient.",
        ],
        shot: {
          id: "inbox",
          callouts: ["list", "new-message"],
          alt: "The Inbox with a list of client conversations and an open conversation",
        },
      },
      {
        id: "channel",
        title: "Pick a channel that's set up",
        body: ["Email needs a configured email provider. Texting needs to be switched on for your clinic, approved by the carriers, and agreed to by the client."],
      },
      {
        id: "send",
        title: "Check it and send",
        body: ["Leave health and payment details out of messages unless they're needed. Check that it was delivered, and note any follow-up."],
      },
    ],
    next: "set-up-your-clinic",
  },
  {
    slug: "send-vaccine-recalls",
    title: "Send vaccine recalls",
    summary: "See which pets are overdue for vaccines and remind their owners on purpose.",
    category: "client-care",
    area: "recalls",
    audience: "Front desk, vets, admins",
    minutes: 4,
    keywords: ["recall", "vaccine reminder", "overdue", "booster", "due", "lapsed", "reminder card"],
    steps: [
      {
        id: "review",
        title: "See who's overdue",
        body: [
          "Open [[Recalls]]. The counts at the top ((1)) show how many pets are overdue, ready to remind, blocked, or already reminded.",
          "Each row lists the pet and owner and the vaccines that are overdue ((2)), with their due dates.",
        ],
        shot: {
          id: "recalls",
          focus: ["stats", "vaccines"],
          pad: 12,
          callouts: ["stats", "vaccines"],
          alt: "The Vaccination recalls screen listing overdue pets and their vaccines",
        },
      },
      {
        id: "check",
        title: "Check why anyone is blocked",
        body: [
          "The **Eligibility** column ((1)) says **Ready**, **Already reminded**, or **Blocked** with the reason: the owner opted out, there's no working email or opted-in mobile number, it's quiet hours for texting, or the contact is a test or sample record.",
        ],
        shot: {
          id: "recalls",
          focus: "list",
          pad: 12,
          callouts: ["eligibility"],
          alt: "Recall rows with the eligibility column showing why each one is blocked",
        },
        tip: "Fix contact details on the client's page, then choose [[Refresh preview]].",
      },
      {
        id: "send",
        title: "Send",
        body: [
          "Tick the **Ready** pets you want to remind ((1)), up to 100 at a time. Then choose [[Send selected]] ((2)) and confirm. Or use [[Send]] on a single row.",
          "Each reminder goes by the client's usable channel, text or email, and is logged on their communication history.",
        ],
        shot: {
          id: "recalls",
          focus: "preview",
          pad: 12,
          callouts: ["ready-row", "send-selected"],
          alt: "The Recipient preview with a ready pet ticked and the Send selected button",
        },
      },
    ],
    faq: [
      ["A pet I vaccinated last week is still on the list", "Recalls follow the most recent record of each vaccine. Check the new vaccine was recorded on the pet's [[Vaccinations]] tab with a next due date. See [Record a vaccine](/guides/record-a-vaccine)."],
    ],
    next: "work-the-care-reminder-queue",
  },
  {
    slug: "work-the-care-reminder-queue",
    title: "Work the care reminder queue",
    summary: "Track rechecks, calls, and other follow-ups for each pet so none slip.",
    category: "client-care",
    area: "care-reminders",
    audience: "Everyone except viewers",
    minutes: 4,
    keywords: ["care reminder", "follow up", "to do", "task", "recheck", "callback", "due", "queue"],
    steps: [
      {
        id: "queue",
        title: "Start with what's due",
        body: [
          "Open [[Care Reminders]]. Each row ((1)) shows the due date, pet and owner, and what needs doing. Anything due today or earlier is in red.",
          "Use the buttons ((2)) to switch between open, completed, and dismissed, or to see only overdue or upcoming work.",
        ],
        shot: {
          id: "care-reminders",
          focus: "queue",
          pad: 12,
          callouts: ["row", "filters"],
          alt: "The Patient follow-up queue with open reminders, the first one overdue",
        },
      },
      {
        id: "add",
        title: "Add a reminder",
        body: ["Choose [[Add reminder]], search for the pet, write what needs doing in [[Reminder]], pick a [[Due date]], add notes if they help, and choose [[Save reminder]]."],
      },
      {
        id: "close",
        title: "Close it out",
        body: [
          "When it's done, choose [[Complete]] ((1)). If the owner needs to hear from you, choose [[Contact client]] ((2)), pick email or text, check the preview, and send.",
          "If a reminder shouldn't be there at all, tick it and choose [[Dismiss selected]], with a short reason. Dismissed reminders can be restored.",
        ],
        shot: {
          id: "care-reminders",
          focus: "row",
          pad: 28,
          callouts: ["complete", "contact"],
          alt: "A care reminder row with Complete and Contact client buttons",
        },
        important: "Nothing on this list is sent to clients on its own. Completing a reminder doesn't message anyone.",
      },
    ],
    next: "send-a-client-message",
  },
];
