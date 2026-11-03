import type { Locator, Page } from "@playwright/test";

/**
 * Every screenshot the guides use. Each shot opens a screen in the seeded
 * demo clinic, gets it into the right state, and names the parts the guides
 * point at. The capture run records where each named part sits, so callouts
 * follow the real interface instead of hand-placed coordinates.
 */

export interface Target {
  /** Find the element. */
  find: (page: Page) => Locator;
  /** Measure the closest ancestor matching this selector instead (a card, a row). */
  closest?: string;
}

export interface ShotDefinition {
  id: string;
  path: string;
  /** Put the screen into the state the guide describes. */
  prepare?: (page: Page) => Promise<void>;
  /** Scroll this target into view before capturing. */
  scrollTo?: string;
  targets: Record<string, Target>;
}

const role =
  (r: Parameters<Page["getByRole"]>[0], name: string | RegExp, exact = true) =>
  (page: Page) =>
    page.getByRole(r, { name, exact: typeof name === "string" ? exact : undefined }).first();
const text = (value: string | RegExp) => (page: Page) => page.getByText(value).first();
const css = (selector: string) => (page: Page) => page.locator(selector).first();
const nav = (label: string): Target => ({ find: (page) => page.locator("aside, nav").getByRole("link", { name: label, exact: true }).first() });
const card = (heading: string | RegExp): Target => ({
  find: (page) => page.getByRole("heading", { name: heading }).first(),
  closest: "section, [class*='rounded-xl'], [class*='rounded-lg']",
});

async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(600);
}

/** Open a patient chart by name from the patient list. */
async function openPatient(page: Page, name: string) {
  const href = await page.getByRole("link", { name, exact: true }).first().getAttribute("href");
  if (!href) throw new Error(`No patient link for ${name}`);
  await page.goto(href);
  await settle(page);
}

/** Open the first appointment on today's schedule whose popover offers this action. */
async function openAppointmentWith(page: Page, action: string) {
  const blocks = page.locator("main button").filter({ hasNotText: /^(Today|Day|Week|Month|New Appointment|Add to your calendar)$/ });
  const count = await blocks.count();
  for (let i = 0; i < count; i++) {
    const block = blocks.nth(i);
    const label = ((await block.getAttribute("aria-label")) ?? (await block.innerText())).trim();
    if (!label || /date range/i.test(label)) continue;
    if (!(await block.click({ timeout: 3_000 }).then(() => true, () => false))) continue;
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 3_000 }).catch(() => {});
    if (await dialog.getByRole("button", { name: action, exact: true }).count()) return;
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {});
  }
  throw new Error(`No appointment today offers "${action}"`);
}

/** Open the first appointment today whose details start with this status. */
async function openAppointmentWhere(page: Page, status: RegExp) {
  const blocks = page.locator("main button");
  const count = await blocks.count();
  for (let i = 0; i < count; i++) {
    const block = blocks.nth(i);
    const label = ((await block.getAttribute("aria-label")) ?? (await block.innerText())).trim();
    if (!label || /^(Today|Day|Week|Month|New Appointment|Add to your calendar)$/.test(label) || /date range/i.test(label)) continue;
    if (!(await block.click({ timeout: 3_000 }).then(() => true, () => false))) continue;
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 3_000 }).catch(() => {});
    if (status.test(await dialog.innerText().catch(() => ""))) return;
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {});
  }
  throw new Error(`No appointment today matches ${status}`);
}

async function openVisit(page: Page, action = "In Exam") {
  await openAppointmentWith(page, action);
  const href = await page.getByRole("link", { name: "Open visit" }).getAttribute("href");
  if (!href) throw new Error("No visit link");
  await page.goto(href);
  await settle(page);
}

async function expandInvoice(page: Page, status: string) {
  await page.locator("tbody tr").filter({ hasText: status }).first().locator("td").first().click();
  await page.waitForTimeout(800);
}

async function openSettings(page: Page, section: string) {
  await page.locator("main").getByRole("button", { name: section, exact: true }).first().click();
  await settle(page);
}

export const shots: ShotDefinition[] = [
  {
    id: "dashboard",
    path: "/",
    targets: {
      "nav-dashboard": nav("Dashboard"),
      stats: { find: text("Today's Appointments"), closest: "div.grid" },
      followups: card("Follow-up work queue"),
      upcoming: card("Upcoming Appointments"),
      search: { find: css("header input, header button:has-text('Search')") },
      new: { find: (page) => page.locator("header").getByRole("button", { name: "New" }).first() },
    },
  },
  {
    id: "search",
    path: "/",
    prepare: async (page) => {
      await page.keyboard.press("ControlOrMeta+k");
      await page.waitForTimeout(300);
      await page.keyboard.type("Max", { delay: 60 });
      await page.waitForTimeout(1200);
    },
    targets: {
      palette: { find: css("[role=dialog]") },
    },
  },
  {
    id: "schedule",
    path: "/schedule",
    targets: {
      "nav-schedule": nav("Schedule"),
      "date-nav": { find: role("button", "Today"), closest: "div.flex" },
      views: { find: role("button", "Week"), closest: "div" },
      "doctor-filter": { find: (page) => page.locator("main").getByRole("combobox").first() },
      "new-appointment": { find: (page) => page.locator("main").getByRole("button", { name: "New Appointment" }).first() },
      "calendar-feed": { find: role("button", "Add to your calendar") },
      lane: { find: text(/^Dr\. Emily Walsh$/), closest: "div" },
    },
  },
  {
    id: "schedule-new",
    path: "/schedule",
    prepare: async (page) => {
      await page.locator("main").getByRole("button", { name: "New Appointment" }).first().click();
      await page.waitForTimeout(500);
    },
    targets: {
      dialog: { find: (page) => page.getByRole("heading", { name: "New Appointment" }), closest: "div[class*='rounded']" },
      patient: { find: (page) => page.getByPlaceholder("Search patients or owners...") },
      type: { find: (page) => page.getByText("Appointment Type", { exact: true }), closest: "div" },
      doctor: { find: (page) => page.getByText("Doctor", { exact: true }), closest: "div" },
    },
  },
  {
    id: "schedule-confirm",
    path: "/schedule",
    prepare: (page) => openAppointmentWith(page, "Confirm"),
    targets: {
      popover: { find: css("[role=dialog]") },
      confirm: { find: (page) => page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }) },
      edit: { find: (page) => page.getByRole("dialog").getByRole("button", { name: "Edit appointment" }) },
      cancel: { find: (page) => page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }) },
      "no-show": { find: (page) => page.getByRole("dialog").getByRole("button", { name: "No Show", exact: true }) },
    },
  },
  {
    id: "schedule-check-in",
    path: "/schedule",
    prepare: (page) => openAppointmentWith(page, "Check In"),
    targets: {
      popover: { find: css("[role=dialog]") },
      "check-in": { find: (page) => page.getByRole("dialog").getByRole("button", { name: "Check In", exact: true }) },
      reminder: { find: (page) => page.getByRole("dialog").getByRole("button", { name: /send reminder/i }) },
    },
  },
  {
    id: "schedule-in-exam",
    path: "/schedule",
    prepare: (page) => openAppointmentWith(page, "In Exam"),
    targets: {
      popover: { find: css("[role=dialog]") },
      "open-visit": { find: (page) => page.getByRole("dialog").getByRole("link", { name: "Open visit" }) },
      "view-chart": { find: (page) => page.getByRole("dialog").getByRole("link", { name: "View chart" }) },
      "in-exam": { find: (page) => page.getByRole("dialog").getByRole("button", { name: "In Exam", exact: true }) },
      "no-show": { find: (page) => page.getByRole("dialog").getByRole("button", { name: "No Show", exact: true }) },
    },
  },
  {
    id: "whiteboard",
    path: "/whiteboard",
    targets: {
      "nav-whiteboard": nav("Whiteboard"),
      live: { find: text(/^Live$/) },
      waiting: { find: text(/^Waiting$/), closest: "div[class*='rounded']" },
      "in-progress": { find: text(/^In Progress$/), closest: "div[class*='rounded']" },
      completed: { find: text(/^Completed$/), closest: "div[class*='rounded']" },
    },
  },
  {
    id: "visit",
    path: "/schedule",
    prepare: openVisit,
    targets: {
      header: { find: role("button", /Start exam|Finish exam|Check out/), closest: "div[class*='rounded']" },
      "start-exam": { find: role("button", /Start exam/) },
      checklist: { find: text("FINISH THIS VISIT"), closest: "div[class*='rounded']" },
    },
  },
  {
    id: "visit-work",
    path: "/schedule",
    prepare: openVisit,
    scrollTo: "clinical-work",
    targets: {
      "clinical-work": card("Clinical work"),
      "charge-capture": card("Charge capture"),
    },
  },
  {
    id: "visit-exam",
    path: "/schedule",
    prepare: async (page) => {
      // A pet already in the exam: its popover links to the closeout instead.
      await openAppointmentWhere(page, /^\s*In Exam/);
      const href = await page.getByRole("link", { name: "Review closeout" }).getAttribute("href");
      await page.goto(href!.split("#")[0]!);
      await settle(page);
    },
    scrollTo: "charge-capture",
    targets: {
      "charge-capture": card("Charge capture"),
      "clinical-work": card("Clinical work"),
    },
  },
  {
    id: "patients",
    path: "/patients",
    targets: {
      "nav-patients": nav("Patients"),
      search: { find: (page) => page.getByPlaceholder(/Search patients/) },
      species: { find: (page) => page.locator("main").getByRole("combobox").first() },
      "new-patient": { find: role("button", "New Patient") },
      duplicates: { find: role("button", "Review duplicates") },
      list: { find: css("main table") },
    },
  },
  {
    id: "patient",
    path: "/patients",
    prepare: (page) => openPatient(page, "Max"),
    targets: {
      header: { find: role("button", "Download Summary"), closest: "div[class*='rounded']" },
      allergies: { find: text(/^Allergies$/), closest: "div[class*='rounded']" },
      actions: { find: role("button", "Capture photos"), closest: "div.flex" },
      tabs: { find: css("[role=tablist]") },
      owner: { find: role("button", "James Patterson") },
    },
  },
  ...(["Medical Records", "Vitals", "Vaccinations", "Weight History", "Documents"] as const).map(
    (tab): ShotDefinition => ({
      id: `patient-${tab.toLowerCase().replace(/\s+/g, "-")}`,
      path: "/patients",
      prepare: async (page) => {
        await openPatient(page, "Max");
        await page.getByRole("tab", { name: tab }).click();
        await page.waitForTimeout(700);
        await page.getByRole("tab", { name: tab }).scrollIntoViewIfNeeded();
        await page.mouse.wheel(0, 260);
        await page.waitForTimeout(400);
      },
      targets: {
        tab: { find: (page) => page.getByRole("tab", { name: tab }) },
        panel: { find: css("[role=tabpanel]") },
      },
    }),
  ),
  {
    id: "clients",
    path: "/clients",
    targets: {
      "nav-clients": nav("Clients"),
      search: { find: (page) => page.getByPlaceholder(/Search clients/) },
      "new-client": { find: role("button", "New Client") },
      list: { find: css("main table") },
    },
  },
  {
    id: "client",
    path: "/clients",
    prepare: async (page) => {
      await page.locator("tbody tr").first().click();
      await settle(page);
    },
    targets: {
      portal: card("Client Portal"),
      "create-link": { find: role("button", "Create Link") },
      log: card("Communication Log"),
      pets: card(/^Patients \(/),
    },
  },
  {
    id: "records",
    path: "/records",
    targets: {
      "nav-records": nav("Records"),
      search: { find: (page) => page.getByPlaceholder(/Search for a patient|Search patients/) },
    },
  },
  {
    id: "lab-inbox",
    path: "/lab-results",
    targets: {
      "nav-lab": nav("Lab Inbox"),
      filters: { find: role("button", "Action required"), closest: "div.flex" },
      result: { find: role("button", "Mark reviewed"), closest: "div[class*='rounded-xl'], div[class*='rounded-lg']" },
      "mark-reviewed": { find: role("button", "Mark reviewed") },
      "assign-follow-up": { find: role("button", "Assign follow-up") },
    },
  },
  {
    id: "billing",
    path: "/billing",
    targets: {
      "nav-billing": nav("Billing"),
      dispenses: card("Unbilled medication dispenses"),
      stats: { find: text(/^Outstanding$/), closest: "div.grid" },
      tabs: { find: role("button", "Draft"), closest: "div" },
      list: { find: css("main table") },
      "new-invoice": { find: (page) => page.locator("main").getByRole("link", { name: "New Invoice" }) },
    },
  },
  {
    id: "invoice-sent",
    path: "/billing",
    prepare: (page) => expandInvoice(page, "Sent"),
    scrollTo: "payments",
    targets: {
      payments: { find: role("button", "Record Payment"), closest: "div[class*='rounded'], section" },
      "record-payment": { find: role("button", "Record Payment") },
      "take-card": { find: role("button", "Take Card") },
      adjust: { find: role("button", "Credit / Write Off") },
      email: { find: role("button", "Email Invoice") },
    },
  },
  {
    id: "invoice-draft",
    path: "/billing",
    prepare: (page) => expandInvoice(page, "Draft"),
    targets: {
      row: { find: (page) => page.locator("tbody tr").filter({ hasText: "Draft" }).first() },
    },
  },
  {
    id: "inventory",
    path: "/inventory",
    targets: {
      "nav-inventory": nav("Inventory"),
      tabs: { find: (page) => page.locator("main").getByText("Suppliers", { exact: true }).first(), closest: "div" },
      stats: { find: text(/^Needs attention$/), closest: "div.grid" },
      search: { find: (page) => page.getByPlaceholder(/Search by name or SKU/) },
      "add-product": { find: role("button", "Add Product") },
      list: { find: css("main table") },
    },
  },
  {
    id: "inbox",
    path: "/inbox",
    prepare: async (page) => {
      await page.getByText("Richard Nguyen").first().click();
      await page.waitForTimeout(800);
    },
    targets: {
      "nav-inbox": { find: (page) => page.locator("aside, nav").getByRole("link", { name: /^Inbox/ }).first() },
      filters: { find: role("button", "Unread"), closest: "div" },
      list: { find: text("Richard Nguyen"), closest: "ul, div[class*='overflow']" },
      "new-message": { find: role("button", "New Message") },
    },
  },
  {
    id: "recalls",
    path: "/recalls",
    targets: {
      "nav-recalls": nav("Recalls"),
      stats: { find: text(/^Overdue patients$/), closest: "div.grid" },
      preview: card("Recipient preview"),
    },
  },
  {
    id: "care-reminders",
    path: "/care-reminders",
    targets: {
      "nav-reminders": nav("Care Reminders"),
      stats: { find: text(/^Due or overdue$/), closest: "div.grid" },
      queue: card("Patient follow-up queue"),
      add: { find: role("button", "Add reminder") },
    },
  },
  {
    id: "controlled-substances",
    path: "/controlled-substances",
    targets: {
      "nav-controlled": nav("Controlled Substances"),
      "log-entry": { find: role("button", "Log Entry") },
      balances: { find: text("Drug Balance Summary"), closest: "button, div[class*='rounded']" },
      log: { find: css("main table") },
    },
  },
  {
    id: "reports",
    path: "/reports",
    targets: {
      "nav-reports": nav("Reports"),
      range: { find: role("button", "Last 30 Days"), closest: "div[class*='rounded'], div.flex" },
      tabs: { find: role("button", "Appointments"), closest: "div" },
      export: { find: role("button", "Export CSV"), closest: "div.flex" },
    },
  },
  {
    id: "agent",
    path: "/agent",
    targets: {
      "nav-agent": nav("Agent"),
      prompts: { find: text("What can I help you with?"), closest: "div" },
      composer: { find: css("main textarea") },
    },
  },
  {
    id: "imported-history",
    path: "/migration-archive",
    targets: {
      "nav-imported": nav("Imported History"),
    },
  },
  {
    id: "settings",
    path: "/settings",
    targets: {
      "nav-settings": nav("Settings"),
      sections: { find: (page) => page.locator("main").getByRole("button", { name: "Practice Info" }), closest: "nav, aside, div[class*='rounded']" },
      practice: card("Practice details"),
    },
  },
  ...(
    [
      ["settings-staff", "Staff"],
      ["settings-services", "Services & Pricing"],
      ["settings-appointment-types", "Appointment Types"],
      ["settings-data", "Data"],
      ["settings-plan", "Plan & Billing"],
    ] as const
  ).map(
    ([id, section]): ShotDefinition => ({
      id,
      path: "/settings",
      prepare: (page) => openSettings(page, section),
      targets: {
        section: { find: (page) => page.locator("main").getByRole("button", { name: section, exact: true }) },
      },
    }),
  ),
];
