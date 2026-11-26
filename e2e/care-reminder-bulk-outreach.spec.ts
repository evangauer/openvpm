import { createRequire } from "node:module";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";

const require = createRequire(path.resolve("apps/web/package.json"));
const { encode } = require("next-auth/jwt") as {
  encode: (params: {
    token: Record<string, unknown>;
    secret: string;
  }) => Promise<string>;
};
const superjsonModule = require("superjson") as {
  serialize?: (value: unknown) => unknown;
  default?: { serialize: (value: unknown) => unknown };
};
const serialize =
  superjsonModule.serialize ??
  superjsonModule.default?.serialize ??
  ((value: unknown) => ({ json: value }));

const secret =
  process.env.NEXTAUTH_SECRET ??
  "playwright-care-reminder-bulk-outreach-secret";
const practiceId = "00000000-0000-4000-8000-0000000000aa";
const userId = "00000000-0000-4000-8000-000000000001";
const eligibleId = "00000000-0000-4000-8000-0000000000c1";
const blockedId = "00000000-0000-4000-8000-0000000000c2";

test.skip(
  process.env.CARE_REMINDER_BULK_E2E !== "1",
  "Set CARE_REMINDER_BULK_E2E=1 to drive the care-reminder bulk outreach screen",
);

function trpcData(data: unknown) {
  return { result: { data: serialize(data) } };
}

function procedureNames(url: string): string[] {
  const path = new URL(url).pathname.replace(/^\/api\/trpc\//, "");
  return decodeURIComponent(path)
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

const preview = {
  generatedAt: new Date("2026-11-19T15:00:00.000Z"),
  today: "2026-11-19",
  maxBatch: 200,
  batchesPerHour: 4,
  truncated: false,
  total: 2,
  eligible: 1,
  blocked: 1,
  alreadySent: 0,
  recipients: [
    {
      reminderId: eligibleId,
      patientId: "00000000-0000-4000-8000-0000000000d1",
      patientName: "River",
      species: "canine",
      clientName: "Ada Lovelace",
      title: "Dental recheck",
      dueDate: "2026-01-01",
      imported: false,
      lastContactedAt: null,
      status: "eligible",
      channel: "email",
      blockReason: null,
      blockMessage: null,
    },
    {
      reminderId: blockedId,
      patientId: "00000000-0000-4000-8000-0000000000d2",
      patientName: "Moss",
      species: "feline",
      clientName: "Grace Hopper",
      title: "Heartworm",
      dueDate: "2026-01-02",
      imported: true,
      lastContactedAt: null,
      status: "blocked",
      channel: null,
      blockReason: "missing_sms_consent",
      blockMessage:
        "This client has not agreed to texts. Imported reminders do not add consent.",
    },
  ],
};

function payloadFor(procedure: string): unknown {
  switch (procedure) {
    case "careReminders.list":
      return {
        today: "2026-11-19",
        counts: { open: 2, overdue: 2, upcoming: 0, completed: 0, dismissed: 0 },
        items: [],
      };
    case "careReminders.previewBulkOutreach":
      return preview;
    case "careReminders.sendBulkOutreach":
      return { sent: 1, failed: 0, blocked: 1, deduped: 0 };
    case "communications.listConversations":
      return { total: 0, items: [] };
    case "migrationArchive.reviewStatus":
      return { recoveryHold: false };
    case "settings.welcomeContext":
      return {
        portalClient: null,
        demoPatientName: null,
        practiceName: "River Clinic",
      };
    case "agent.status":
      return { configured: false, canUseAi: false };
    case "auth.me":
      return { emailVerifiedAt: "2026-01-01T00:00:00.000Z" };
    case "settings.getBranding":
      return { practiceName: "River Clinic", brandColor: "#0f766e" };
    default:
      return {};
  }
}

async function fulfillTrpc(route: Route, sends: string[]) {
  const request = route.request();
  const procedures = procedureNames(request.url());
  if (request.method() === "POST") {
    const body = request.postData() ?? "";
    if (procedures.some((name) => name.includes("sendBulkOutreach"))) {
      sends.push(body);
    }
  }
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(procedures.map((procedure) => trpcData(payloadFor(procedure)))),
  });
}

async function openCareReminders(page: Page) {
  const token = await encode({
    token: {
      sub: userId,
      id: userId,
      email: "front.desk@river-clinic.com",
      name: "Front Desk",
      role: "front_desk",
      practiceId,
      sessionVersion: 1,
    },
    secret,
  });
  await page.context().addCookies([
    {
      name: "next-auth.session-token",
      value: token,
      url: "http://127.0.0.1:3107",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.addInitScript(() => {
    sessionStorage.setItem("ovpm_verify_email_dismissed", "1");
  });
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: {
          id: userId,
          email: "front.desk@river-clinic.com",
          name: "Front Desk",
          role: "front_desk",
          practiceId,
        },
        expires: "2099-01-01T00:00:00.000Z",
      }),
    }),
  );
  await page.route("**/api/auth/**", (route) => {
    if (route.request().url().includes("/api/auth/session")) {
      return route.fallback();
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    });
  });
}

test("staff preview block reasons, select every match, and confirm before send", async ({
  page,
}) => {
  const sends: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await openCareReminders(page);
  await page.route("**/api/trpc/**", (route) => fulfillTrpc(route, sends));

  await page.goto("/care-reminders");
  await expect(page.getByRole("heading", { name: "Care reminders" })).toBeVisible();
  await page.getByRole("button", { name: "Preview matching" }).click();
  await expect(page.getByTestId("bulk-preview")).toBeVisible();
  await expect(page.getByTestId("bulk-block-reason")).toContainText(
    "Imported reminders do not add consent",
  );

  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    if (dialogs.length === 1) await dialog.dismiss();
    else await dialog.accept();
  });

  await page.getByTestId("bulk-select-all").click();
  await page.getByTestId("bulk-send").click();
  expect(sends).toHaveLength(0);
  await expect(page.getByTestId("bulk-send")).toContainText("Send all matching (1)");

  await page.getByTestId("bulk-send").click();
  await expect.poll(() => sends.length).toBe(1);
  expect(sends[0]).toContain('"selectAllMatching":true');
  expect(sends[0]).not.toContain('"content"');
  expect(dialogs[0]).toMatch(/checked again before anything is delivered/i);
  expect(dialogs[1]).toMatch(/first 1 eligible reminder/i);
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});
