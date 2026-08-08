import { describe, expect, it, vi } from "vitest";
import { appointments, practices } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { lockOpenVisitForClinicalAppend } from "../visit-integrity";

const PRACTICE_ID = "00000000-0000-0000-0000-000000000001";
const PATIENT_ID = "00000000-0000-0000-0000-000000000002";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000003";
const DOCTOR_ID = "00000000-0000-0000-0000-000000000004";

function sqlIncludesColumn(
  value: unknown,
  column: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (Object.is(value, column)) return true;
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => sqlIncludesColumn(item, column, seen));
  }
  return Object.values(value as Record<string, unknown>).some((item) =>
    sqlIncludesColumn(item, column, seen),
  );
}

function visitDb(selectResults: unknown[][]) {
  const results = [...selectResults];
  const builders: Array<{
    where: ReturnType<typeof vi.fn>;
    for: ReturnType<typeof vi.fn>;
  }> = [];
  const select = vi.fn(() => {
    const result = results.shift() ?? [];
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      for: vi.fn(async () => result),
      limit: vi.fn(async () => result),
    };
    builders.push(builder);
    return builder;
  });
  return { db: { select } as unknown as Database, builders };
}

function guard(db: Database) {
  return lockOpenVisitForClinicalAppend(db, {
    practiceId: PRACTICE_ID,
    patientId: PATIENT_ID,
    appointmentId: APPOINTMENT_ID,
  });
}

describe("lockOpenVisitForClinicalAppend", () => {
  it("fails closed for cross-tenant, wrong-patient, deleted, or missing appointments", async () => {
    const { db, builders } = visitDb([[]]);

    await expect(guard(db)).resolves.toEqual({
      ok: false,
      reason: "appointment_not_found",
    });

    const condition = builders[0]!.where.mock.calls[0]![0];
    expect(sqlIncludesColumn(condition, appointments.id)).toBe(true);
    expect(sqlIncludesColumn(condition, appointments.patientId)).toBe(true);
    expect(sqlIncludesColumn(condition, appointments.practiceId)).toBe(true);
    expect(sqlIncludesColumn(condition, appointments.deletedAt)).toBe(true);
    expect(sqlIncludesColumn(condition, practices.id)).toBe(true);
    expect(sqlIncludesColumn(condition, practices.deletedAt)).toBe(true);
    expect(builders[0]!.for).toHaveBeenCalledWith("update");
  });

  it("rejects completed and otherwise non-open appointment states", async () => {
    const { db } = visitDb([
      [
        {
          id: APPOINTMENT_ID,
          doctorId: DOCTOR_ID,
          status: "checked_out",
        },
      ],
    ]);

    await expect(guard(db)).resolves.toEqual({
      ok: false,
      reason: "visit_not_open",
    });
  });

  it.each(["clinical_finalized", "completed"] as const)(
    "rejects an in-exam visit whose clinical closeout is %s",
    async (status) => {
      const { db } = visitDb([
        [
          {
            id: APPOINTMENT_ID,
            doctorId: DOCTOR_ID,
            status: "in_exam",
          },
        ],
        [{ status }],
      ]);

      await expect(guard(db)).resolves.toEqual({
        ok: false,
        reason: "visit_finalized",
      });
    },
  );

  it("returns the assigned clinician for a valid open visit", async () => {
    const { db } = visitDb([
      [
        {
          id: APPOINTMENT_ID,
          doctorId: DOCTOR_ID,
          status: "in_exam",
        },
      ],
      [{ status: "draft" }],
    ]);

    await expect(guard(db)).resolves.toEqual({
      ok: true,
      appointment: {
        id: APPOINTMENT_ID,
        doctorId: DOCTOR_ID,
        status: "in_exam",
      },
    });
  });
});
