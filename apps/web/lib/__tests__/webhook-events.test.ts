import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WEBHOOK_EVENTS } from "../webhook-events";

describe("webhook event catalog", () => {
  it("only exposes events that production code emits", () => {
    const emissionSource = [
      "server/routers/appointments.ts",
      "server/routers/clients.ts",
      "server/routers/patients.ts",
      "server/routers/records.ts",
      "server/routers/billing.ts",
      "server/routers/whiteboard.ts",
      "app/api/v1/appointments/route.ts",
      "app/api/webhooks/stripe/route.ts",
      "server/routers/portal.ts",
      "lib/agent/tools.ts",
      "app/api/cron/prescription-expiry/route.ts",
    ]
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    expect(WEBHOOK_EVENTS).toEqual([
      "appointment.created",
      "appointment.checked_in",
      "appointment.rescheduled",
      "appointment.cancelled",
      "client.created",
      "patient.created",
      "soap_note.created",
      "vaccination.recorded",
      "problem.created",
      "prescription.created",
      "prescription.refill_dispensed",
      "prescription.refill_authorized",
      "prescription.completed",
      "prescription.cancelled",
      "prescription.expired",
      "lab_result.created",
      "procedure.created",
      "invoice.paid",
    ]);
    for (const event of WEBHOOK_EVENTS) {
      expect(emissionSource).toContain(`"${event}"`);
    }
  });

  it("documents the actual webhook delivery headers and payload", () => {
    const apiDocs = readFileSync("app/api-docs/page.tsx", "utf8");
    const aiDocs = readFileSync("app/api-docs/ai/page.tsx", "utf8");
    const readmeWebhooks =
      readFileSync("../../README.md", "utf8")
        .split("### Webhooks")[1]
        ?.split("### API Keys")[0] ?? "";

    expect(apiDocs).toContain("X-Webhook-Signature");
    expect(apiDocs).toContain("X-Webhook-Event");
    expect(apiDocs).not.toContain("X-OpenVPM-Signature");
    expect(apiDocs).not.toContain('"practice_id"');
    expect(aiDocs).not.toContain('"practiceId"');
    expect(apiDocs).toContain("WEBHOOK_EVENT_DEFINITIONS");
    expect(aiDocs).toContain("WEBHOOK_EVENT_DEFINITIONS");
    for (const [, event] of readmeWebhooks.matchAll(
      /"([a-z_]+(?:\.[a-z_]+)+)"/g,
    )) {
      expect(WEBHOOK_EVENTS).toContain(event);
    }
  });
});
