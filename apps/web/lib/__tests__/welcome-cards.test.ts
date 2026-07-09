import { describe, expect, it } from "vitest";
import {
  canRunAgentGuideRole,
  visibleWelcomeCards,
} from "../welcome/cards";

describe("welcome card visibility", () => {
  it("shows all four cards to roles that can run the agent", () => {
    for (const role of ["admin", "veterinarian"]) {
      const cards = visibleWelcomeCards({ role });
      expect(cards).toEqual([
        "ask-ai",
        "your-day",
        "client-portal",
        "calendar-feed",
      ]);
    }
  });

  it("hides the AI card for roles without agent access", () => {
    for (const role of ["front_desk", "technician", "viewer"]) {
      const cards = visibleWelcomeCards({ role });
      expect(cards).toEqual(["your-day", "client-portal", "calendar-feed"]);
      expect(cards).not.toContain("ask-ai");
    }
  });

  it("treats a missing role as no agent access", () => {
    expect(visibleWelcomeCards({ role: null })).toEqual([
      "your-day",
      "client-portal",
      "calendar-feed",
    ]);
    expect(visibleWelcomeCards({})).toEqual([
      "your-day",
      "client-portal",
      "calendar-feed",
    ]);
  });

  it("matches the agent page's own role gate", () => {
    // agent/page.tsx canRunAgentRole: admin | veterinarian only.
    expect(canRunAgentGuideRole("admin")).toBe(true);
    expect(canRunAgentGuideRole("veterinarian")).toBe(true);
    expect(canRunAgentGuideRole("technician")).toBe(false);
    expect(canRunAgentGuideRole("front_desk")).toBe(false);
    expect(canRunAgentGuideRole("viewer")).toBe(false);
    expect(canRunAgentGuideRole(undefined)).toBe(false);
  });
});
