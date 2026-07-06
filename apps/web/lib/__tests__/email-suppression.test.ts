import { describe, expect, it } from "vitest";
import {
  emailSuppressionSendBlockMessage,
  normalizeEmailSuppressionAddress,
} from "../email-suppression";

describe("email suppression helpers", () => {
  it("normalizes valid recipient addresses for provider suppressions", () => {
    expect(normalizeEmailSuppressionAddress(" Ada@Example.COM ")).toBe(
      "ada@example.com"
    );
    expect(normalizeEmailSuppressionAddress("not-an-email")).toBeNull();
    expect(
      normalizeEmailSuppressionAddress(`${"a".repeat(245)}@example.com`)
    ).toBeNull();
  });

  it("explains why suppressed client email sends are blocked", () => {
    expect(emailSuppressionSendBlockMessage("complaint")).toContain(
      "spam complaint"
    );
    expect(emailSuppressionSendBlockMessage("bounce")).toContain(
      "delivery bounce"
    );
  });
});
