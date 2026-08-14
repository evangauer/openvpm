import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  createAuthToken: vi.fn(async () => "invite-token"),
  sendStaffInviteEmail: vi.fn(async () => ({ success: true })),
  lockPracticeForExternalSideEffects: vi.fn(async () => true),
}));

const SETTINGS_SOURCE = readFileSync(
  new URL("../routers/settings.ts", import.meta.url),
  "utf8",
);
const DEMO_DATA_LIFECYCLE_SOURCE = readFileSync(
  new URL("../../lib/onboarding/demo-data-lifecycle.ts", import.meta.url),
  "utf8",
);

vi.mock("@/lib/auth-tokens", () => ({
  createAuthToken: mocks.createAuthToken,
}));

vi.mock("@/lib/email", () => ({
  sendStaffInviteEmail: mocks.sendStaffInviteEmail,
}));

vi.mock("@/lib/billing/subscription-sync", () => ({
  syncPracticeSubscriptionQuantities: vi.fn(async () => ({
    status: "ok",
    message: "synced",
    updatedAt: new Date("2026-06-27T00:00:00Z").toISOString(),
    locationCount: 1,
    billableSeatCount: 1,
  })),
}));

vi.mock("@/lib/recovery-hold", () => ({
  RECOVERY_HOLD_BLOCK_MESSAGE: "recovery hold",
  lockPracticeForExternalSideEffects: mocks.lockPracticeForExternalSideEffects,
}));

const { settingsRouter } = await import("../routers/settings");
const { syncPracticeSubscriptionQuantities } =
  await import("@/lib/billing/subscription-sync");
const { AUTH_PASSWORD_MAX_LENGTH, AUTH_PASSWORD_MIN_LENGTH } =
  await import("@/lib/auth-password");
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
const LOCATION_ID = "00000000-0000-0000-0000-000000000008";

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
  insertedRows?: unknown[];
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
  const insertReturning = vi.fn(async () => opts?.insertedRows ?? []);
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  const execute = vi.fn(async () => undefined);
  const db: Record<string, unknown> = {
    transaction,
    execute,
    select,
    update,
    insert,
  };

  return { db, transaction, execute, updateSet, insertValues };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("settings admin stale target safety", () => {
  it("rejects settings strings that exceed storage bounds before writes", async () => {
    const { db, updateSet, insertValues } = createDb();

    await expect(
      callerWithDb(db).updatePractice({ name: "A".repeat(256) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updatePractice({ address: "A".repeat(501) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updatePractice({ phone: "1".repeat(33) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updatePractice({ country: "U1" as never }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updatePractice({ timezone: "   " }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updatePractice({ timezone: "Mars/Olympus_Mons" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updatePractice({ taxRatePercent: "100.01" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updateUser({ id: STAFF_ID, name: "A".repeat(256) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updateAppointmentType({
        id: TYPE_ID,
        name: "A".repeat(129),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createRoom({
        name: "A".repeat(129),
        type: "exam",
        locationId: LOCATION_ID,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createUser({
        name: "Taylor",
        email: "taylor@example.com",
        password: "p".repeat(AUTH_PASSWORD_MIN_LENGTH - 1),
        role: "front_desk",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createUser({
        name: "Taylor",
        email: "taylor@example.com",
        password: "p".repeat(AUTH_PASSWORD_MAX_LENGTH + 1),
        role: "front_desk",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const oversizedInviteEmail = `${"a".repeat(64)}@${"b".repeat(
      63,
    )}.${"c".repeat(63)}.${"d".repeat(63)}.com`;
    expect(oversizedInviteEmail.length).toBeGreaterThan(
      SETTINGS_EMAIL_MAX_LENGTH,
    );

    await expect(
      callerWithDb(db).inviteStaff({
        email: oversizedInviteEmail,
        role: "front_desk",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).inviteStaff({
        email: "invite@example.com",
        name: "A".repeat(STAFF_NAME_MAX_LENGTH + 1),
        role: "front_desk",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).setTourStatus({
        status: "in_progress",
        lastStepId: "A".repeat(129),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).setOnboardingIntent({ intent: "unknown" as never }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).setOnboardingIntent({
        intent: "alongside",
        clinicModel: "unknown" as never,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).setOnboardingIntent({
        intent: "alongside",
        firstGoal: "unknown" as never,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("persists a validated onboarding pathway without a schema write", async () => {
    const { db, updateSet } = createDb({
      updatedRows: [{ id: PRACTICE_ID }],
    });

    await expect(
      callerWithDb(db).setOnboardingIntent({
        intent: "alongside",
        clinicModel: "mobile",
        firstGoal: "run_visit",
      }),
    ).resolves.toEqual({ ok: true });

    expect(updateSet).toHaveBeenCalledTimes(1);
    expect(SETTINGS_SOURCE).toContain(
      "onboardingProfileStatePatch({ ...input, now })",
    );
    expect(SETTINGS_SOURCE).toContain(
      "'onboardingIntent', ${input.intent}::text",
    );
    expect(SETTINGS_SOURCE).toContain("${input.clinicModel ?? null}::text");
    expect(SETTINGS_SOURCE).toContain("${input.firstGoal ?? null}::text");
    expect(SETTINGS_SOURCE).toContain("${input.now}::text");
    expect(SETTINGS_SOURCE).toContain("onboardingIntentSelectedAt");
    expect(SETTINGS_SOURCE).toContain("clinicModelSelectedAt");
    expect(SETTINGS_SOURCE).toContain("firstGoalSelectedAt");
    expect(SETTINGS_SOURCE).toContain("journeyLastProgressAt");
  });

  it("keeps setup start and completion cohort timestamps first-write-wins", () => {
    expect(SETTINGS_SOURCE).toContain("function onboardingProfileStatePatch");
    expect(SETTINGS_SOURCE).toContain(
      "nullif(${practices.settings}->'onboardingState'->>'onboardingIntentSelectedAt', '')",
    );
    expect(SETTINGS_SOURCE).toContain("function onboardingCompletionPatch");
    expect(SETTINGS_SOURCE).toContain("${now}::text");
    expect(SETTINGS_SOURCE).toContain(
      "nullif(${practices.settings}->>'onboardingCompletedAt', '')",
    );
    expect(SETTINGS_SOURCE).toContain(
      "settings: onboardingCompletionPatch(completedAt)",
    );
  });

  it("lets the clinic owner become a veterinarian provider on the primary location", async () => {
    const primaryLocationId = "00000000-0000-0000-0000-000000000008";
    const profile = {
      id: USER_ID,
      isVeterinarian: true,
      licenseNumber: "CO-1234",
      locationId: primaryLocationId,
    };
    const { db, updateSet } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: USER_ID, isVeterinarian: false, locationId: null }],
        [{ id: primaryLocationId }],
      ],
      updatedRows: [profile],
    });

    await expect(
      callerWithDb(db).updateMyClinicalProfile({
        isVeterinarian: true,
        licenseNumber: "CO-1234",
      }),
    ).resolves.toEqual(profile);
    expect(updateSet).toHaveBeenCalledWith({
      isVeterinarian: true,
      licenseNumber: "CO-1234",
      locationId: primaryLocationId,
    });
  });

  it("requires active appointments to be reassigned before provider access is removed", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: USER_ID, isVeterinarian: true, locationId: ROOM_ID }],
        [{ id: APPOINTMENT_ID }],
      ],
    });

    await expect(
      callerWithDb(db).updateMyClinicalProfile({ isVeterinarian: false }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message:
        "Reassign active appointments before removing veterinarian provider access.",
    });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("keeps veterinarian authorization roles clinically eligible", async () => {
    const { db, updateSet } = createDb();

    await expect(
      callerWithDb(db).updateUser({
        id: STAFF_ID,
        role: "veterinarian",
        isVeterinarian: false,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("validates practice timezone strings through the shared settings policy", () => {
    expect(isSupportedPracticeTimezone("America/New_York")).toBe(true);
    expect(isSupportedPracticeTimezone(" Europe/London ")).toBe(true);
    expect(isSupportedPracticeTimezone("")).toBe(false);
    expect(isSupportedPracticeTimezone("Mars/Olympus_Mons")).toBe(false);
  });

  it("records explicit jurisdiction without clobbering other settings", () => {
    const updatePracticeBlock = SETTINGS_SOURCE.match(
      /updatePractice:[\s\S]+?setMarketingEmailPreference:/,
    )?.[0];
    const getPracticeBlock = SETTINGS_SOURCE.match(
      /getPractice:[\s\S]+?getMarketingEmailPreference:/,
    )?.[0];

    expect(SETTINGS_SOURCE).toContain("settingsAndOnboardingStateMergePatch");
    expect(updatePracticeBlock).toContain("explicitJurisdictionState(");
    expect(updatePracticeBlock).toContain('jurisdictionSource ?? "settings"');
    expect(updatePracticeBlock).toContain("settingsPatch,");
    expect(updatePracticeBlock).toContain("jurisdictionPatch,");
    expect(getPracticeBlock).toContain("hasExplicitPracticeJurisdiction(");
    expect(getPracticeBlock).toContain("jurisdictionConfirmed:");
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
      callerWithDb(db).getAccountDeletionRequest(),
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
      callerWithDb(db).updatePractice({ name: "Neighborhood Veterinary" }),
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
        ?.length ?? 0,
    ).toBeGreaterThanOrEqual(15);
    expect(SETTINGS_SOURCE).not.toContain("practice?.settings ?? {}");
    expect(SETTINGS_SOURCE).not.toContain('practice?.name ?? "OpenVPM"');
  });

  it("rejects stale staff updates with a typed not-found error", async () => {
    const { db, updateSet } = createDb({ updatedRows: [] });

    await expect(
      callerWithDb(db).updateUser({ id: STAFF_ID, name: "Taylor" }),
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
      }),
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
      }),
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
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("does not create or deliver a staff invite while the practice is held", async () => {
    mocks.lockPracticeForExternalSideEffects.mockResolvedValueOnce(false);
    const { db, insertValues } = createDb({
      selectResults: [[{ name: "Neighborhood Veterinary" }]],
    });

    await expect(
      callerWithDb(db).inviteStaff({
        email: "held-invite@example.com",
        role: "front_desk",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(insertValues).not.toHaveBeenCalled();
    expect(mocks.createAuthToken).not.toHaveBeenCalled();
    expect(mocks.sendStaffInviteEmail).not.toHaveBeenCalled();
  });

  it("reports provider refusal and safely retries the same pending staff invite", async () => {
    const invitedUser = {
      id: STAFF_ID,
      email: "invite@example.com",
      practiceId: PRACTICE_ID,
      emailVerifiedAt: null,
      deletedAt: null,
    };
    const { db, execute, insertValues } = createDb({
      selectResults: [
        [{ name: "Neighborhood Veterinary" }],
        [],
        [{ name: "Neighborhood Veterinary" }],
        [invitedUser],
        [{ id: "previous-invite-token" }],
      ],
      insertedRows: [invitedUser],
    });
    mocks.sendStaffInviteEmail
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: true });
    mocks.createAuthToken
      .mockResolvedValueOnce("first-invite-token")
      .mockResolvedValueOnce("retry-invite-token");

    await expect(
      callerWithDb(db).inviteStaff({
        email: invitedUser.email,
        role: "front_desk",
      }),
    ).rejects.toMatchObject({
      code: "BAD_GATEWAY",
      message:
        "Staff access was saved, but the invitation email could not be sent. Please retry the invite in a moment.",
    });

    await expect(
      callerWithDb(db).inviteStaff({
        email: invitedUser.email,
        role: "front_desk",
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(mocks.sendStaffInviteEmail).toHaveBeenCalledTimes(2);
    expect(mocks.sendStaffInviteEmail).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        inviteUrl:
          "http://localhost:3000/accept-invite?token=retry-invite-token",
      }),
    );
    expect(mocks.createAuthToken).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(syncPracticeSubscriptionQuantities).toHaveBeenCalledTimes(2);
  });

  it("keeps staff identity and token issuance atomic when token storage fails", async () => {
    const invitedUser = {
      id: STAFF_ID,
      email: "invite@example.com",
    };
    const { db, transaction, execute } = createDb({
      selectResults: [[{ name: "Neighborhood Veterinary" }], []],
      insertedRows: [invitedUser],
    });
    mocks.createAuthToken.mockRejectedValueOnce(
      new Error("token-storage-secret"),
    );

    await expect(
      callerWithDb(db).inviteStaff({
        email: invitedUser.email,
        role: "front_desk",
      }),
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: expect.not.stringContaining("token-storage-secret"),
    });

    expect(transaction).toHaveBeenCalled();
    expect(execute).toHaveBeenCalled();
    expect(mocks.sendStaffInviteEmail).not.toHaveBeenCalled();
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
    expect(SETTINGS_SOURCE).toMatch(/staffInviteLockKey\(\s*email,\s*\)/);
    expect(SETTINGS_SOURCE).toContain("db: tx as unknown as Database");
  });

  it("does not treat an ordinary unverified user as a pending invite retry", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [{ name: "Neighborhood Veterinary" }],
        [
          {
            id: STAFF_ID,
            email: "existing@example.com",
            practiceId: PRACTICE_ID,
            emailVerifiedAt: null,
            deletedAt: null,
          },
        ],
        [],
      ],
    });

    await expect(
      callerWithDb(db).inviteStaff({
        email: "existing@example.com",
        role: "front_desk",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(insertValues).not.toHaveBeenCalled();
    expect(mocks.createAuthToken).not.toHaveBeenCalled();
    expect(mocks.sendStaffInviteEmail).not.toHaveBeenCalled();
  });

  it("sanitizes thrown invitation-provider errors", async () => {
    const invitedUser = {
      id: STAFF_ID,
      email: "invite@example.com",
    };
    const { db } = createDb({
      selectResults: [[{ name: "Neighborhood Veterinary" }], []],
      insertedRows: [invitedUser],
    });
    mocks.sendStaffInviteEmail.mockRejectedValueOnce(
      new Error("provider-secret-response"),
    );

    await expect(
      callerWithDb(db).inviteStaff({
        email: invitedUser.email,
        role: "front_desk",
      }),
    ).rejects.toMatchObject({
      code: "BAD_GATEWAY",
      message: expect.not.stringContaining("provider-secret-response"),
    });
  });

  it("requires an active practice for staff reads, writes, and deactivation dependencies", () => {
    const staffBlock = SETTINGS_SOURCE.match(
      /\/\/ ── Staff \/ Users[\s\S]+?\/\/ ── Appointment Types/,
    )?.[0];

    expect(staffBlock).toContain("await assertActivePractice(ctx)");
    expect(
      staffBlock?.match(/activePracticePredicate\(ctx\.practiceId\)/g)
        ?.length ?? 0,
    ).toBeGreaterThanOrEqual(10);
    expect(staffBlock).toMatch(
      /eq\(users\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(users\.deletedAt\)/,
    );
    expect(staffBlock).toMatch(
      /eq\(appointments\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(appointments\.deletedAt\)/,
    );
    expect(staffBlock).toMatch(
      /eq\(staffSchedules\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(staffSchedules\.deletedAt\)/,
    );
    expect(staffBlock).toContain("activePracticeWhere(ctx.practiceId)");
    expect(staffBlock).toContain("eq(users.role, targetUser.role)");
  });

  it("rejects demoting the last active admin", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: STAFF_ID, role: "admin" }], []],
    });

    await expect(
      callerWithDb(db).updateUser({ id: STAFF_ID, role: "viewer" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.execute).toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("allows admin demotion when another active admin remains", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: STAFF_ID, role: "admin" }], [{ id: USER_ID }]],
      updatedRows: [{ id: STAFF_ID, role: "viewer" }],
    });

    await expect(
      callerWithDb(db).updateUser({ id: STAFF_ID, role: "viewer" }),
    ).resolves.toMatchObject({ id: STAFF_ID, role: "viewer" });

    expect(db.execute).toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith({ role: "viewer" });
  });

  it("rejects stale staff role demotions", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: STAFF_ID, role: "admin" }], [{ id: USER_ID }]],
      updatedRows: [],
    });

    await expect(
      callerWithDb(db).updateUser({ id: STAFF_ID, role: "viewer" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(db.execute).toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith({ role: "viewer" });
  });

  it("rejects self-deactivation before DB work", async () => {
    const { db, updateSet } = createDb();

    await expect(
      callerWithDb(db).deactivateUser({ id: USER_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("does not sync billing after stale staff deactivation", async () => {
    const { db, updateSet } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).deactivateUser({ id: STAFF_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("rejects deactivating the last active admin", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: STAFF_ID, role: "admin" }], []],
    });

    await expect(
      callerWithDb(db).deactivateUser({ id: STAFF_ID }),
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
      callerWithDb(db).deactivateUser({ id: STAFF_ID }),
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
      callerWithDb(db).deactivateUser({ id: STAFF_ID }),
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
      callerWithDb(db).deactivateUser({ id: STAFF_ID }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(db.execute).toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith({ deletedAt: expect.any(Date) });
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("does not sync billing after stale staff restore", async () => {
    const { db, updateSet } = createDb({ updatedRows: [] });

    await expect(
      callerWithDb(db).restoreUser({ id: STAFF_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).toHaveBeenCalledWith({ deletedAt: null });
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("rejects appointment type and room list/create when the practice is missing or deleted", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[], [], [], []],
    });

    await expect(callerWithDb(db).listAppointmentTypes()).rejects.toMatchObject(
      {
        code: "NOT_FOUND",
        message: "Practice not found",
      },
    );

    await expect(
      callerWithDb(db).createAppointmentType({
        name: "Consultation",
        durationMinutes: 30,
        color: "#1a8f8a",
      }),
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
        locationId: LOCATION_ID,
      }),
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
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).toHaveBeenCalledWith({ name: "Surgery" });
  });

  it("rejects stale appointment type deletes", async () => {
    const { db, updateSet } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).deleteAppointmentType({ id: TYPE_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects appointment type deletes when active appointments use the type", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: TYPE_ID }], [{ id: APPOINTMENT_ID }]],
    });

    await expect(
      callerWithDb(db).deleteAppointmentType({ id: TYPE_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects appointment type deletes when waiting requests use the type", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: TYPE_ID }], [], [{ id: WAITLIST_ID }]],
    });

    await expect(
      callerWithDb(db).deleteAppointmentType({ id: TYPE_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("soft-deletes appointment types without active scheduling dependencies", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: TYPE_ID }], [], []],
      updatedRows: [{ id: TYPE_ID }],
    });

    await expect(
      callerWithDb(db).deleteAppointmentType({ id: TYPE_ID }),
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
      callerWithDb(db).deleteAppointmentType({ id: TYPE_ID }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("appointment request page"),
    });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects stale room deletes", async () => {
    const { db, updateSet } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).deleteRoom({ id: ROOM_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects room deletes when active appointments use the room", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: ROOM_ID }], [{ id: APPOINTMENT_ID }]],
    });

    await expect(
      callerWithDb(db).deleteRoom({ id: ROOM_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("soft-deletes rooms without active appointments", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: ROOM_ID }], []],
      updatedRows: [{ id: ROOM_ID }],
    });

    await expect(callerWithDb(db).deleteRoom({ id: ROOM_ID })).resolves.toEqual(
      { success: true },
    );

    expect(updateSet).toHaveBeenCalledWith({ deletedAt: expect.any(Date) });
  });
});

describe("settings demo data cleanup scoping", () => {
  it("scopes invoice-item cleanup through current-practice invoices", () => {
    const invoiceItemBlock = DEMO_DATA_LIFECYCLE_SOURCE.match(
      /\.update\(invoiceItems\)[\s\S]+?if \(demo\.invoiceIds/,
    )?.[0];

    expect(invoiceItemBlock).toContain(
      "inArray(invoiceItems.id, demo.invoiceItemIds)",
    );
    expect(invoiceItemBlock).toContain("from ${invoices}");
    expect(invoiceItemBlock).toContain(
      "${invoices.id} = ${invoiceItems.invoiceId}",
    );
    expect(invoiceItemBlock).toContain(
      "${invoices.practiceId} = ${practiceId}",
    );
  });

  it("preserves attribution while clearing stored and discovered demo SOAPs", () => {
    expect(DEMO_DATA_LIFECYCLE_SOURCE).toContain("let demoSoapNoteIds");
    expect(DEMO_DATA_LIFECYCLE_SOURCE).toContain("const storedDemoSoapNoteIds");
    expect(DEMO_DATA_LIFECYCLE_SOURCE).toContain(
      "const discoveredDemoSoapNotes",
    );
    expect(DEMO_DATA_LIFECYCLE_SOURCE).toContain("storedDemoSoapNoteIds,");
    expect(DEMO_DATA_LIFECYCLE_SOURCE).toContain("discoveredDemoSoapNotes.map");
    expect(DEMO_DATA_LIFECYCLE_SOURCE).toContain(
      "inArray(soapNotes.appointmentId, demo.appointmentIds)",
    );
    expect(DEMO_DATA_LIFECYCLE_SOURCE).toContain(
      "inArray(soapNotes.patientId, demo.patientIds)",
    );
    expect(DEMO_DATA_LIFECYCLE_SOURCE).toContain(
      "soapNoteIds: demoSoapNoteIds",
    );
    expect(DEMO_DATA_LIFECYCLE_SOURCE).toContain(
      "clearedAt: now.toISOString()",
    );
    expect(DEMO_DATA_LIFECYCLE_SOURCE).toContain(
      "inArray(soapNotes.id, demoSoapNoteIds)",
    );
    expect(DEMO_DATA_LIFECYCLE_SOURCE).not.toContain("settingsRemoveKey");
  });

  it("serializes clear and reseed and delegates both mutations", () => {
    expect(DEMO_DATA_LIFECYCLE_SOURCE).toContain("pg_advisory_xact_lock");
    expect(DEMO_DATA_LIFECYCLE_SOURCE).toContain('.for("update")');
    expect(DEMO_DATA_LIFECYCLE_SOURCE).toContain(
      "const latest = await seedDemoData(tx, { practiceId })",
    );
    expect(SETTINGS_SOURCE).toContain(
      "clearSeededDemoData(ctx.db, ctx.practiceId)",
    );
    expect(SETTINGS_SOURCE).toContain(
      "reseedSampleClinic(ctx.db, ctx.practiceId)",
    );
  });
});

describe("settings scheduling metadata delete safety", () => {
  it("requires an active practice for appointment type and room reads and writes", () => {
    const appointmentTypeBlock = SETTINGS_SOURCE.match(
      /\/\/ ── Appointment Types[\s\S]+?\/\/ ── Rooms/,
    )?.[0];
    const roomBlock = SETTINGS_SOURCE.match(
      /\/\/ ── Rooms[\s\S]+?\n\s*\}\),\n\}\);/,
    )?.[0];

    expect(appointmentTypeBlock).toContain("await assertActivePractice(ctx)");
    expect(
      appointmentTypeBlock?.match(/activePracticePredicate\(ctx\.practiceId\)/g)
        ?.length ?? 0,
    ).toBeGreaterThanOrEqual(6);
    expect(appointmentTypeBlock).toMatch(
      /eq\(appointmentTypes\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(appointmentTypes\.deletedAt\)/,
    );
    expect(appointmentTypeBlock).toMatch(
      /eq\(appointmentWaitlist\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+eq\(appointmentWaitlist\.status, "waiting"\)/,
    );

    expect(roomBlock).toContain("await assertActivePractice(ctx)");
    expect(
      roomBlock?.match(/activePracticePredicate\(ctx\.practiceId\)/g)?.length ??
        0,
    ).toBeGreaterThanOrEqual(4);
    expect(roomBlock).toMatch(
      /eq\(rooms\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(rooms\.deletedAt\)/,
    );
  });

  it("guards appointment type and room deletes with tenant-scoped active scheduling checks", () => {
    const appointmentTypeDeleteBlock = SETTINGS_SOURCE.match(
      /deleteAppointmentType:[\s\S]+?\/\/ ── Rooms/,
    )?.[0];
    const roomDeleteBlock = SETTINGS_SOURCE.match(
      /deleteRoom:[\s\S]+?\n\s*\}\),\n\}\);/,
    )?.[0];

    expect(appointmentTypeDeleteBlock).toContain(
      "eq(appointments.typeId, input.id)",
    );
    expect(appointmentTypeDeleteBlock).toContain(
      "eq(appointments.practiceId, ctx.practiceId)",
    );
    expect(appointmentTypeDeleteBlock).toContain(
      "activePracticePredicate(ctx.practiceId)",
    );
    expect(appointmentTypeDeleteBlock).toContain(
      "inArray(appointments.status, activeSchedulingStatuses)",
    );
    expect(appointmentTypeDeleteBlock).toContain(
      "eq(appointmentWaitlist.typeId, input.id)",
    );
    expect(appointmentTypeDeleteBlock).toContain(
      "eq(appointmentWaitlist.practiceId, ctx.practiceId)",
    );
    expect(appointmentTypeDeleteBlock).toContain(
      "activePracticePredicate(ctx.practiceId)",
    );
    expect(appointmentTypeDeleteBlock).toContain(
      'eq(appointmentWaitlist.status, "waiting")',
    );
    expect(appointmentTypeDeleteBlock).toContain('.for("update")');
    expect(appointmentTypeDeleteBlock).toContain(
      "parseBookingPageConfig(publishedPage.config)",
    );

    expect(roomDeleteBlock).toContain("eq(appointments.roomId, input.id)");
    expect(roomDeleteBlock).toContain(
      "eq(appointments.practiceId, ctx.practiceId)",
    );
    expect(roomDeleteBlock).toContain(
      "activePracticePredicate(ctx.practiceId)",
    );
    expect(roomDeleteBlock).toContain(
      "inArray(appointments.status, activeSchedulingStatuses)",
    );
  });

  it("guards staff deactivation with admin and active appointment checks", () => {
    const deactivateBlock = SETTINGS_SOURCE.match(
      /deactivateUser:[\s\S]+?restoreUser:/,
    )?.[0];

    expect(deactivateBlock).toContain("input.id === ctx.user.id");
    expect(deactivateBlock).toContain("pg_advisory_xact_lock");
    expect(deactivateBlock).toContain('targetUser.role === "admin"');
    expect(deactivateBlock).toContain('eq(users.role, "admin")');
    expect(deactivateBlock).toContain("ne(users.id, input.id)");
    expect(deactivateBlock).toContain("eq(users.role, targetUser.role)");
    expect(deactivateBlock).toContain("eq(appointments.doctorId, input.id)");
    expect(deactivateBlock).toContain(
      "eq(appointments.practiceId, ctx.practiceId)",
    );
    expect(deactivateBlock).toContain(
      "inArray(appointments.status, activeSchedulingStatuses)",
    );
    expect(deactivateBlock).toContain("eq(staffSchedules.userId, input.id)");
    expect(deactivateBlock).toContain(
      "eq(staffSchedules.practiceId, ctx.practiceId)",
    );
    expect(deactivateBlock).toContain("isNull(staffSchedules.deletedAt)");
  });

  it("guards staff role demotions with an admin roster lock", () => {
    const updateUserBlock = SETTINGS_SOURCE.match(
      /updateUser:[\s\S]+?deactivateUser:/,
    )?.[0];

    expect(updateUserBlock).toContain('data.role !== "admin"');
    expect(updateUserBlock).toContain("pg_advisory_xact_lock");
    expect(updateUserBlock).toContain('targetUser.role === "admin"');
    expect(updateUserBlock).toContain('eq(users.role, "admin")');
    expect(updateUserBlock).toContain("ne(users.id, id)");
    expect(updateUserBlock).toContain("eq(users.role, targetUser.role)");
  });
});
