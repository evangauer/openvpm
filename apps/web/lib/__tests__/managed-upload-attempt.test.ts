import { describe, expect, it } from "vitest";
import {
  isRetryableUploadStatus,
  selectManagedUploadFile,
  settleManagedUploadAttempt,
} from "../managed-upload-attempt";

describe("managed browser upload attempts", () => {
  const file = (name: string) => new File(["image"], name, { type: "image/png" });

  it("keeps one idempotency key for ambiguous and retryable attempts", () => {
    const selected = file("logo.png");
    const first = selectManagedUploadFile(null, selected, () => "operation-1");

    expect(selectManagedUploadFile(first, selected, () => "operation-2")).toBe(
      first,
    );
    expect(
      settleManagedUploadAttempt(first, { kind: "ambiguous" }),
    ).toBe(first);
    expect(
      settleManagedUploadAttempt(first, { kind: "response", status: 503 }),
    ).toBe(first);
    expect(
      settleManagedUploadAttempt(first, { kind: "response", status: 429 }),
    ).toBe(first);
  });

  it("resets on a file change, definitive success, or client failure", () => {
    const first = selectManagedUploadFile(null, file("first.png"), () => "one");
    const second = selectManagedUploadFile(first, file("second.png"), () => "two");

    expect(second.idempotencyKey).toBe("two");
    expect(settleManagedUploadAttempt(second, { kind: "success" })).toBeNull();
    expect(
      settleManagedUploadAttempt(second, { kind: "response", status: 400 }),
    ).toBeNull();
    expect(
      settleManagedUploadAttempt(second, { kind: "response", status: 409 }),
    ).toBeNull();
  });

  it("classifies only ambiguous or explicitly retryable statuses as retryable", () => {
    for (const status of [0, 408, 425, 429, 500, 503]) {
      expect(isRetryableUploadStatus(status)).toBe(true);
    }
    for (const status of [200, 400, 404, 409, 413, 422]) {
      expect(isRetryableUploadStatus(status)).toBe(false);
    }
  });
});
