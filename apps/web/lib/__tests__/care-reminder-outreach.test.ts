import { afterEach, describe, expect, it } from "vitest";
import { speciesEnum } from "@openpims/db";
import { CARE_REMINDER_SPECIES } from "../care-reminder-species";
import { vaccinationRecallPracticeSettings } from "../vaccination-recalls";
import {
  bulkCareReminderRequestId,
  careReminderBulkBatchesPerHour,
  careReminderBulkMaxBatch,
  careReminderBulkRateLimitKey,
  careReminderOutreachCopy,
  careReminderOutreachDedupeKey,
  DEFAULT_CARE_REMINDER_BULK_BATCHES_PER_HOUR,
  DEFAULT_CARE_REMINDER_BULK_MAX_BATCH,
  evaluateCareReminderOutreach,
  reminderMatchesBulkFilters,
  type BulkOutreachFilters,
  type CareReminderOutreachCandidate,
} from "../care-reminder-outreach";

const PRACTICE_ID = "00000000-0000-4000-8000-0000000000aa";
const OTHER_PRACTICE_ID = "00000000-0000-4000-8000-0000000000bb";
const REMINDER_ID = "00000000-0000-4000-8000-0000000000cc";
const PATIENT_ID = "00000000-0000-4000-8000-0000000000dd";
const CLIENT_ID = "00000000-0000-4000-8000-0000000000ee";

const baseFilters: BulkOutreachFilters = {
  due: "overdue",
  lastContacted: "any",
  channel: "auto",
};

function candidate(
  overrides: Partial<CareReminderOutreachCandidate> = {},
): CareReminderOutreachCandidate {
  return {
    reminderId: REMINDER_ID,
    practiceId: PRACTICE_ID,
    status: "open",
    title: "Dental recheck",
    dueDate: "2026-01-01",
    imported: false,
    patientId: PATIENT_ID,
    patientName: "River",
    patientStatus: "active",
    species: "canine",
    clientId: CLIENT_ID,
    clientName: "Ada Lovelace",
    clientEmail: "ada@river-clinic.com",
    clientPhone: "+14155551212",
    preferredContactMethod: "email",
    smsConsent: false,
    emailSuppressionReason: null,
    lastContactedAt: null,
    ...overrides,
  };
}

function evaluate(
  overrides: Partial<CareReminderOutreachCandidate> = {},
  options: Partial<Parameters<typeof evaluateCareReminderOutreach>[0]> = {},
) {
  return evaluateCareReminderOutreach({
    practiceId: PRACTICE_ID,
    candidate: candidate(overrides),
    channelPreference: "auto",
    quietHours: false,
    smsSenderAvailable: true,
    smsSuppressedPhones: new Set(),
    practiceSettings: vaccinationRecallPracticeSettings({}),
    ...options,
  });
}

afterEach(() => {
  delete process.env.CARE_REMINDER_BULK_MAX_BATCH;
  delete process.env.CARE_REMINDER_BULK_BATCHES_PER_HOUR;
});

describe("care reminder bulk policy", () => {
  it("keeps the species filter aligned with the patient chart", () => {
    expect([...CARE_REMINDER_SPECIES]).toEqual([...speciesEnum.enumValues]);
  });

  it("uses a conservative per-clinic batch size and hourly bucket", () => {
    expect(careReminderBulkMaxBatch()).toBe(DEFAULT_CARE_REMINDER_BULK_MAX_BATCH);
    expect(careReminderBulkMaxBatch()).toBe(200);
    expect(careReminderBulkBatchesPerHour()).toBe(
      DEFAULT_CARE_REMINDER_BULK_BATCHES_PER_HOUR,
    );
    expect(careReminderBulkRateLimitKey(PRACTICE_ID)).not.toBe(
      careReminderBulkRateLimitKey(OTHER_PRACTICE_ID),
    );
    process.env.CARE_REMINDER_BULK_MAX_BATCH = "1000";
    process.env.CARE_REMINDER_BULK_BATCHES_PER_HOUR = "0";
    expect(careReminderBulkMaxBatch()).toBe(200);
    expect(careReminderBulkBatchesPerHour()).toBe(4);
    process.env.CARE_REMINDER_BULK_MAX_BATCH = "50";
    expect(careReminderBulkMaxBatch()).toBe(50);
  });

  it("sends email when that is the deliverable channel", () => {
    const decision = evaluate();
    expect(decision.status).toBe("eligible");
    expect(decision.channel).toBe("email");
  });

  it("texts only when the client currently consents", () => {
    expect(
      evaluate(
        {
          preferredContactMethod: "sms",
          smsConsent: true,
          clientEmail: null,
        },
        { channelPreference: "sms" },
      ),
    ).toMatchObject({ status: "eligible", channel: "sms" });

    expect(
      evaluate(
        {
          preferredContactMethod: "sms",
          smsConsent: false,
          clientEmail: null,
        },
        { channelPreference: "sms" },
      ),
    ).toMatchObject({
      status: "blocked",
      channel: null,
      blockReason: "missing_sms_consent",
    });
  });

  it("does not treat an imported reminder as SMS consent", () => {
    const decision = evaluate(
      {
        imported: true,
        preferredContactMethod: "sms",
        smsConsent: false,
        clientEmail: null,
      },
      { channelPreference: "sms" },
    );
    expect(decision.status).toBe("blocked");
    expect(decision.blockReason).toBe("missing_sms_consent");
    expect(decision.channel).toBeNull();
    expect(decision.blockMessage).toMatch(/do not add consent/i);
  });

  it("can text an imported reminder when the client has current consent", () => {
    expect(
      evaluate(
        {
          imported: true,
          preferredContactMethod: "sms",
          smsConsent: true,
          clientEmail: null,
        },
        { channelPreference: "sms" },
      ).channel,
    ).toBe("sms");
  });

  it("falls back to email during quiet hours and blocks a text-only request", () => {
    expect(
      evaluate(
        { preferredContactMethod: "sms", smsConsent: true },
        { quietHours: true },
      ).channel,
    ).toBe("email");
    expect(
      evaluate(
        { preferredContactMethod: "sms", smsConsent: true, clientEmail: null },
        { quietHours: true, channelPreference: "sms" },
      ),
    ).toMatchObject({ status: "blocked", blockReason: "quiet_hours" });
  });

  it("blocks suppressed email, suppressed texts, and another clinic's reminder", () => {
    expect(
      evaluate({ emailSuppressionReason: "bounce", clientPhone: null }),
    ).toMatchObject({ status: "blocked", blockReason: "email_suppressed" });
    expect(
      evaluate(
        {
          preferredContactMethod: "sms",
          smsConsent: true,
          clientEmail: null,
        },
        { smsSuppressedPhones: new Set(["+14155551212"]) },
      ),
    ).toMatchObject({ status: "blocked", blockReason: "sms_suppressed" });
    expect(
      evaluate({ practiceId: OTHER_PRACTICE_ID }).blockReason,
    ).toBe("cross_practice");
  });

  it("dedupes a live send of the same wording and allows a changed title", () => {
    const first = evaluate();
    expect(first.dedupeKey).toBeTruthy();
    const again = evaluate(
      {},
      {
        existingSend: {
          status: "sent",
          createdAt: new Date("2026-02-01T15:00:00.000Z"),
        },
      },
    );
    expect(again.status).toBe("already_sent");
    expect(again.dedupeKey).toBe(first.dedupeKey);

    const retitled = evaluate({ title: "Dental recheck, second notice" });
    expect(retitled.status).toBe("eligible");
    expect(retitled.dedupeKey).not.toBe(first.dedupeKey);
  });

  it("filters by due date, title, species, and last contact", () => {
    const row = {
      dueDate: "2026-01-01",
      title: "Heartworm refill",
      species: "feline",
      lastContactedAt: new Date("2026-03-02T18:00:00.000Z"),
    };
    expect(
      reminderMatchesBulkFilters(row, baseFilters, "2026-11-19", "UTC"),
    ).toBe(true);
    expect(
      reminderMatchesBulkFilters(
        row,
        { ...baseFilters, due: "range", dueFrom: "2026-02-01", dueTo: "2026-02-28" },
        "2026-11-19",
      ),
    ).toBe(false);
    expect(
      reminderMatchesBulkFilters(
        row,
        { ...baseFilters, title: "heartworm" },
        "2026-11-19",
      ),
    ).toBe(true);
    expect(
      reminderMatchesBulkFilters(
        row,
        { ...baseFilters, title: "dental" },
        "2026-11-19",
      ),
    ).toBe(false);
    expect(
      reminderMatchesBulkFilters(
        row,
        { ...baseFilters, species: "canine" },
        "2026-11-19",
      ),
    ).toBe(false);
    expect(
      reminderMatchesBulkFilters(
        row,
        { ...baseFilters, species: "feline" },
        "2026-11-19",
      ),
    ).toBe(true);
    expect(
      reminderMatchesBulkFilters(
        { ...row, lastContactedAt: null },
        { ...baseFilters, lastContacted: "never" },
        "2026-11-19",
      ),
    ).toBe(true);
    expect(
      reminderMatchesBulkFilters(
        row,
        {
          ...baseFilters,
          lastContacted: "before",
          lastContactedBefore: "2026-03-01",
        },
        "2026-11-19",
        "UTC",
      ),
    ).toBe(false);
    expect(
      reminderMatchesBulkFilters(
        row,
        {
          ...baseFilters,
          lastContacted: "before",
          lastContactedBefore: "2026-03-03",
        },
        "2026-11-19",
        "UTC",
      ),
    ).toBe(true);
  });

  it("builds one dedupe key for one wording", () => {
    const copy = careReminderOutreachCopy({
      clientName: "Ada Lovelace",
      patientName: "River",
      title: "Dental recheck",
      dueDate: "2026-01-01",
    });
    const requestId = bulkCareReminderRequestId({
      reminderId: REMINDER_ID,
      channel: "email",
      subject: copy.subject,
      content: copy.content,
    });
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(
      careReminderOutreachDedupeKey(PRACTICE_ID, "email", requestId),
    ).toContain(PRACTICE_ID);
    expect(
      bulkCareReminderRequestId({
        reminderId: REMINDER_ID,
        channel: "email",
        subject: copy.subject,
        content: copy.content,
      }),
    ).toBe(requestId);
  });
});
