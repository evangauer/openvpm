import { describe, it, vi } from "vitest";
import { disposableClinic } from "./helpers/disposable-clinic";
import { runGoldenClinic } from "./helpers/golden-clinic";

// Provider delivery is deliberately outside this database workflow contract.
vi.mock("@/lib/webhook-dispatcher", () => ({ dispatchWebhookEvent: vi.fn() }));

const integration =
  process.env.GOLDEN_CLINIC_DB_INTEGRATION === "1" ? describe : describe.skip;
integration("Golden clinic workflow on disposable PostgreSQL", () => {
  it("completes a visit through protected routers and preserves tenant, signing and billing boundaries", async () => {
    const fixture = await disposableClinic();
    const originalUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = fixture.appUrl;
    try {
      await runGoldenClinic(fixture);
    } finally {
      process.env.DATABASE_URL = originalUrl;
      await fixture.close();
    }
  }, 240_000);
});
