import { afterEach, describe, expect, it, vi } from "vitest";
import {
  leadCaptureAuthorized,
  leadCaptureSecret,
  leadEmailHash,
  normalizeLeadEmail,
} from "../leads";

const SECRET = "lead-capture-secret-at-least-32-bytes!";

afterEach(() => vi.unstubAllEnvs());

describe("lead helpers", () => {
  it("normalizes and hashes addresses stably", () => {
    expect(normalizeLeadEmail("  Vet@Clinic.COM ")).toBe("vet@clinic.com");
    expect(leadEmailHash("Vet@Clinic.com")).toBe(
      leadEmailHash("vet@clinic.com"),
    );
    expect(leadEmailHash("vet@clinic.com")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires a long capture secret", () => {
    vi.stubEnv("LEAD_CAPTURE_SECRET", "short");
    expect(leadCaptureSecret()).toBeNull();
    vi.stubEnv("LEAD_CAPTURE_SECRET", SECRET);
    expect(leadCaptureSecret()).toBe(SECRET);
  });

  it("authorizes only the exact bearer secret", () => {
    expect(leadCaptureAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(leadCaptureAuthorized(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(leadCaptureAuthorized(SECRET, SECRET)).toBe(false);
    expect(leadCaptureAuthorized(null, SECRET)).toBe(false);
    expect(leadCaptureAuthorized(`Bearer ${SECRET}`, null)).toBe(false);
  });
});
