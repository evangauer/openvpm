import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_GUIDE_QUESTION,
  buildGuideSteps,
  type GuideContext,
} from "@/components/tour/guide-recipes";
import { GUIDE_SIGNALS } from "@/components/tour/guide-signals";
import type { GuideId } from "../welcome/cards";

const ALL_GUIDES: GuideId[] = [
  "tour",
  "ask-ai",
  "your-day",
  "client-portal",
  "calendar-feed",
];

/**
 * Where each spotlight anchor must exist as a literal data-tour attribute.
 * This test is the drift guard: renaming or removing an anchored element
 * without updating the recipe fails here instead of silently degrading the
 * guide to a centered card.
 */
const ANCHOR_SOURCES: Record<string, string> = {
  "agent-input": "app/(dashboard)/agent/page.tsx",
  "schedule-calendar": "app/(dashboard)/schedule/page.tsx",
  "whiteboard-board": "app/(dashboard)/whiteboard/page.tsx",
  "client-portal-link": "app/(dashboard)/clients/[id]/page.tsx",
  "calendar-subscribe": "components/schedule/calendar-subscribe.tsx",
};

const RICH_CONTEXT: GuideContext = {
  portalClient: { id: "client-1", firstName: "Jordan" },
  demoPatientName: "Biscuit",
  agentConfigured: true,
};

function allSteps(ctx: GuideContext) {
  return ALL_GUIDES.flatMap((id) => buildGuideSteps(id, ctx));
}

describe("guide recipes", () => {
  it("every recipe anchor exists as a data-tour attribute in its source", () => {
    for (const step of allSteps(RICH_CONTEXT)) {
      if (!step.anchor) continue;
      if (step.anchor.startsWith("nav-")) {
        // Sidebar nav anchors are emitted dynamically per nav item.
        const sidebar = readFileSync("components/layout/sidebar.tsx", "utf8");
        expect(sidebar).toContain("data-tour={`nav-${");
        continue;
      }
      const source = ANCHOR_SOURCES[step.anchor];
      expect(
        source,
        `anchor "${step.anchor}" has no source mapping in ANCHOR_SOURCES`
      ).toBeTruthy();
      const file = readFileSync(source!, "utf8");
      expect(
        file,
        `expected ${source} to contain data-tour="${step.anchor}"`
      ).toContain(`data-tour="${step.anchor}"`);
    }
  });

  it("ask-ai deep-links the prefilled question and advances on a successful run", () => {
    const steps = buildGuideSteps("ask-ai", RICH_CONTEXT);
    expect(steps[0]!.route).toBe(
      `/agent?ask=${encodeURIComponent(AGENT_GUIDE_QUESTION)}`
    );
    expect(steps[0]!.advanceOn).toBe(GUIDE_SIGNALS.agentRunSucceeded);
    expect(steps.length).toBeGreaterThan(1);
  });

  it("ask-ai never blocks when the agent is not configured", () => {
    const steps = buildGuideSteps("ask-ai", {
      ...RICH_CONTEXT,
      agentConfigured: false,
    });
    expect(steps[0]!.advanceOn).toBeUndefined();
    expect(steps[0]!.body).toContain("turns on once");
  });

  it("your-day names the demo patient when present and stays generic otherwise", () => {
    const withDemo = buildGuideSteps("your-day", RICH_CONTEXT);
    expect(withDemo[0]!.body).toContain("Biscuit");
    const without = buildGuideSteps("your-day", {});
    expect(without[0]!.body).not.toContain("Biscuit");
    expect(without.map((s) => s.route)).toContain("/whiteboard");
  });

  it("client-portal routes to the target client and advances on copy", () => {
    const steps = buildGuideSteps("client-portal", RICH_CONTEXT);
    expect(steps[0]!.route).toBe("/clients/client-1");
    expect(steps[0]!.advanceOn).toBe(GUIDE_SIGNALS.portalLinkCopied);
    expect(steps[0]!.body).toContain("Jordan");
  });

  it("client-portal degrades to a single pointer when there is no client", () => {
    const steps = buildGuideSteps("client-portal", { portalClient: null });
    expect(steps).toHaveLength(1);
    expect(steps[0]!.route).toBe("/clients");
    expect(steps[0]!.advanceOn).toBeUndefined();
  });

  it("calendar-feed spotlights the subscribe button and advances on copy", () => {
    const steps = buildGuideSteps("calendar-feed", RICH_CONTEXT);
    expect(steps[0]!.route).toBe("/schedule");
    expect(steps[0]!.anchor).toBe("calendar-subscribe");
    expect(steps[0]!.advanceOn).toBe(GUIDE_SIGNALS.calendarUrlCopied);
  });

  it("keeps guide copy in voice: no em or en dashes", () => {
    for (const step of [
      ...allSteps(RICH_CONTEXT),
      ...allSteps({}),
      ...allSteps({ agentConfigured: false }),
    ]) {
      expect(step.title).not.toMatch(/[—–]/);
      expect(step.body).not.toMatch(/[—–]/);
    }
  });
});
