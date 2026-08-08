import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const scheduleSource = readFileSync(
  "app/(dashboard)/schedule/page.tsx",
  "utf8",
);
const whiteboardSource = readFileSync(
  "app/(dashboard)/whiteboard/page.tsx",
  "utf8",
);

const overlaySources = [
  ["schedule", scheduleSource],
  ["whiteboard", whiteboardSource],
] as const;

describe("appointment detail overlay accessibility", () => {
  it.each(overlaySources)(
    "%s exposes a named modal dialog with an accessible close control",
    (_surface, source) => {
      expect(source).toContain('role="dialog"');
      expect(source).toContain('aria-modal="true"');
      expect(source).toContain("aria-labelledby={dialogTitleId}");
      expect(source).toContain("id={dialogTitleId}");
      expect(source).toContain('aria-label="Close appointment details"');
      expect(source).toContain("tabIndex={-1}");
    },
  );

  it.each(overlaySources)(
    "%s places, traps, and restores keyboard focus",
    (_surface, source) => {
      expect(source).toContain("DIALOG_FOCUSABLE_SELECTOR");
      expect(source).toContain("previouslyFocusedElement");
      expect(source).toContain("document.activeElement");
      expect(source).toContain('e.key !== "Tab"');
      expect(source).toContain("lastElement.focus()");
      expect(source).toContain("firstElement.focus()");
      expect(source).toContain("previouslyFocusedElement.focus()");
      expect(source).toContain("onCloseRef.current()");
    },
  );

  it.each(overlaySources)(
    "%s sends in-exam users directly to the focused closeout region",
    (_surface, source) => {
      expect(source).toContain(
        "`/encounters/${appointment.id}#visit-closeout`",
      );
      expect(source).toContain('focusElementAfterNavigation("visit-closeout")');
      expect(source).toContain("target.focus({ preventScroll: true })");
      expect(source).toContain("onNavigate={() => {");
    },
  );
});
