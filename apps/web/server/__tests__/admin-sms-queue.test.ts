import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("server/routers/admin.ts", "utf8");

describe("SMS operator recovery queue", () => {
  const queue = source.slice(
    source.indexOf("smsSendAttemptQueue:"),
    source.indexOf("smsSendAttempt:", source.indexOf("smsSendAttemptQueue:")),
  );

  it("includes only stale pending communication claims with no attempt", () => {
    expect(queue).toContain('"orphan_pending_communication"');
    expect(queue).toContain('eq(communications.channel, "sms")');
    expect(queue).toContain('eq(communications.direction, "outbound")');
    expect(queue).toContain('eq(communications.status, "pending")');
    expect(queue).toContain("lte(communications.createdAt, cutoff)");
    expect(queue).toContain("not exists (");
    expect(queue).toContain("orphan_attempt.communication_id");
  });

  it("surfaces terminal attempt outcomes whose communication stayed pending", () => {
    expect(queue).toContain('"terminal_projection_pending"');
    expect(queue).toContain("in ('accepted', 'definite_failure')");
    expect(queue).toContain("pending_projection.status = 'pending'");
  });

  it("keeps the queue bounded, oldest-first, and no-store", () => {
    expect(queue).toContain("noStore()");
    expect(queue).toContain(".slice(0, input.limit)");
    expect(queue).toContain('cacheControl: "no-store" as const');
  });
});
