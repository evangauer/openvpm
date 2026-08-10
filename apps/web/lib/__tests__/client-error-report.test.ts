import { describe, expect, it } from "vitest";
import {
  classifyClientError,
  sanitizeClientErrorDigest,
  sanitizeClientErrorPath,
} from "../client-error-report";

describe("client error report privacy", () => {
  it("keeps only allowlisted error families", () => {
    expect(classifyClientError(new TypeError("private content"))).toBe(
      "TypeError"
    );
    const custom = new Error("private content");
    custom.name = "Patient Daisy Error";
    expect(classifyClientError(custom)).toBe("Error");
  });

  it("keeps opaque digests and rejects human-readable content", () => {
    expect(sanitizeClientErrorDigest("next-abc_123.4")).toBe(
      "next-abc_123.4"
    );
    expect(sanitizeClientErrorDigest("Patient Daisy failed")).toBeNull();
  });

  it.each([
    ["/patients/323e4567-e89b-42d3-a456-426614174000/edit", "/patients/:id/edit"],
    ["/portal/private-token/pets/private-pet", "/portal/:token/pets/:id"],
    ["/book/identifying-clinic-slug", "/book/:slug"],
    ["/settings?tab=messaging", "/settings"],
    ["/unrecognized/Client-Jane", "/other"],
  ])("maps %s to a non-identifying route", (path, expected) => {
    expect(sanitizeClientErrorPath(path)).toBe(expected);
  });
});
