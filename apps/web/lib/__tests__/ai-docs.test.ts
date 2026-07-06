import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("AI integration docs", () => {
  it("documents live API key and webhook integration paths", () => {
    const source = readFileSync("app/api-docs/ai/page.tsx", "utf8");

    expect(source).toContain("POST https://your-practice.openvpm.com/api/v1/agent");
    expect(source).toContain("POST /api/v1/soap-notes");
    expect(source).toContain("records:write");
    expect(source).toContain("agent:run");
    expect(source).toContain("agent:write");
    expect(source).toContain("webhooks.create");
    expect(source).toContain("Dashboard Query Helpers");
    expect(source).toContain("not API-key REST endpoints");
    expect(source).toContain(
      "tRPC: ai.patientsOverdueVaccinations (session cookie)"
    );
    expect(source).not.toContain("/api/trpc/ai.createSoapFromAI");
    expect(source).not.toContain("GET /api/trpc/ai.");
    expect(source).not.toContain("next-auth.session-token");
    expect(source).not.toContain("Webhook registration endpoint coming soon");
    expect(source).not.toContain("API Key Authentication");
    expect(source).not.toContain("Coming Soon");
    expect(source).not.toContain("Voice Agent Integration");
  });
});
