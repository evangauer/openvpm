import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source-level UI-state assertions for the searchable service picker
 * (charge capture), mirroring consult-companion-ui.test.ts.
 */

describe("service picker UI states", () => {
  const picker = readFileSync("components/billing/service-picker.tsx", "utf8");
  const newInvoicePage = readFileSync(
    "app/(dashboard)/billing/new/page.tsx",
    "utf8"
  );

  it("replaces the plain select on the new-invoice page", () => {
    expect(newInvoicePage).toContain(
      'import { ServicePicker } from "@/components/billing/service-picker"'
    );
    expect(newInvoicePage).toContain("<ServicePicker");
    expect(newInvoicePage).not.toContain("Select a service...");
  });

  it("ranks prefix matches first and searches codes and categories too", () => {
    expect(picker).toContain("name.startsWith(q)");
    expect(picker).toContain("code.startsWith(q)");
    expect(picker).toContain("code.includes(q)");
    expect(picker).toContain("category.includes(q)");
    expect(picker).toMatch(/\[\.\.\.starts, \.\.\.contains\]/);
  });

  it("supports a full keyboard flow", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Enter", "Escape"]) {
      expect(picker).toContain(`"${key}"`);
    }
    expect(picker).toContain('role="listbox"');
    expect(picker).toContain('role="option"');
  });

  it("shows codes, categories, and prices on result rows", () => {
    expect(picker).toContain("service.code");
    expect(picker).toContain("service.category");
    expect(picker).toContain("${service.defaultPrice}");
    expect(picker).toContain("tabular-nums");
  });

  it("keeps picker copy free of em dashes", () => {
    expect(picker).not.toContain("—");
  });
});
