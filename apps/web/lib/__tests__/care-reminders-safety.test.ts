import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("care reminder safety contract", () => {
  const schema = read("../../packages/db/schema/care-reminders.ts");
  const rls = read("../../packages/db/rls/enable-rls.sql");
  const router = read("server/routers/care-reminders.ts");
  const outreach = read("server/care-reminder-outreach.ts");
  const page = read("app/(dashboard)/care-reminders/page.tsx");
  const bulkPage = read("app/(dashboard)/care-reminders/bulk-outreach.tsx");

  it("binds reminders, actors, and import identities to one tenant", () => {
    expect(schema).toContain("care_reminders_patient_tenant_fk");
    expect(schema).toContain("care_reminders_creator_tenant_fk");
    expect(schema).toContain("care_reminders_completer_tenant_fk");
    expect(schema).toContain("care_reminders_dismisser_tenant_fk");
    expect(schema).toContain("care_reminders_external_id_uq");
    expect(schema).toContain("care_reminders_import_fingerprint_uq");
    expect(rls).toMatch(/'capture_sessions','care_reminders','cases'/);
  });

  it("keeps completion and dismissal states coherent", () => {
    expect(schema).toContain("care_reminders_state_check");
    expect(schema).toContain("= 'dismissed'");
    expect(schema).toContain("care_reminders_dismissal_reason_check");
    expect(router).toContain("setCompleted");
    expect(router).toContain("setDismissed");
    expect(router).toContain(".max(100)");
    expect(router).toContain('.for("update")');
    expect(router).not.toContain(
      "eq(careReminders.updatedAt, current.updatedAt)",
    );
    expect(page).toMatch(/never sends an\s+email or text automatically/);
  });

  it("keeps client outreach deliberate, templated, and safeguarded", () => {
    expect(page).toContain("trpc.careReminders.sendOutreach.useMutation");
    expect(page).toContain("outreachRequestId.current ??= crypto.randomUUID()");
    expect(page).toContain("clientSmsConsent");
    expect(page).toContain("Template preview");
    expect(page).toContain("generated server-side");
    expect(page).toContain(
      "Email suppression, SMS consent, sender, and quiet-hour",
    );
    expect(router).toContain("sendOutreach: manageProcedure");
    expect(router).toContain("deliverCareReminderOutreach");
    expect(router).toContain("previewBulkOutreach: manageProcedure");
    expect(router).toContain("sendBulkOutreach: manageProcedure");
    expect(outreach).toContain('operation: "care_reminder"');
    expect(outreach).toContain("sendCareReminder(");
    expect(outreach).toContain("sendCareReminderSms(");
    expect(outreach).toContain("withDurableSmsCommunication");
    expect(outreach).toContain("ctx.db.transaction(async (tx)");
    expect(outreach).toContain("lockPracticeForExternalSideEffects");
    expect(outreach).toContain("emailSuppressionSendBlockMessage");
    expect(outreach).toContain("recordAuditLog");
    expect(outreach).toContain("rateLimit(");
    expect(outreach).toContain("clientSmsConsent !== true");
    expect(bulkPage).toContain("Select all matching");
    expect(bulkPage).toContain("window.confirm(");
    expect(bulkPage).toContain("data-testid=\"bulk-block-reason\"");
    expect(page).toContain("CareReminderBulkOutreach");
    const outreachSchema = router.slice(
      router.indexOf("const outreachInput"),
      router.indexOf("const dismissalInput"),
    );
    expect(outreachSchema).not.toContain("content:");
    expect(outreachSchema).not.toContain("subject:");
    expect(page).not.toContain("useEffect(() => sendOutreach");
  });

  it("surfaces the reusable queue in the navigation catalog", () => {
    expect(read("lib/navigation.ts")).toContain(
      'href: "/care-reminders"',
    );
    expect(read("components/common/command-search.tsx")).toContain(
      'href: "/care-reminders"',
    );
    expect(read("components/layout/top-bar.tsx")).toContain(
      '"/care-reminders": "Care Reminders"',
    );
  });
});
