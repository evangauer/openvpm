import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("action confirmation dialog", () => {
  const source = readFileSync(
    "components/common/action-confirmation-dialog.tsx",
    "utf8",
  );

  it("exposes modal semantics and keeps keyboard focus inside", () => {
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain("aria-labelledby={titleId}");
    expect(source).toContain("aria-describedby={descriptionId}");
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain('event.key !== "Tab"');
    expect(source).toContain("event.preventDefault()");
    expect(source).toContain("previousFocus?.focus()");
  });

  it("blocks invalid reasons and prevents background interaction", () => {
    expect(source).toContain('document.body.style.overflow = "hidden"');
    expect(source).toContain("reason.minLength");
    expect(source).toContain("reason.maxLength");
    expect(source).toContain("disabled={isPending || !reasonIsValid}");
    expect(source).toContain("createPortal(");
  });
});
