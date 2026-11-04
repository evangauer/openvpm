import type { Guide } from "../types";

export const frontDesk: Guide[] = [
  {
    slug: "add-a-new-client-and-pet",
    title: "Add a new client and pet",
    summary: "Set up a new household and their pet so you can book the first visit.",
    category: "front-desk",
    area: "clients",
    audience: "Front desk, vets, techs, admins",
    minutes: 3,
    before: "Search first with **⌘K**, by the owner's last name or phone, so you don't create a duplicate.",
    keywords: ["new client", "new patient", "add pet", "add owner", "register", "new household", "sign up", "first visit", "intake"],
    steps: [
      {
        id: "client",
        title: "Add the client",
        body: [
          "Go to [[Clients]] and choose [[New Client]]. Enter the first and last name ((1)). They're the only required fields, but add an email and phone so the clinic can reach them.",
          "Choose how they'd like reminders in [[Preferred contact for reminders]] ((2)).",
        ],
        shot: {
          id: "client-new",
          focus: "form",
          pad: 12,
          callouts: ["names", "contact"],
          alt: "The New Client form with name, email, and phone filled in, and the reminder preference",
        },
      },
      {
        id: "consent",
        title: "Record text consent only if they gave it",
        body: [
          "Tick the consent box ((1)) only after the client has read the text message disclosure, or you've read it to them. It needs a valid mobile number.",
          "Then choose [[Create Client]] ((2)). The client's page opens.",
        ],
        shot: {
          id: "client-new",
          focus: "form",
          pad: 12,
          callouts: ["consent", "create"],
          alt: "The New Client form with the SMS consent box and Create Client button",
        },
      },
      {
        id: "pet",
        title: "Add their pet",
        body: [
          "On the new client's page, choose [[Add patient]] under **Patients**. The owner ((1)) is already filled in.",
          "Enter the [[Patient Name]] ((2)) and [[Species]] ((3)). Add the breed, sex, date of birth, color, and microchip number if you have them. Then choose [[Create Patient]] ((4)).",
        ],
        tip: "Adding another pet for a client who's already here? Go to [[Patients]] → [[New Patient]] and search for the owner.",
        shot: {
          id: "patient-new",
          focus: "form",
          pad: 12,
          callouts: ["owner", "name", "species", "create"],
          alt: "The New Patient form with the owner chosen and the pet's name filled in",
        },
      },
      {
        id: "book",
        title: "Book the visit",
        body: ["The pet's chart opens. Now [book the appointment](/guides/book-an-appointment)."],
      },
    ],
    faq: [
      ["I added someone twice", "Open [[Patients]] and choose [[Review duplicates]] to find pets that were added twice and merge them."],
    ],
    next: "book-an-appointment",
  },
  {
    slug: "book-an-appointment",
    title: "Book an appointment",
    summary: "Put a visit on the schedule in under a minute so the whole team sees it.",
    category: "front-desk",
    area: "schedule",
    audience: "Front desk, admins",
    minutes: 4,
    before: "The client and pet should already be in OpenVPM. Search for them first with **⌘K**. New to the clinic? [Add the client and pet](/guides/add-a-new-client-and-pet) first.",
    keywords: ["schedule", "booking", "new appointment", "visit", "recurring", "repeat"],
    steps: [
      {
        id: "open",
        title: "Open the schedule",
        body: ["Choose [[Schedule]] ((1)) in the sidebar. Then click an open time, or choose [[New Appointment]] ((2))."],
        shot: {
          id: "schedule",
          callouts: ["nav-schedule", "new-appointment"],
          alt: "The schedule. Schedule is highlighted in the sidebar and New Appointment is highlighted at the top right.",
        },
      },
      {
        id: "details",
        title: "Add the visit details",
        body: [
          "Search for the pet ((1)). Then pick the visit type ((2)), the doctor ((3)), the room, the date, and the start time. Add a note if the team needs context before the pet arrives.",
        ],
        tip: "For a visit that repeats, turn on [[Repeat appointment]] and choose how often. Repeat visits need a pet.",
        shot: {
          id: "schedule-new",
          focus: "dialog",
          pad: 8,
          callouts: ["patient", "type", "doctor"],
          alt: "The New Appointment form with fields for location, patient, type, doctor, room, date, and time",
        },
      },
      {
        id: "save",
        title: "Save it",
        body: [
          "Choose [[Save]]. The visit shows in the doctor's column, marked **Scheduled**.",
          "Click any visit to open it. From there you can confirm, check in, edit, cancel, or mark a no-show.",
        ],
      },
      {
        id: "confirm",
        title: "Mark it confirmed once the client agrees",
        body: [
          "Open the visit and choose [[Confirm]] ((1)). Pick how they confirmed, by phone or email, then choose [[Record confirmation]].",
        ],
        important: "This only records the confirmation. It doesn't send the client a message.",
        shot: {
          id: "schedule-confirm",
          focus: "popover",
          pad: 8,
          callouts: ["confirm"],
          alt: "An appointment marked Scheduled, with the Confirm button highlighted",
        },
      },
    ],
    statusFlow: true,
    faq: [
      ["The pet doesn't come up when I search", "Check the spelling, or search by the owner's last name. If they're new, [add the client and pet](/guides/add-a-new-client-and-pet) first."],
      ["Can I book without choosing a doctor?", "Yes. But if the visit type needs a doctor, [[Confirm]] and [[Check In]] stay greyed out until you assign one with [[Edit appointment]]."],
      ["How do I set up a repeating visit?", "Turn on [[Repeat appointment]]. Choose **Weekly**, **Monthly**, or **Annual**, how often in [[Every]], and how many visits in [[Occurrences]]. To stop the rest of a series later, open one of its visits and choose [[Cancel Future Series]]."],
    ],
    next: "check-in-a-patient",
  },
  {
    slug: "reschedule-or-cancel",
    title: "Reschedule or cancel",
    summary: "Change a booked visit without losing its history.",
    category: "front-desk",
    area: "schedule",
    audience: "Front desk, admins",
    minutes: 3,
    keywords: ["move", "change time", "edit appointment", "cancel", "delete", "no show"],
    steps: [
      {
        id: "open",
        title: "Open the visit",
        body: ["Find the visit on [[Schedule]] and click it. Check the pet and the original time before you change anything."],
      },
      {
        id: "change",
        title: "Choose the change",
        body: [
          "To move it, choose [[Edit appointment]] ((1)). You can change the date, time, length, location, doctor, or room.",
          "Choose [[Cancel]] ((2)) only when the visit won't happen. If they simply didn't arrive, choose [[No Show]] instead.",
        ],
        important: "Moving a confirmed visit to a new date, time, length, or location sets it back to **Scheduled**, so you can confirm the new details with the client.",
        shot: {
          id: "schedule-confirm",
          focus: "popover",
          pad: 8,
          callouts: ["edit", "cancel"],
          alt: "An open appointment with Edit appointment and Cancel highlighted",
        },
      },
      {
        id: "tell",
        title: "Make sure the client knows",
        body: [
          "Confirm the client has the new time. Whether OpenVPM can email or text them depends on your clinic's setup, so check the client's message history when it matters.",
        ],
      },
    ],
    faq: [
      ["Should I delete or cancel?", "Cancel keeps the visit in the history. Use [[Delete appointment]] only for a booking made by mistake."],
    ],
    next: "check-in-a-patient",
  },
  {
    slug: "check-in-a-patient",
    title: "Check a patient in",
    summary: "Mark them arrived. They go straight to the whiteboard.",
    category: "front-desk",
    area: "schedule",
    audience: "Front desk, clinical team",
    minutes: 3,
    keywords: ["arrive", "arrival", "check in", "waiting room", "lobby"],
    steps: [
      {
        id: "open",
        title: "Open the visit",
        body: [
          "Click the visit on [[Schedule]]. Check the pet, owner, doctor, visit type, and any notes.",
          "If it's still **Scheduled** and your clinic asks for confirmation, choose [[Confirm]] first.",
        ],
      },
      {
        id: "check-in",
        title: "Choose Check In",
        body: ["Choose [[Check In]] ((1)). The visit is now **Checked in** and moves to **In Progress** on the [[Whiteboard]]."],
        shot: {
          id: "schedule-check-in",
          focus: "popover",
          pad: 8,
          callouts: ["check-in"],
          alt: "An appointment with the Check In button highlighted",
        },
      },
      {
        id: "handoff",
        title: "Hand off to the clinical team",
        body: [
          "Set the room before you check the pet in. Rooms are changed with [[Edit appointment]], which is only there while the visit is **Scheduled** or **Confirmed**.",
          "When clinical work starts, the vet or tech chooses [[In Exam]] on the schedule, or [[Start Exam]] on the whiteboard.",
        ],
      },
    ],
    statusFlow: true,
    next: "use-the-whiteboard",
  },
  {
    slug: "use-the-whiteboard",
    title: "Use the whiteboard",
    summary: "See who's waiting, who's in an exam, and who's done, all in one place.",
    category: "front-desk",
    area: "whiteboard",
    audience: "Everyone",
    minutes: 3,
    keywords: ["patient flow", "board", "status board", "in progress", "treatment room", "tv"],
    steps: [
      {
        id: "open",
        title: "Open the whiteboard",
        body: [
          "Choose [[Whiteboard]] in the sidebar. It updates on its own, so it works well on a screen in the treatment area.",
          "**Waiting** ((1)) lists today's confirmed visits that haven't arrived yet. **In Progress** ((2)) shows pets who are checked in or in an exam. Checked-out visits move to **Completed** ((3)).",
          "Visits that are still **Scheduled**, not confirmed, don't show on the board.",
        ],
        shot: {
          id: "whiteboard",
          callouts: ["waiting", "in-progress", "completed"],
          alt: "The whiteboard with Waiting, In Progress, and Completed columns, each listing pets with their doctor and room",
        },
      },
      {
        id: "move",
        title: "Move each visit along",
        body: ["Click a card to move it along. Choose [[Check In]] when a confirmed pet arrives, and [[Start Exam]] when clinical work starts. Completing the visit's checkout moves it to **Completed**."],
      },
      {
        id: "current",
        title: "Keep the board current",
        body: ["Finish checkout instead of leaving done visits in progress. The board only helps when every handoff shows up right away."],
      },
    ],
    next: "send-appointment-reminders",
  },
  {
    slug: "send-appointment-reminders",
    title: "Send appointment reminders",
    summary: "Email or text the client before the visit to cut down on no-shows.",
    category: "front-desk",
    area: "schedule",
    audience: "Front desk, vets, admins",
    minutes: 4,
    keywords: ["remind", "reminder", "text", "sms", "email", "no-show", "notification"],
    steps: [
      {
        id: "contact",
        title: "Check the contact details and consent",
        body: ["Make sure the client's email or mobile number is right. Follow your clinic's policy, and any consent rules where you are, before you text."],
      },
      {
        id: "send",
        title: "Send it from the visit",
        body: [
          "Reminders go out for **Confirmed** visits only, so [[Send Reminder]] ((1)) shows up once the visit is confirmed. Click the visit on [[Schedule]] and choose it.",
          "It sends right away, with no preview, by the client's preferred contact method.",
        ],
        tip: "Technicians can't send reminders. Ask the front desk, a vet, or an admin.",
        shot: {
          id: "schedule-check-in",
          focus: "popover",
          pad: 8,
          callouts: ["reminder"],
          alt: "An appointment with the Send Reminder button highlighted",
        },
      },
      {
        id: "history",
        title: "Check that it was delivered",
        body: ["When it matters, look at the client's message history. Email needs a configured email provider. Texting needs to be switched on for your clinic and location."],
      },
    ],
    faq: [
      ["Why can't I text this client?", "Texting needs to be set up for your clinic and location, and the client needs to have agreed to receive texts. Email still works if it's configured."],
    ],
    next: "capture-visit-charges",
  },
  {
    slug: "see-the-schedule-in-your-calendar",
    title: "See the schedule in your own calendar",
    summary: "Subscribe once and the clinic's visits show up in Google, Apple, or Outlook.",
    category: "front-desk",
    area: "schedule",
    audience: "Everyone (admins can replace the link)",
    minutes: 3,
    keywords: ["calendar", "google calendar", "apple calendar", "ical", "ics", "outlook", "subscribe", "sync", "phone", "feed"],
    steps: [
      {
        id: "link",
        title: "Get the clinic's calendar link",
        body: [
          "Open [[Schedule]] and choose [[Add to your calendar]]. The first time, choose [[Turn on the calendar link]].",
          "Choose [[Copy link]] ((1)) to copy the private link ((2)).",
        ],
        shot: {
          id: "schedule-calendar-feed",
          focus: "popover",
          pad: 16,
          callouts: ["copy", "link"],
          alt: "The Add to your calendar panel on the schedule with the private calendar link and a Copy link button",
        },
        important: "The link shows patient names and visit types. Share it with your team only, never with clients.",
      },
      {
        id: "google",
        title: "Add it to Google Calendar",
        body: ["On a computer, open Google Calendar. Next to **Other calendars**, choose the plus sign, then **From URL**. Paste the link and choose **Add calendar**."],
      },
      {
        id: "apple",
        title: "Or Apple Calendar or Outlook",
        body: [
          "**Apple Calendar** on a Mac: choose **File → New Calendar Subscription**, paste the link, and choose **Subscribe**.",
          "**Outlook**: in the calendar, choose **Add calendar → Subscribe from web**, paste the link, and give it a name.",
        ],
      },
      {
        id: "updates",
        title: "Let it update on its own",
        body: [
          "Book or change a visit in OpenVPM and your calendar picks it up. Calendar apps check on their own schedule, so a change can take a while to appear.",
          "The calendar shows the last week and the next 60 days. Cancelled visits and no-shows are left out.",
        ],
      },
    ],
    faq: [
      ["Someone who shouldn't have the link has it", "An admin can choose [[Get a new link]] in the same panel. The old link stops working for everyone, so the team will need to subscribe again with the new one."],
      ["Can I change visits from my calendar?", "No. The calendar is read-only. Make changes on the [[Schedule]] in OpenVPM."],
    ],
    next: "check-in-a-patient",
  },
];
