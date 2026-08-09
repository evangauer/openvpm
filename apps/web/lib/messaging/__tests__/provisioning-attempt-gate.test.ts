import { describe, expect, it, vi } from "vitest";
import {
  releaseMessagingProfileAttemptWithDatabase,
  reserveMessagingProfileAttemptWithDatabase,
} from "../provisioning-attempt-gate";

const INPUT = {
  practiceId: "00000000-0000-0000-0000-0000000000aa",
  locationId: "00000000-0000-0000-0000-000000000002",
  senderE164: "+15555550100",
  customerReference:
    "openvpm:00000000-0000-0000-0000-0000000000aa:00000000-0000-0000-0000-000000000002",
  detail: "Profile attempt reserved; sending remains disabled.",
};

describe("messaging profile attempt gate", () => {
  it("returns true only when the independent insert/update returns the target location", async () => {
    const execute = vi.fn(async (_statement: unknown) => [
      { locationId: INPUT.locationId },
    ]);

    await expect(
      reserveMessagingProfileAttemptWithDatabase({ execute } as never, INPUT)
    ).resolves.toBe(true);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("fails closed when an active row prevents reserving a fresh attempt", async () => {
    const execute = vi.fn(async (_statement: unknown) => []);

    await expect(
      reserveMessagingProfileAttemptWithDatabase({ execute } as never, INPUT)
    ).resolves.toBe(false);
  });

  it("releases only when the exact untouched gate update returns the location", async () => {
    const execute = vi
      .fn(async (_statement: unknown) => [{ locationId: INPUT.locationId }]);

    await expect(
      releaseMessagingProfileAttemptWithDatabase({ execute } as never, INPUT)
    ).resolves.toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
