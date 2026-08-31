import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../packages/db/audit-clinic-pilot-release.ts",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("clinic-pilot projection audit source", () => {
  it("requires explicit read-only authority and a narrow evidence selector", () => {
    expect(source).toContain("--allow-live-read-only");
    expect(source).toContain("CLINIC_PILOT_RELEASE_READ_ONLY_CONFIRMATION");
    expect(source).toContain("--clinic-use-hash");
    expect(source).toContain("--projection-version");
    expect(source).toContain("isolation level repeatable read read only");
  });

  it("binds the projection to one immutable event without emitting identities", () => {
    expect(source).toContain("join clinic_pilot_events event");
    expect(source).toContain("event.projection_version = cp.version");
    expect(source).toContain("event.next_action = cp.next_action");
    expect(source).toContain(
      "event.next_review_at is not distinct from cp.next_review_at",
    );
    expect(source).toContain("recomputedClinicUseHash");
    expect(source).toContain("clinicAdministratorActorHash");
    expect(source).not.toContain("practiceName");
    expect(source).not.toContain("patient_id");
    expect(source).not.toContain("email");
  });
});
