import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { shots, type ShotDefinition } from "./shots";

const OUT = path.resolve(__dirname, "../public/screens");
const EMAIL = process.env.DOCS_CAPTURE_EMAIL ?? "admin@neighborhoodvet.example.com";
const PASSWORD = process.env.DOCS_CAPTURE_PASSWORD ?? "password123";
const only = process.env.DOCS_CAPTURE_ONLY?.split(",");

type Box = [number, number, number, number];
const manifest: Record<string, { file: string; width: number; height: number; targets: Record<string, Box> }> = {};
const failures: string[] = [];

test.describe.configure({ mode: "serial" });

async function signIn(page: Page) {
  await page.goto("/login");
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 }),
    page.getByRole("button", { name: /sign in/i }).click(),
  ]);
  await page.waitForLoadState("networkidle");
  // Product screens only: no first-run checklist or verification banners.
  const dismiss = page.getByRole("button", { name: /don.t show this again/i });
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
  await page.evaluate(() => sessionStorage.setItem("ovpm_verify_email_dismissed", "1"));
}

async function measure(page: Page, shot: ShotDefinition) {
  const boxes: Record<string, Box> = {};
  for (const [name, target] of Object.entries(shot.targets)) {
    const locator = target.find(page);
    const box = await locator
      .evaluate((el, closest) => {
        const node = (closest ? el.parentElement?.closest(closest) : el) ?? el;
        const r = node.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height].map((n) => Math.round(n));
      }, target.closest ?? null, { timeout: 5_000 })
      .catch(() => null);
    if (!box || box[2] === 0 || box[3] === 0) failures.push(`${shot.id}: target "${name}" not found`);
    else boxes[name] = box as Box;
  }
  return boxes;
}

test("capture guide screenshots", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await signIn(page);

  for (const shot of shots) {
    if (only && !only.includes(shot.id)) continue;
    await test.step(shot.id, async () => {
      try {
        await page.goto(shot.path);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(500);
        await shot.prepare?.(page);
        if (shot.scrollTo) {
          const target = shot.targets[shot.scrollTo]!;
          await target.find(page).evaluate((el, closest) => {
            const node = (closest ? el.parentElement?.closest(closest) : el) ?? el;
            node.scrollIntoView({ block: "start" });
            // Leave a little room above the section.
            const scroller = node.closest("main") ?? document.scrollingElement;
            scroller?.scrollBy?.(0, -24);
          }, target.closest ?? null);
          await page.waitForTimeout(400);
        }
        // Let hover states and toasts clear.
        await page.mouse.move(0, 799);
        await page.waitForTimeout(400);
        const file = `${shot.id}.jpg`;
        await page.screenshot({ path: path.join(OUT, file), type: "jpeg", quality: 80 });
        manifest[shot.id] = { file, width: 1280, height: 800, targets: await measure(page, shot) };
      } catch (error) {
        failures.push(`${shot.id}: ${(error as Error).message.split("\n")[0]}`);
      }
    });
  }

  const manifestPath = path.join(OUT, "manifest.json");
  // A partial run (DOCS_CAPTURE_ONLY) updates its shots and keeps the rest.
  const previous = only && existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
  writeFileSync(manifestPath, JSON.stringify({ ...previous, ...manifest }, null, 2) + "\n");
  expect(failures, failures.join("\n")).toEqual([]);
});
