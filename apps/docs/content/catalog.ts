import type { AreaId, CategoryId, Training } from "./types";

export const categories: { id: CategoryId; title: string; summary: string }[] = [
  { id: "start-here", title: "Start here", summary: "Find your way around and follow one visit from start to finish." },
  { id: "front-desk", title: "Front desk", summary: "Book visits, check pets in, and keep the day moving." },
  { id: "clinical-care", title: "Clinical care", summary: "Chart the visit, record treatments, and hand off cleanly." },
  { id: "checkout", title: "Checkout and payments", summary: "Charge for the visit, present the bill, and get paid." },
  { id: "client-care", title: "Client care", summary: "Keep pet owners informed between visits." },
  { id: "administration", title: "Practice setup", summary: "Set up the clinic, your team, payments, and your data." },
];

/** The OpenVPM sidebar, in order. Every item gets a screen tour. */
export const areas: { id: AreaId; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "patients", label: "Patients" },
  { id: "clients", label: "Clients" },
  { id: "schedule", label: "Schedule" },
  { id: "records", label: "Records" },
  { id: "lab-inbox", label: "Lab Inbox" },
  { id: "billing", label: "Billing" },
  { id: "inventory", label: "Inventory" },
  { id: "inbox", label: "Inbox" },
  { id: "recalls", label: "Recalls" },
  { id: "care-reminders", label: "Care Reminders" },
  { id: "imported-history", label: "Imported History" },
  { id: "whiteboard", label: "Whiteboard" },
  { id: "agent", label: "Agent" },
  { id: "controlled-substances", label: "Controlled Substances" },
  { id: "reports", label: "Reports" },
  { id: "settings", label: "Settings" },
];

export const trainings: Training[] = [
  {
    id: "front-desk",
    title: "Front desk training",
    shortTitle: "Front desk",
    summary: "Book, check in, check out, and keep clients in the loop.",
    sections: [
      { title: "Get oriented", guides: ["your-first-day", "find-anything-fast"] },
      {
        title: "Run the schedule",
        guides: ["add-a-new-client-and-pet", "book-an-appointment", "reschedule-or-cancel", "check-in-a-patient", "use-the-whiteboard", "send-appointment-reminders", "see-the-schedule-in-your-calendar"],
      },
      {
        title: "Check out",
        guides: ["capture-visit-charges", "create-and-present-an-invoice", "take-a-payment", "place-a-balance-in-accounts-receivable"],
      },
      { title: "Help clients", guides: ["give-client-portal-access", "manage-appointment-requests", "send-a-client-message", "send-vaccine-recalls"] },
    ],
  },
  {
    id: "clinical-team",
    title: "Veterinarian and technician training",
    shortTitle: "Vets and techs",
    summary: "Chart the visit, record treatments, and hand off cleanly.",
    sections: [
      { title: "Get oriented", guides: ["your-first-day", "find-anything-fast", "understand-team-roles", "ask-the-agent"] },
      { title: "Chart the visit", guides: ["document-a-visit", "record-vitals", "write-a-soap-note", "upload-a-patient-document"] },
      { title: "Record treatments", guides: ["record-lab-results", "create-a-prescription", "record-a-vaccine"] },
      { title: "Hand off", guides: ["complete-discharge-and-follow-up", "work-the-care-reminder-queue"] },
    ],
  },
  {
    id: "practice-administration",
    title: "Practice manager training",
    shortTitle: "Practice managers",
    summary: "Set up the clinic, manage staff, money, and your data.",
    sections: [
      { title: "Get oriented", guides: ["your-first-day", "understand-team-roles"] },
      { title: "Set up the clinic", guides: ["set-up-your-clinic", "invite-and-manage-staff", "send-appointment-reminders", "run-a-solo-practice"] },
      { title: "Money", guides: ["set-up-client-card-payments"] },
      { title: "Your data", guides: ["import-your-data", "export-and-back-up-your-data"] },
    ],
  },
];

/** The clinic day the first-day walkthrough follows. */
export const firstDay = [
  { label: "Book", guide: "book-an-appointment" },
  { label: "Check in", guide: "check-in-a-patient" },
  { label: "Chart", guide: "document-a-visit" },
  { label: "Charge", guide: "capture-visit-charges" },
  { label: "Get paid", guide: "take-a-payment" },
] as const;

export const APP_URL = "https://app.openvpm.com";
export const DEMO_URL = "https://demo.openvpm.com/login";
export const SUPPORT_EMAIL = "hello@openvpm.com";
