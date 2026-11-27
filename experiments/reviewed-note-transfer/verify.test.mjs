import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";

const url = "http://127.0.0.1:41763/openvpm-transfer-fixture.html";
const extension = fileURLToPath(new URL("extension", import.meta.url));

// Serve only known synthetic assets, including an alias to test URL scoping.
async function fixtureServer(port) {
  const assets = new Map();
  for (const [name, type] of [
    ["openvpm-transfer-fixture.html", "text/html"],
    ["fixture.css", "text/css"],
    ["fixture.js", "text/javascript"],
  ]) {
    const body = await readFile(new URL(`fixture/${name}`, import.meta.url));
    assets.set(`/${name}`, { body, type });
  }
  assets.set("/other.html", assets.get("/openvpm-transfer-fixture.html"));
  const server = createServer((req, res) => {
    const asset = assets.get(req.url);
    if (!asset) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": asset.type });
    res.end(asset.body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

test("review a synthetic note and transfer only to a matching, empty draft", async (t) => {
  const server = await fixtureServer(41763);
  t.after(() => server.close());
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(url);
  await expect(page).toHaveTitle("OpenVPM · Note transfer lab");
  const preview = page.getByRole("button", { name: "Preview transfer" });
  const apply = page.getByRole("button", { name: "Apply to draft fields" });
  const status = page.getByRole("status");
  const visit = page.getByLabel("Open visit");
  const values = () => page.locator("textarea").evaluateAll((fields) => fields.map((field) => field.value));
  const empty = ["", "", "", ""];
  await expect(preview).toBeVisible();
  await expect(apply).toBeHidden();
  await preview.click();
  await expect(page.getByText("Routine follow-up visit.", { exact: true })).toBeVisible();
  assert.deepEqual(await values(), empty);
  await apply.click();
  assert.deepEqual(await values(), [
    "Owner reports Juniper has been eating normally.",
    "Weight recorded at this visit: 4.2 kg.",
    "Routine follow-up visit.",
    "Owner will keep the scheduled follow-up appointment.",
  ]);
  await expect(apply).toBeHidden();
  await preview.click();
  await expect(status).toContainText("already contains text");

  await page.reload();
  assert.deepEqual(await values(), empty);
  // A different patient with the same name, and an older visit for this patient.
  for (const index of [1, 2]) {
    await preview.click();
    await visit.selectOption({ index });
    await apply.click();
    await expect(status).toContainText("different patient or visit");
    await expect(apply).toBeHidden();
    assert.deepEqual(await values(), empty);
    await preview.click();
    await expect(apply).toBeHidden();
    await visit.selectOption({ index: 0 });
  }

  await preview.click();
  await visit.selectOption({ index: 1 });
  await visit.selectOption({ index: 0 });
  await apply.click();
  await expect(status).toContainText("chart changed after preview");
  assert.deepEqual(await values(), empty);

  await preview.click();
  await page.getByLabel("Plan", { exact: true }).fill("Staff has already started this plan.");
  await apply.click();
  await expect(status).toContainText("Plan already contains text");
  assert.deepEqual(await values(), ["", "", "", "Staff has already started this plan."]);

  await page.reload();
  await preview.click();
  await page.getByLabel("Assessment", { exact: true }).evaluate((field) => { field.readOnly = true; });
  await apply.click();
  await expect(status).toContainText("Assessment destination");
  assert.deepEqual(await values(), empty);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await preview.click();
  await expect(apply).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.TRANSFER_LAB_SCREENSHOT) {
    await page.screenshot({ path: process.env.TRANSFER_LAB_SCREENSHOT, fullPage: true });
  }

  const otherServer = await fixtureServer(0);
  t.after(() => otherServer.close());
  for (const outside of [
    url.replace("41763", String(otherServer.address().port)),
    url.replace("openvpm-transfer-fixture.html", "other.html"),
  ]) {
    await page.goto(outside);
    await expect(page.getByText("Load the unpacked extension", { exact: false })).toBeVisible();
    await expect(preview).toHaveCount(0);
  }
  assert.deepEqual(errors, []);
});
