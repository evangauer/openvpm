import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const page = readFileSync(
  fileURLToPath(
    new URL("../../app/email-preferences/page.tsx", import.meta.url),
  ),
  "utf8",
);
const form = readFileSync(
  fileURLToPath(
    new URL("../../app/email-preferences/preference-form.tsx", import.meta.url),
  ),
  "utf8",
);

describe("email preferences UI", () => {
  it("clearly separates optional mail from transactional and clinic mail", () => {
    expect(page).toContain("product, trial, research, and feedback emails");
    expect(page).toMatch(
      /security alerts,[\s\S]+billing[\s\S]+service notices/,
    );
    expect(page).toMatch(/does not affect messages your[\s\S]+clinic sends/);
  });

  it("requires an intentional POST and exposes accessible result states", () => {
    expect(form).toContain('method: "POST"');
    expect(form).toContain("application/x-www-form-urlencoded");
    expect(form).toContain("List-Unsubscribe=One-Click");
    expect(form).toContain('role="status"');
    expect(form).toContain('role="alert"');
    expect(form).toContain("Immediate, no sign-in required.");
  });
});
