import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const SETTINGS_SOURCE = readFileSync(
  new URL("../routers/settings.ts", import.meta.url),
  "utf8"
);

vi.mock("@/lib/billing/subscription-sync", () => ({
  syncPracticeSubscriptionQuantities: vi.fn(async () => ({
    status: "ok",
    message: "synced",
    updatedAt: new Date("2026-06-27T00:00:00Z").toISOString(),
    locationCount: 1,
    billableSeatCount: 1,
  })),
}));

const { settingsRouter } = await import("../routers/settings");
const { syncPracticeSubscriptionQuantities } = await import(
  "@/lib/billing/subscription-sync"
);
const { AUTH_PASSWORD_MAX_LENGTH, AUTH_PASSWORD_MIN_LENGTH } = await import(
  "@/lib/auth-password"
);
const {
  SETTINGS_EMAIL_MAX_LENGTH,
  STAFF_NAME_MAX_LENGTH,
  isSupportedPracticeTimezone,
} = await import("@/lib/settings-policy");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const STAFF_ID = "00000000-0000-0000-0000-000000000002";
const TYPE_ID = "00000000-0000-0000-0000-000000000003";
const ROOM_ID = "00000000-0000-0000-0000-000000000004";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000005";
const WAITLIST_ID = "00000000-0000-0000-0000-000000000006";
const SCHEDULE_ID = "00000000-0000-0000-0000-000000000007";

function callerWithDb(db: Record<string, unknown>) {
  const session = {
    user: {
      id: USER_ID,
      email: "admin@example.com",
      name: "Admin",
      role: "admin",
      practiceId: PRACTICE_ID,
    },
  };
  return settingsRouter.createCaller({ db, session } as never);
}

function createDb(opts?: {
  updatedRows?: unknown[];
  selectRows?: unknown[];
  selectResults?: unknown[][];
}) {
  const selectResults = [...(opts?.selectResults ?? [])];
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => {
        const result =
          selectResults.length > 0
            ? selectResults.shift()
            : (opts?.selectRows ?? []);
        return {
          limit: vi.fn(async () => result),
          for: vi.fn(async () => result),
        };
      }),
    })),
  }));
  const updateReturning = vi.fn(async () => opts?.updatedRows ?? []);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const insertReturning = vi.fn(async () => []);
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
    update,
    insert,
  };

  return { db, updateSet, insertValues };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("settings admin stale target safety", () => {
  it("rejects settings strings that exceed storage bounds before writes", async () => {
    const { db, updateSet, insertValues } = createDb();

    await expect(
      callerWithDb(db).updatePractice({ name: "A".repeat(256) })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updatePractice({ address: "A".repeat(501) })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updatePractice({ phone: "1".repeat(33) })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updatePractice({ country: "U1" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updatePractice({ timezone: "   " })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updatePractice({ timezone: "Mars/Olympus_Mons" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updatePractice({ taxRatePercent: "100.01" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updateUser({ id: STAFF_ID, name: "A".repeat(256) })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updateAppointmentType({
        id: TYPE_ID,
        name: "A".repeat(129),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createRoom({ name: "A".repeat(129), type: "exam" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createUser({
        name: "Taylor",
        email: "taylor@example.com",
        password: "p".repeat(AUTH_PASSWORD_MIN_LENGTH - 1),
        role: "front_desk",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createUser({
        name: "Taylor",
        email: "taylor@example.com",
        password: "p".repeat(AUTH_PASSWORD_MAX_LENGTH + 1),
        role: "front_desk",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const oversizedInviteEmail = `${"a".repeat(64)}@${"b".repeat(
      63
    )}.${"c".repeat(63)}.${"d".repeat(63)}.com`;
    expect(oversizedInviteEmail.length).toBeGreaterThan(
      SETTINGS_EMAIL_MAX_LENGTH
    );

    await expect(
      callerWithDb(db).inviteStaff({
        email: oversizedInviteEmail,
        role: "front_desk",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).inviteStaff({
        email: "invite@example.com",
        name: "A".repeat(STAFF_NAME_MAX_LENGTH + 1),
        role: "front_desk",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).setTourStatus({
        status: "in_progress",
        lastStepId: "A".repeat(129),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).setOnboardingIntent({ intent: "unknown" as never })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("persists a validated onboarding pathway without a schema write", async () => {
    const { db, updateSet } = createDb({
      updatedRows: [{ id: PRACTICE_ID }],
    });

    await expect(
      callerWithDb(db).setOnboardingIntent({ intent: "alongside" })
    ).resolves.toEqual({ ok: true });

    expect(updateSet).toHaveBeenCalledTimes(1);
    expect(SETTINGS_SOURCE).toContain("onboardingStateMergePatch({");
    expect(SETTINGS_SOURCE).toContain("onboardingIntent: input.intent");
    expect(SETTINGS_SOURCE).toContain("onboardingIntentSelectedAt");
  });

  it("validates practice timezone strings through the shared settings policy", () => {
    expect(isSupportedPracticeTimezone("America/New_York")).toBe(true);
    expect(isSupportedPracticeTimezone(" Europe/London ")).toBe(true);
    expect(isSupportedPracticeTimezone("")).toBe(false);
    expect(isSupportedPracticeTimezone("Mars/Olympus_Mons")).toBe(false);
  });

  it("rejects missing or deleted practice metadata reads", async () => {
    const { db } = createDb({ selectResults: [[], [], []] });

    await expect(callerWithDb(db).getPractice()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(callerWithDb(db).getBranding()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      callerWithDb(db).getAccountDeletionRequest()
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });
  });

  it("rejects missing or deleted practice settings writes before fallback state is created", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[]],
      updatedRows: [],
    });

    // completeOnboarding writes with a guarded atomic update: the
    // active-practice predicate excludes missing/deleted rows, so zero
    // updated rows surfaces as NOT_FOUND and no fallback state is created.
    await expect(callerWithDb(db).completeOnboarding()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });
    expect(updateSet).toHaveBeenCalledTimes(1);
    updateSet.mockClear();

    await expect(
      callerWithDb(db).updatePractice({ name: "Neighborhood Veterinary" })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });
    expect(updateSet).toHaveBeenCalledWith({ name: "Neighborhood Veterinary" });
  });

  it("requires an active practice for practice metadata and onboarding state", () => {
    expect(SETTINGS_SOURCE).toContain("function activePracticeWhere");
    expect(SETTINGS_SOURCE).toContain("function practiceNotFound");
    expect(SETTINGS_SOURCE).toContain("isNull(practices.deletedAt)");
    expect(SETTINGS_SOURCE).toContain('message: "Practice not found"');
    expect(
      SETTINGS_SOURCE.match(/activePracticeWhere\(ctx\.practiceId\)/g)
        ?.length ?? 0
    ).toBeGreaterThanOrEqual(15);
    expect(SETTINGS_SOURCE).not.toContain("practice?.settings ?? {}");
    expect(SETTINGS_SOURCE).not.toContain('practice?.name ?? "OpenVPM"');
  });

  it("rejects stale staff updates with a typed not-found error", async () => {
    const { db, updateSet } = createDb({ updatedRows: [] });

    await expect(
      callerWithDb(db).updateUser({ id: STAFF_ID, name: "Taylor" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).toHaveBeenCalledWith({ name: "Taylor" });
  });

  it("rejects duplicate staff emails before inserting", async () => {
    const { db, insertValues } = createDb({ selectRows: [{ id: STAFF_ID }] });

    await expect(
      callerWithDb(db).createUser({
        name: "Taylor",
        email: "Taylor@Example.com",
        password: "password123",
        role: "front_desk",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(insertValues).not.toHaveBeenCalled();
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("rejects staff list and create when the practice is missing or deleted", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[], []],
    });

    await expect(callerWithDb(db).listUsers()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      callerWithDb(db).createUser({
        name: "Taylor",
        email: "taylor@example.com",
        password: "password123",
        role: "front_desk",
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("rejects staff invites before insert when the practice is missing or deleted", async () => {
    const { db, insertValues } = createDb({ selectResults: [[], []] });

    await expect(
      callerWithDb(db).inviteStaff({
        email: "invite@example.com",
        role: "front_desk",
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("requires an active practice for staff reads, writes, and deactivation dependencies", () => {
    const staffBlock = SETTINGS_SOURCE.match(
      /\/\/ ── Staff \/ Users[\s\S]+?\/\/ ── Appointment Types/
    )?.[0];

    expect(staffBlock).toContain("await assertActivePractice(ctx)");
    expect(
      staffBlock?.match(/activePracticePredicate\(ctx\.practiceId\)/g)
        ?.length ?? 0
    ).toBeGreaterThanOrEqual(10);
    expect(staffBlock).toMatch(
      /eq\(users\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(users\.deletedAt\)/
    );
    expect(staffBlock).toMatch(
      /eq\(appointments\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(appointments\.deletedAt\)/
    );
    expect(staffBlock).toMatch(
      /eq\(staffSchedules\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(staffSchedules\.deletedAt\)/
    );
    expect(staffBlock).toContain("activePracticeWhere(ctx.practiceId)");
    expect(staffBlock).toContain("eq(users.role, targetUser.role)");
  });

  it("rejects demoting the last active admin", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: STAFF_ID, role: "admin" }], []],
    });

    await expect(
      callerWithDb(db).updateUser({ id: STAFF_ID, role: "viewer" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.execute).toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("allows admin demotion when another active admin remains", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [{ id: STAFF_ID, role: "admin" }],
        [{ id: USER_ID }],
      ],
      updatedRows: [{ id: STAFF_ID, role: "viewer" }],
    });

    await expect(
      callerWithDb(db).updateUser({ id: STAFF_ID, role: "viewer" })
    ).resolves.toMatchObject({ id: STAFF_ID, role: "viewer" });

    expect(db.execute).toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith({ role: "viewer" });
  });

  it("rejects stale staff role demotions", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [{ id: STAFF_ID, role: "admin" }],
        [{ id: USER_ID }],
      ],
      updatedRows: [],
    });

    await expect(
      callerWithDb(db).updateUser({ id: STAFF_ID, role: "viewer" })
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(db.execute).toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith({ role: "viewer" });
  });

  it("rejects self-deactivation before DB work", async () => {
    const { db, updateSet } = createDb();

    await expect(
      callerWithDb(db).deactivateUser({ id: USER_ID })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("does not sync billing after stale staff deactivation", async () => {
    const { db, updateSet } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).deactivateUser({ id: STAFF_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("rejects deactivating the last active admin", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: STAFF_ID, role: "admin" }], []],
    });

    await expect(
      callerWithDb(db).deactivateUser({ id: STAFF_ID })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("rejects staff deactivation when active appointments are assigned", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [{ id: STAFF_ID, role: "veterinarian" }],
        [{ id: APPOINTMENT_ID }],
      ],
    });

    await expect(
      callerWithDb(db).deactivateUser({ id: STAFF_ID })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("rejects staff deactivation when an active staff schedule is assigned", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [{ id: STAFF_ID, role: "veterinarian" }],
        [],
        [{ id: SCHEDULE_ID }],
      ],
    });

    await expect(
      callerWithDb(db).deactivateUser({ id: STAFF_ID })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("rejects staff deactivation when the observed role changes", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: STAFF_ID, role: "front_desk" }], [], []],
      updatedRows: [],
    });

    await expect(
      callerWithDb(db).deactivateUser({ id: STAFF_ID })
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(db.execute).toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith({ deletedAt: expect.any(Date) });
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("does not sync billing after stale staff restore", async () => {
    const { db, updateSet } = createDb({ updatedRows: [] });

    await expect(
      callerWithDb(db).restoreUser({ id: STAFF_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).toHaveBeenCalledWith({ deletedAt: null });
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("rejects appointment type and room list/create when the practice is missing or deleted", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[], [], [], []],
    });

    await expect(callerWithDb(db).listAppointmentTypes()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      callerWithDb(db).createAppointmentType({
        name: "Consultation",
        durationMinutes: 30,
        color: "#1a8f8a",
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(callerWithDb(db).listRooms()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      callerWithDb(db).createRoom({
        name: "Exam 1",
        type: "exam",
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects stale appointment type updates", async () => {
    const { db, updateSet } = createDb({ updatedRows: [] });

    await expect(
      callerWithDb(db).updateAppointmentType({
        id: TYPE_ID,
        name: "Surgery",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).toHaveBeenCalledWith({ name: "Surgery" });
  });

  it("rejects stale appointment type deletes", async () => {
    const { db, updateSet } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).deleteAppointmentType({ id: TYPE_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects appointment type deletes when active appointments use the type", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: TYPE_ID }], [{ id: APPOINTMENT_ID }]],
    });

    await expect(
      callerWithDb(db).deleteAppointmentType({ id: TYPE_ID })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects appointment type deletes when waiting requests use the type", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: TYPE_ID }], [], [{ id: WAITLIST_ID }]],
    });

    await expect(
      callerWithDb(db).deleteAppointmentType({ id: TYPE_ID })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("soft-deletes appointment types without active scheduling dependencies", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: TYPE_ID }], [], []],
      updatedRows: [{ id: TYPE_ID }],
    });

    await expect(
      callerWithDb(db).deleteAppointmentType({ id: TYPE_ID })
    ).resolves.toEqual({ success: true });

    expect(updateSet).toHaveBeenCalledWith({ deletedAt: expect.any(Date) });
  });

  it("rejects appointment type deletes while a published request page offers the type", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [{ id: TYPE_ID }],
        [],
        [],
        [{ config: { bookableTypeIds: [TYPE_ID] } }],
      ],
    });

    await expect(
      callerWithDb(db).deleteAppointmentType({ id: TYPE_ID })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("appointment request page"),
    });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects stale room deletes", async () => {
    const { db, updateSet } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).deleteRoom({ id: ROOM_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects room deletes when active appointments use the room", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: ROOM_ID }], [{ id: APPOINTMENT_ID }]],
    });

    await expect(
      callerWithDb(db).deleteRoom({ id: ROOM_ID })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("soft-deletes rooms without active appointments", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: ROOM_ID }], []],
      updatedRows: [{ id: ROOM_ID }],
    });

    await expect(
      callerWithDb(db).deleteRoom({ id: ROOM_ID })
    ).resolves.toEqual({ success: true });

    expect(updateSet).toHaveBeenCalledWith({ deletedAt: expect.any(Date) });
  });
});

describe("settings demo data cleanup scoping", () => {
  it("scopes invoice-item cleanup through current-practice invoices", () => {
    const clearDemoBlock = SETTINGS_SOURCE.match(
      /clearDemoData:[\s\S]+?reseedDemoData:/
    )?.[0];
    const invoiceItemBlock = clearDemoBlock?.match(
      /\.update\(invoiceItems\)[\s\S]+?if \(demo\.invoiceIds/
    )?.[0];

    expect(invoiceItemBlock).toContain(
      "inArray(invoiceItems.id, demo.invoiceItemIds)"
    );
    expect(invoiceItemBlock).toContain("from ${invoices}");
    expect(invoiceItemBlock).toContain(
      "${invoices.id} = ${invoiceItems.invoiceId}"
    );
    expect(invoiceItemBlock).toContain(
      "${invoices.practiceId} = ${ctx.practiceId}"
    );
  });

  it("derives and records legacy demo SOAP ids before immutable cleanup", () => {
    const clearDemoBlock = SETTINGS_SOURCE.match(
      /clearDemoData:[\s\S]+?reseedDemoData:/,
    )?.[0];

    expect(clearDemoBlock).toContain("let demoSoapNoteIds");
    expect(clearDemoBlock).toContain(
      "inArray(soapNotes.appointmentId, demo.appointmentIds)",
    );
    expect(clearDemoBlock).toContain(
      "inArray(soapNotes.patientId, demo.patientIds)",
    );
    expect(clearDemoBlock).toContain(
      "demoData: { ...demo, soapNoteIds: demoSoapNoteIds }",
    );
    expect(clearDemoBlock?.indexOf("settingsMergePatch({")).toBeLessThan(
      clearDemoBlock?.indexOf(".update(soapNotes)") ?? -1,
    );
    expect(clearDemoBlock).toContain("inArray(soapNotes.id, demoSoapNoteIds)");
  });
});

describe("settings scheduling metadata delete safety", () => {
  it("requires an active practice for appointment type and room reads and writes", () => {
    const appointmentTypeBlock = SETTINGS_SOURCE.match(
      /\/\/ ── Appointment Types[\s\S]+?\/\/ ── Rooms/
    )?.[0];
    const roomBlock = SETTINGS_SOURCE.match(
      /\/\/ ── Rooms[\s\S]+?\n\s*\}\),\n\}\);/
    )?.[0];

    expect(appointmentTypeBlock).toContain("await assertActivePractice(ctx)");
    expect(
      appointmentTypeBlock?.match(/activePracticePredicate\(ctx\.practiceId\)/g)
        ?.length ?? 0
    ).toBeGreaterThanOrEqual(6);
    expect(appointmentTypeBlock).toMatch(
      /eq\(appointmentTypes\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(appointmentTypes\.deletedAt\)/
    );
    expect(appointmentTypeBlock).toMatch(
      /eq\(appointmentWaitlist\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+eq\(appointmentWaitlist\.status, "waiting"\)/
    );

    expect(roomBlock).toContain("await assertActivePractice(ctx)");
    expect(
      roomBlock?.match(/activePracticePredicate\(ctx\.practiceId\)/g)?.length ??
        0
    ).toBeGreaterThanOrEqual(4);
    expect(roomBlock).toMatch(
      /eq\(rooms\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(rooms\.deletedAt\)/
    );
  });

  it("guards appointment type and room deletes with tenant-scoped active scheduling checks", () => {
    const appointmentTypeDeleteBlock = SETTINGS_SOURCE.match(
      /deleteAppointmentType:[\s\S]+?\/\/ ── Rooms/
    )?.[0];
    const roomDeleteBlock = SETTINGS_SOURCE.match(
      /deleteRoom:[\s\S]+?\n\s*\}\),\n\}\);/
    )?.[0];

    expect(appointmentTypeDeleteBlock).toContain("eq(appointments.typeId, input.id)");
    expect(appointmentTypeDeleteBlock).toContain(
      "eq(appointments.practiceId, ctx.practiceId)"
    );
    expect(appointmentTypeDeleteBlock).toContain(
      "activePracticePredicate(ctx.practiceId)"
    );
    expect(appointmentTypeDeleteBlock).toContain(
      "inArray(appointments.status, activeSchedulingStatuses)"
    );
    expect(appointmentTypeDeleteBlock).toContain(
      "eq(appointmentWaitlist.typeId, input.id)"
    );
    expect(appointmentTypeDeleteBlock).toContain(
      "eq(appointmentWaitlist.practiceId, ctx.practiceId)"
    );
    expect(appointmentTypeDeleteBlock).toContain(
      "activePracticePredicate(ctx.practiceId)"
    );
    expect(appointmentTypeDeleteBlock).toContain(
      'eq(appointmentWaitlist.status, "waiting")'
    );
    expect(appointmentTypeDeleteBlock).toContain('.for("update")');
    expect(appointmentTypeDeleteBlock).toContain(
      "parseBookingPageConfig(publishedPage.config)"
    );

    expect(roomDeleteBlock).toContain("eq(appointments.roomId, input.id)");
    expect(roomDeleteBlock).toContain(
      "eq(appointments.practiceId, ctx.practiceId)"
    );
    expect(roomDeleteBlock).toContain("activePracticePredicate(ctx.practiceId)");
    expect(roomDeleteBlock).toContain(
      "inArray(appointments.status, activeSchedulingStatuses)"
    );
  });

  it("guards staff deactivation with admin and active appointment checks", () => {
    const deactivateBlock = SETTINGS_SOURCE.match(
      /deactivateUser:[\s\S]+?restoreUser:/
    )?.[0];

    expect(deactivateBlock).toContain("input.id === ctx.user.id");
    expect(deactivateBlock).toContain("pg_advisory_xact_lock");
    expect(deactivateBlock).toContain("targetUser.role === \"admin\"");
    expect(deactivateBlock).toContain("eq(users.role, \"admin\")");
    expect(deactivateBlock).toContain("ne(users.id, input.id)");
    expect(deactivateBlock).toContain("eq(users.role, targetUser.role)");
    expect(deactivateBlock).toContain("eq(appointments.doctorId, input.id)");
    expect(deactivateBlock).toContain(
      "eq(appointments.practiceId, ctx.practiceId)"
    );
    expect(deactivateBlock).toContain(
      "inArray(appointments.status, activeSchedulingStatuses)"
    );
    expect(deactivateBlock).toContain("eq(staffSchedules.userId, input.id)");
    expect(deactivateBlock).toContain(
      "eq(staffSchedules.practiceId, ctx.practiceId)"
    );
    expect(deactivateBlock).toContain("isNull(staffSchedules.deletedAt)");
  });

  it("guards staff role demotions with an admin roster lock", () => {
    const updateUserBlock = SETTINGS_SOURCE.match(
      /updateUser:[\s\S]+?deactivateUser:/
    )?.[0];

    expect(updateUserBlock).toContain('data.role !== "admin"');
    expect(updateUserBlock).toContain("pg_advisory_xact_lock");
    expect(updateUserBlock).toContain("targetUser.role === \"admin\"");
    expect(updateUserBlock).toContain("eq(users.role, \"admin\")");
    expect(updateUserBlock).toContain("ne(users.id, id)");
    expect(updateUserBlock).toContain("eq(users.role, targetUser.role)");
  });
});
