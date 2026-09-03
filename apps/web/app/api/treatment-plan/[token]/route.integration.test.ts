import { afterAll, describe, expect, it } from "vitest";
import { deriveTreatmentPlanConsentToken } from "@/lib/consult/tokens";

const runDatabaseIntegration =
  process.env.TREATMENT_PLAN_POOL_ONE_INTEGRATION === "1"
    ? describe
    : describe.skip;

const TOKEN = "ab".repeat(32);

runDatabaseIntegration("treatment-plan pool-size-one route", () => {
  afterAll(async () => {
    await globalThis.__openpimsDb?.client.end();
    globalThis.__openpimsDb = undefined;
  });

  it("rate-limits, resolves, and creates a digest-only signing request without nested acquisition", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request(`https://openvpm.test/api/treatment-plan/${TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions: [
            {
              revisionLineId: "33333333-3333-4333-8333-333333333338",
              decision: "accepted",
              acceptedQuantity: "1",
            },
          ],
        }),
      }) as never,
      { params: Promise.resolve({ token: TOKEN }) },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      status: "awaiting_signature",
      signUrl: `https://openvpm.test/sign/${deriveTreatmentPlanConsentToken(TOKEN)}`,
    });
  }, 5_000);
});
