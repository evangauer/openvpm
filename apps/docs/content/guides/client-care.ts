import type { Guide } from "../types";

export const clientCare: Guide[] = [
  {
    slug: "give-client-portal-access",
    title: "Give a client portal access",
    summary: "Share one private link where owners see their pets, visits, and bills.",
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
          "Find **Client Portal** ((1)). Choose [[Create Link]] if there isn't one yet, then copy it.",
          "The portal shows the household's pets, upcoming visits, health records, invoices, and online payment. Clients don't need a password.",
        ],
        shot: {
          id: "client",
          focus: "portal",
          pad: 16,
          callouts: ["portal"],
          alt: "The Client Portal section on a client's page with a Create Link button",
        },
      },
      {
        id: "share",
        title: "Send it securely",
        body: ["Send the link by your clinic's usual email or text. It only shows that household's information. Open it yourself if you want to see what the client sees."],
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
];
