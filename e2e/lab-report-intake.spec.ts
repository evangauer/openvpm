import { test, expect, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";

/** Opt-in drill against a disposable local clinic; never a production account. */
const email = process.env.LAB_REPORT_DRILL_EMAIL ?? "";
const password = process.env.LAB_REPORT_DRILL_PASSWORD ?? "";
const patientId = process.env.LAB_REPORT_DRILL_PATIENT ?? "";
const patientName = process.env.LAB_REPORT_DRILL_PATIENT_NAME ?? "Scout";
const ownerName = process.env.LAB_REPORT_DRILL_OWNER_NAME ?? "Casey";

async function moreActions(page: Page) {
  const details = page
    .locator("details")
    .filter({ hasText: "More actions & history" });
  if (!(await details.evaluate((element) => element.hasAttribute("open")))) {
    await details.locator("summary").click();
  }
}

async function matchPatient(page: Page) {
  await page.getByLabel("Find patient or owner").fill(ownerName);
  await page
    .getByRole("button", { name: new RegExp(`^${patientName} ·`) })
    .click();
  await expect(
    page.getByRole("button", { name: "Confirm patient match", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", {
      name: "I checked the patient and owner against the original report.",
    })
    .check();
  await page
    .getByRole("button", { name: "Confirm patient match", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Review report", exact: true }),
  ).toBeVisible();
}

test("lab PDF intake keeps queue, patient, and revision context through the full workflow", async ({
  page,
  context,
  browser,
  baseURL,
}, testInfo) => {
  test.skip(
    !email || !password || !patientId,
    "Set LAB_REPORT_DRILL_* for a disposable local clinic",
  );
  test.setTimeout(180_000);
  expect(["localhost", "127.0.0.1"]).toContain(new URL(baseURL!).hostname);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await page.getByRole("link", { name: "Lab Inbox", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Lab workspace" })
    .getByRole("link", { name: "Report PDFs" })
    .click();
  await expect(
    page.getByRole("link", { name: "Lab Inbox", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: "Needs review", exact: true }).click();
  await page.waitForURL(
    (url) => url.searchParams.get("filter") === "unreviewed",
  );
  await page.reload();
  await expect(
    page.getByRole("link", { name: "Needs review", exact: true }),
  ).toHaveAttribute("aria-current", "page");

  const runId = randomUUID();
  const fileName = `clinic-report-${runId}.pdf`;
  const pdfPage = await context.newPage();
  await pdfPage.setContent(`<h1>Fictional lab report</h1><p>${runId}</p>`);
  const pdf = await pdfPage.pdf();
  await pdfPage.setContent(`<h1>Fictional amended report</h1><p>${runId}</p>`);
  const revision = await pdfPage.pdf();
  await pdfPage.close();

  await page.getByRole("button", { name: "Upload PDF", exact: true }).click();
  await page.getByLabel("Report PDF (up to 4 MB)").setInputFiles({
    name: "oversize.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.alloc(4_000_001),
  });
  let uploads = 0;
  const countUpload = (request: { url: () => string }) => {
    if (request.url().endsWith("/api/upload")) uploads++;
  };
  page.on("request", countUpload);
  await page.getByRole("button", { name: "Upload PDF", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "4 MB or smaller" }),
  ).toBeVisible();
  expect(uploads).toBe(0);
  page.off("request", countUpload);
  await page.getByLabel("Report PDF (up to 4 MB)").setInputFiles({
    name: fileName,
    mimeType: "application/pdf",
    buffer: pdf,
  });
  await page.getByRole("button", { name: "Upload PDF", exact: true }).click();
  await expect(page.getByLabel("Find patient or owner")).toBeVisible();
  const originalId = new URL(page.url()).searchParams.get("reportId")!;
  expect(originalId).toBeTruthy();
  await expect(page.getByLabel("Report PDF (up to 4 MB)")).toHaveCount(0);
  await matchPatient(page);
  await page
    .getByRole("button", { name: "Review report", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm clinical review", exact: true })
    .click();
  await expect(page.getByText("Reviewed", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Patient chart", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "Medical Records", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(page.getByText("Reviewed", { exact: true })).toBeVisible();
  const fileUrl = await page
    .getByRole("link", { name: "Open original PDF" })
    .getAttribute("href");
  const download = await context.request.get(fileUrl!);
  expect(download.status()).toBe(200);
  const sha = (value: Buffer) =>
    createHash("sha256").update(value).digest("hex");
  expect(sha(await download.body())).toBe(sha(pdf));
  const anonymous = await browser.newContext();
  expect(
    (
      await anonymous.request.get(new URL(fileUrl!, baseURL).toString())
    ).status(),
  ).toBe(403);
  await anonymous.close();

  // A duplicate from another filter opens the existing receipt, not a misleading empty queue.
  await page
    .getByRole("link", { name: "Back to reports", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Needs review", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Upload PDF", exact: true }).click();
  await page.getByLabel("Report PDF (up to 4 MB)").setInputFiles({
    name: fileName,
    mimeType: "application/pdf",
    buffer: pdf,
  });
  await page.getByRole("button", { name: "Upload PDF", exact: true }).click();
  await expect(
    page.getByText(
      "This PDF is already in the inbox. No duplicate report was added.",
    ),
  ).toBeVisible();
  await expect(page.getByText("Reviewed", { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("reportId")).toBe(originalId);

  await page.goto(`/patients/${patientId}?tab=documents`);
  await page
    .getByRole("link", { name: "View lab reports", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: `${patientName}’s documents`, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Needs match", exact: true }),
  ).toHaveCount(0);
  await page
    .locator(`#report-${originalId}`)
    .getByRole("link", { name: "View report", exact: true })
    .click();
  await moreActions(page);
  await page
    .getByRole("button", { name: "Import revision", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Upload revised PDF", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Report PDF (up to 4 MB)")).toBeFocused();
  await page.getByLabel("Report PDF (up to 4 MB)").setInputFiles({
    name: `revision-${runId}.pdf`,
    mimeType: "application/pdf",
    buffer: revision,
  });
  await page.getByRole("button", { name: "Upload PDF", exact: true }).click();
  await expect(page.getByLabel("Find patient or owner")).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Previous version", exact: true }),
  ).toBeVisible();
  const revisionId = new URL(page.url()).searchParams.get("reportId")!;
  expect(revisionId).not.toBe(originalId);

  // Browser navigation cannot leave the next upload attached to an old revision target.
  await moreActions(page);
  await page
    .getByRole("button", { name: "Import revision", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Previous version", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Upload revised PDF", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Open revision", exact: true }).click();
  await matchPatient(page);
  await moreActions(page);
  await page
    .getByRole("button", { name: "Correct patient match", exact: true })
    .click();
  await page
    .getByLabel("Reason for correction")
    .fill("Patient identity rechecked in the original PDF");
  await page
    .getByRole("button", { name: "Clear patient match", exact: true })
    .click();
  await expect(page.getByLabel("Find patient or owner")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("reportId")).toBe(revisionId);
  await moreActions(page);
  await page
    .getByRole("button", { name: "Decision history", exact: true })
    .click();
  await expect(
    page.getByText(/Patient identity rechecked in the original PDF/),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Find patient or owner")).toBeVisible();

  await page.screenshot({
    path: testInfo.outputPath("desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await moreActions(page);
  await page
    .getByRole("button", { name: "Dismiss report", exact: true })
    .click();
  await page
    .getByLabel("Reason for dismissal")
    .fill("Training report, no clinical action");
  await page
    .getByRole("button", { name: "Dismiss report", exact: true })
    .last()
    .click();
  await expect(page.getByText("Dismissed", { exact: true })).toBeVisible();
  await moreActions(page);
  await page
    .getByRole("button", { name: "Reopen report", exact: true })
    .click();
  await page
    .getByLabel("Reason for reopening")
    .fill("Continue the training review");
  await page
    .getByRole("button", { name: "Reopen report", exact: true })
    .last()
    .click();
  await expect(page.getByLabel("Find patient or owner")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("link", { name: `${patientName}’s documents`, exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "View lab reports", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("tab", { name: "Documents", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Medical Records", exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get("tab") === "records");
  await page.goBack();
  await expect(
    page.getByRole("tab", { name: "Documents", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.goto(`/patients/${patientId}?tab=invalid`);
  await expect(
    page.getByRole("tab", { name: "Overview", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(errors).toEqual([]);
});
