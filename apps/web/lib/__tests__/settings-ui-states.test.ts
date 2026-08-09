import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
} from "../auth-password-policy";
import {
  PRACTICE_BACKUP_JSON_MAX_BYTES,
  isPracticeBackupJsonSizeValid,
} from "../backup/policy";
import { IMPORT_CSV_MAX_BYTES, isImportCsvSizeValid } from "../import/policy";
import {
  ACCOUNT_DELETION_REASON_MAX_LENGTH,
  APPOINTMENT_TYPE_DURATION_MAX_MINUTES,
  APPOINTMENT_TYPE_DURATION_MIN_MINUTES,
  APPOINTMENT_TYPE_NAME_MAX_LENGTH,
  LOCATION_NAME_MAX_LENGTH,
  PRACTICE_NAME_MAX_LENGTH,
  ROOM_NAME_MAX_LENGTH,
  SETTINGS_ADDRESS_MAX_LENGTH,
  SETTINGS_EMAIL_MAX_LENGTH,
  SETTINGS_PHONE_MAX_LENGTH,
  SETTINGS_TIMEZONE_MAX_LENGTH,
  SETTINGS_VAT_NUMBER_MAX_LENGTH,
  SETTINGS_WEBSITE_MAX_LENGTH,
  STAFF_LICENSE_NUMBER_MAX_LENGTH,
  STAFF_NAME_MAX_LENGTH,
  isValidSettingsTaxRate,
  isSupportedPracticeTimezone,
} from "../settings-policy";

describe("settings UI states", () => {
  const source = readFileSync("app/(dashboard)/settings/page.tsx", "utf8");

  it("checks settings access before rendering admin-only tabs", () => {
    expect(source).toContain("const { data: session, status } = useSession()");
    expect(source).toContain('if (status === "loading")');
    expect(source).toContain("Checking settings access...");
    expect(source).toContain('if (session?.user?.role !== "admin")');
    expect(source).toContain(
      "Only administrators can access practice settings.",
    );
    expect(source.indexOf('if (status === "loading")')).toBeLessThan(
      source.indexOf('if (session?.user?.role !== "admin")'),
    );
    expect(source.indexOf('if (session?.user?.role !== "admin")')).toBeLessThan(
      source.indexOf('{activeTab === "practice" && <PracticeInfoTab />}'),
    );
  });

  it("surfaces query failures in core settings tabs", () => {
    const billingTab = source.slice(
      source.indexOf("function BillingTab"),
      source.indexOf("function PlanGrid"),
    );

    expect(source).toContain(
      'import { EmptyState } from "@/components/common/empty-state"',
    );
    expect(source).toContain("function SettingsLoadError");
    expect(source).toContain("error: practiceError");
    expect(source).toContain("error: locationsError");
    expect(source).toContain("error: staffError");
    expect(source).toContain("error: appointmentTypesError");
    expect(source).toContain("error: roomsError");
    expect(source).toContain("error: wellnessError");
    expect(source).toContain("error: templatesError");
    expect(source).toContain("error: selectedTemplateError");
    expect(source).toContain("error: billingError");
    expect(source).toContain('title="Could not load billing details"');
    expect(source).toContain("onRetry={() => void refetchBilling()}");
    expect(source).toContain(
      'import { isSafeCheckoutRedirectUrl } from "@/lib/checkout-redirect"',
    );
    expect(source).toContain("function redirectToHostedBillingUrl");
    expect(source).toContain("if (!isSafeCheckoutRedirectUrl(url))");
    expect(source).toContain("redirectToHostedBillingUrl(r.url)");
    expect(source).not.toContain("if (r.url) window.location.href = r.url");
    expect(billingTab.indexOf("if (billingError)")).toBeLessThan(
      billingTab.indexOf("if (isLoading)"),
    );
    expect(billingTab.indexOf("if (isLoading)")).toBeLessThan(
      billingTab.indexOf("if (!data)"),
    );
    expect(billingTab).toContain(
      "The billing details request finished without returning data. Try loading it again.",
    );
    expect(billingTab).not.toContain("if (isLoading || !data)");
  });

  it("uses the public support address for enterprise contact links", () => {
    expect(source).toContain(
      "mailto:support@openvpm.com?subject=OpenVPM%20Enterprise",
    );
    expect(source).not.toContain("mailto:evan@openvpm.com");
  });

  it("uses shared empty states for first-run settings panels", () => {
    expect(source).toContain('title="Practice settings unavailable"');
    expect(source).toContain('title="No active locations configured"');
    expect(source).toContain('title="No staff members found"');
    expect(source).toContain('title="No appointment types configured"');
    expect(source).toContain('title="No rooms configured"');
    expect(source).toContain('title="No wellness plans configured"');
    expect(source).toContain('title="No items in this template"');
    expect(source).toContain('title="No templates configured"');
  });

  it("builds the practice form only after a practice profile is present", () => {
    const practiceTab = source.slice(
      source.indexOf("function PracticeInfoTab"),
      source.indexOf("// ── Locations"),
    );

    expect(practiceTab).toContain('title="Practice settings unavailable"');
    expect(practiceTab.indexOf("if (!practice)")).toBeLessThan(
      practiceTab.indexOf("const currentBrandColor"),
    );
    expect(practiceTab.indexOf("if (!practice)")).toBeLessThan(
      practiceTab.indexOf("const current: PracticeInfoForm"),
    );
    expect(practiceTab).toContain('name: practice.name ?? ""');
    expect(practiceTab).toContain(
      'timezone: practice.timezone ?? "America/New_York"',
    );
    expect(practiceTab).toContain(
      'taxRatePercent: practice.taxRatePercent ?? "8.00"',
    );
    expect(practiceTab).toContain("{practice.logoUrl ? (");
    expect(practiceTab).toContain(
      '{practice.logoUrl ? "Replace logo" : "Upload logo"}',
    );
    expect(practiceTab).not.toContain("practice?.");
  });

  it("labels wellness plans as scheduled invoice billing instead of autopay", () => {
    expect(source).toContain("Scheduled invoice billing");
    expect(source).toContain("No auto-charge");
    expect(source).toContain("Invoice schedule");
    expect(source).toContain("Wellness plans generate due invoices by cadence");
    expect(source).toContain(
      "Create a plan to package preventive care into scheduled invoice memberships.",
    );
  });

  it("surfaces missing settings list payloads before empty states", () => {
    const locationsTab = source.slice(
      source.indexOf("function LocationsTab"),
      source.indexOf("// ── Billing"),
    );
    const staffTab = source.slice(
      source.indexOf("function StaffTab"),
      source.indexOf("// ── Appointment Types"),
    );
    const appointmentTypesTab = source.slice(
      source.indexOf("function AppointmentTypesTab"),
      source.indexOf("// ── CSV Helpers"),
    );
    const roomsTab = source.slice(
      source.indexOf("function RoomsTab"),
      source.indexOf("// ── Wellness Plans"),
    );
    const wellnessTab = source.slice(
      source.indexOf("function WellnessPlansTab"),
      source.indexOf("// ── Templates"),
    );
    const templatesTab = source.slice(
      source.indexOf("function TemplatesTab"),
      source.length,
    );

    expect(locationsTab).toContain("const locationsMissing =");
    expect(locationsTab).toContain('title="Could not load locations"');
    expect(locationsTab).toContain("onRetry={() => void refetchLocations()}");
    expect(locationsTab.indexOf("if (locationsMissing)")).toBeLessThan(
      locationsTab.indexOf('title="No active locations configured"'),
    );

    expect(staffTab).toContain("const staffMissing =");
    expect(staffTab).toContain('title="Could not load staff"');
    expect(staffTab).toContain("onRetry={() => void refetchStaff()}");
    expect(staffTab.indexOf("if (staffMissing)")).toBeLessThan(
      staffTab.indexOf('title="No staff members found"'),
    );

    expect(appointmentTypesTab).toContain("const appointmentTypesMissing =");
    expect(appointmentTypesTab).toContain(
      'title="Could not load appointment types"',
    );
    expect(appointmentTypesTab).toContain(
      "onRetry={() => void refetchAppointmentTypes()}",
    );
    expect(
      appointmentTypesTab.indexOf("if (appointmentTypesMissing)"),
    ).toBeLessThan(
      appointmentTypesTab.indexOf('title="No appointment types configured"'),
    );

    expect(roomsTab).toContain("const roomsMissing =");
    expect(roomsTab).toContain('title="Could not load rooms"');
    expect(roomsTab).toContain("onRetry={() => void refetchRooms()}");
    expect(roomsTab.indexOf("if (roomsMissing)")).toBeLessThan(
      roomsTab.indexOf('title="No rooms configured"'),
    );

    expect(wellnessTab).toContain("const wellnessPlansMissing =");
    expect(wellnessTab).toContain('title="Could not load wellness plans"');
    expect(wellnessTab).toContain(
      "onRetry={() => void refetchWellnessPlans()}",
    );
    expect(wellnessTab.indexOf("if (wellnessPlansMissing)")).toBeLessThan(
      wellnessTab.indexOf('title="No wellness plans configured"'),
    );

    expect(templatesTab).toContain("const templatesMissing =");
    expect(templatesTab).toContain("const selectedTemplateMissing =");
    expect(templatesTab).toContain('title="Could not load templates"');
    expect(templatesTab).toContain('title="Could not load template items"');
    expect(templatesTab).toContain("onRetry={() => void refetchTemplates()}");
    expect(templatesTab).toContain(
      "onRetry={() => void refetchSelectedTemplate()}",
    );
    expect(templatesTab.indexOf("if (templatesMissing)")).toBeLessThan(
      templatesTab.indexOf('title="No templates configured"'),
    );
    expect(templatesTab.indexOf("selectedTemplateMissing ? (")).toBeLessThan(
      templatesTab.indexOf('title="No items in this template"'),
    );
  });

  it("exposes full-backup restore as a dry-run gated fresh-practice flow", () => {
    expect(PRACTICE_BACKUP_JSON_MAX_BYTES).toBe(50_000_000);
    expect(isPracticeBackupJsonSizeValid("abc", 3)).toBe(true);
    expect(isPracticeBackupJsonSizeValid("abcd", 3)).toBe(false);

    expect(source).toContain(
      "const restoreBackup = trpc.data.restoreBackup.useMutation",
    );
    expect(source).toContain("Restore Full Backup");
    expect(source).toContain("Choose Backup JSON");
    expect(source).toContain('from "@/lib/backup/policy"');
    expect(source).toContain("file.size > PRACTICE_BACKUP_JSON_MAX_BYTES");
    expect(source).toContain("isPracticeBackupJsonSizeValid(text)");
    expect(source).toContain("isPracticeBackupJsonSizeValid(backupPayload)");
    expect(source).toContain("reader.onerror");
    expect(source).toContain("{PRACTICE_BACKUP_JSON_SIZE_MESSAGE}");
    expect(source).toContain("dryRun: true");
    expect(source).toContain("dryRun: false");
    expect(source).toContain("confirmFreshPractice: true");
    expect(source).toContain("Restore into Fresh Practice");
    expect(source).toContain("backupSummary?.missingSections.length === 0");
    expect(source).toContain("backupSummary?.restoreErrors.length === 0");
    expect(source).toContain("Invalid backup data");
    expect(source).toContain("disabled={!canRestoreBackup}");
  });

  it("surfaces data export failures before downloading files", () => {
    expect(source).toContain("function requireSettingsExportData<T>(");
    expect(source).toContain("if (result.error) {");
    expect(source).toContain(
      "throw new Error(result.error.message || fallbackMessage)",
    );
    expect(source).toContain("if (result.data === undefined) {");
    expect(source).toContain("throw new Error(fallbackMessage)");
    expect(source).toContain(
      'requireSettingsExportData(\n            result,\n            "Could not export clients"',
    );
    expect(source).toContain(
      'requireSettingsExportData(\n            result,\n            "Could not export patients"',
    );
    expect(source).toContain(
      'requireSettingsExportData(\n            result,\n            "Could not export appointments"',
    );
    expect(source).toContain(
      'requireSettingsExportData(\n            result,\n            "Could not export invoices"',
    );
    expect(source).toContain(
      'requireSettingsExportData(\n        result,\n        "Could not export full backup"',
    );
    expect(source).toContain(
      'err instanceof Error ? err.message : "Could not export data"',
    );
    expect(source).not.toContain("data = (result.data ?? [])");
    expect(source).not.toContain("const raw = result.data ?? []");
    expect(source).not.toContain("if (!result.data) return;");
  });

  it("names full backup exports from the practice timezone date", () => {
    expect(source).toContain(
      'import { formatDateInputForTimeZone } from "@/lib/date-input"',
    );
    expect(source).toContain("function formatSettingsDateInput(");
    expect(source).toContain(
      'return formatDateInputForTimeZone(value, timeZone?.trim() || "UTC")',
    );
    expect(source).toContain("const practiceSettingsMissing =");
    expect(source).toContain("const verifiedPracticeSettings =");
    expect(source).toContain(
      "const settingsTimeZone = verifiedPracticeSettings\n    ? verifiedPracticeSettings.timezone\n    : null",
    );
    expect(source).toContain(
      'throw new Error("Could not load practice settings for backup export")',
    );
    expect(source).toContain(
      "const date = formatSettingsDateInput(new Date(), settingsTimeZone)",
    );
    expect(source).toContain("openvpm-full-backup-${date}.json");
    expect(source).toContain(
      "[exportFullBackup, settingsTimeZone, verifiedPracticeSettings]",
    );
    expect(source).toContain(
      "Unable to load practice settings for backup export.",
    );
    expect(source).not.toContain(
      "const settingsTimeZone = practiceSettings?.timezone",
    );
    expect(source).not.toContain("new Date().toISOString().slice(0, 10)");
  });

  it("fails closed when sample-data status is unavailable", () => {
    expect(source).toContain(
      "const onboarding = trpc.settings.onboardingStatus.useQuery()",
    );
    expect(source).toContain("const onboardingMissing =");
    expect(source).toContain("const verifiedOnboardingStatus =");
    expect(source).toContain(
      "const hasDemo = verifiedOnboardingStatus\n    ? verifiedOnboardingStatus.hasDemoData\n    : false",
    );
    expect(source).toContain("if (!verifiedOnboardingStatus) return;");
    expect(source).toContain("Boolean(onboarding.error)");
    expect(source).toContain("onboardingMissing");
    expect(source).toContain("!verifiedOnboardingStatus");
    expect(source).toContain(
      "Unable to load sample data status. Please retry.",
    );
    expect(source).not.toContain("onboarding.data?.hasDemoData ?? false");
  });

  it("uses server-side CSV dry-runs for data imports", () => {
    expect(IMPORT_CSV_MAX_BYTES).toBe(5_000_000);
    expect(isImportCsvSizeValid("a".repeat(IMPORT_CSV_MAX_BYTES))).toBe(true);
    expect(isImportCsvSizeValid("a".repeat(IMPORT_CSV_MAX_BYTES + 1))).toBe(
      false,
    );

    expect(source).toContain(
      "const importClientsCsv = trpc.data.importClientsCsv.useMutation",
    );
    expect(source).toContain(
      "const importPatientsCsv = trpc.data.importPatientsCsv.useMutation",
    );
    expect(source).toContain(
      "const importVaccinationsCsv = trpc.data.importVaccinationsCsv.useMutation",
    );
    expect(source).toContain(
      "const importSoapNotesCsv = trpc.data.importSoapNotesCsv.useMutation",
    );
    expect(source).toContain("MIGRATION_STEPS.map");
    expect(source).toContain('from "@/lib/import/policy"');
    expect(source).toContain("file.size > IMPORT_CSV_MAX_BYTES");
    expect(source).toContain("isImportCsvSizeValid(text)");
    expect(source).toContain("isImportCsvSizeValid(csvText)");
    expect(source).toContain("CSV imports must be 5 MB or less.");
    expect(source).toContain("CSV files must be 5 MB or less.");
    expect(source).toContain('const importSource = migrationSource ?? "other"');
    expect(source).toContain("importClientsCsv.mutate({");
    expect(source).toContain("importPatientsCsv.mutate({");
    expect(source).toContain("importVaccinationsCsv.mutate({");
    expect(source).toContain("importSoapNotesCsv.mutate({");
    expect(source).toContain("source: importSource");
    expect(source.match(/migrationProtocol: "reviewed-v1"/g)).toHaveLength(5);
    expect(source).toContain("previewToken: string;");
    expect(source.match(/previewToken: data\.previewToken/g)).toHaveLength(4);
    expect(
      source.match(/previewToken: importPreview\.previewToken/g),
    ).toHaveLength(4);
    expect(source).toContain("duplicates: data.duplicates");
    expect(source).toContain('label="Row issues"');
    expect(source).toContain("IDs to connect");
    expect(source).toContain("Confirm Import (");
    expect(source).toContain("changes)");
    expect(source).toContain("const importFileReadVersionRef = useRef(0)");
    expect(source).toContain(
      "const readVersion = ++importFileReadVersionRef.current",
    );
    expect(source).toContain(
      "if (importFileReadVersionRef.current !== readVersion) return;",
    );
    expect(source).not.toContain("function parseCSV");
    expect(source).not.toContain("row.first_name");
  });

  it("keeps account deletion request inputs aligned to shared bounds", () => {
    expect(SETTINGS_EMAIL_MAX_LENGTH).toBe(255);
    expect(ACCOUNT_DELETION_REASON_MAX_LENGTH).toBe(1000);
    expect(source).toContain("ACCOUNT_DELETION_REASON_MAX_LENGTH");
    expect(source).toContain("maxLength={SETTINGS_EMAIL_MAX_LENGTH}");
    expect(source).toContain("maxLength={ACCOUNT_DELETION_REASON_MAX_LENGTH}");
    expect(source).toContain(
      "const isDeletionContactEmailValid = (email: string) =>",
    );
    expect(source).toContain(
      "email.trim().length <= SETTINGS_EMAIL_MAX_LENGTH",
    );
    expect(source).toContain(
      "const isDeletionReasonValid = (reason: string) =>",
    );
    expect(source).toContain(
      "reason.trim().length <= ACCOUNT_DELETION_REASON_MAX_LENGTH",
    );
    expect(source).toContain(
      "isDeletionContactEmailValid(deletionContactEmail)",
    );
    expect(source).toContain("isDeletionReasonValid(deletionReason)");
    expect(source).not.toContain("maxLength={1000}");
  });

  it("renders account deletion timestamps in the practice timezone", () => {
    expect(source).toContain("function formatSettingsDateTime(");
    expect(source).toContain(
      'const resolvedTimeZone = timeZone?.trim() || "UTC"',
    );
    expect(source).toContain(
      "data: practiceSettings,\n    isLoading: practiceSettingsLoading,\n    error: practiceSettingsError",
    );
    expect(source).toContain("} = trpc.settings.getPractice.useQuery();");
    expect(source).toContain("const verifiedPracticeSettings =");
    expect(source).toContain(
      "const settingsTimeZone = verifiedPracticeSettings\n    ? verifiedPracticeSettings.timezone\n    : null",
    );
    expect(source).toContain(
      "formatSettingsDateTime(deletionRequest.requestedAt, settingsTimeZone)",
    );
    expect(source).toContain("const deletionSettingsMissing =");
    expect(source).toContain(
      'new Error("Could not load practice settings. Please retry.")',
    );
    expect(source).toContain("practiceSettingsLoading");
    expect(source).toContain("practiceSettingsError");
    expect(source).toContain("Could not load deletion status");
    expect(source).not.toContain(
      "const settingsTimeZone = practiceSettings?.timezone",
    );
    expect(source).not.toContain("new Intl.DateTimeFormat(undefined");
    expect(source).not.toContain(
      "format(new Date(deletionRequest.requestedAt))",
    );
  });

  it("counts billing trial days from the practice timezone", () => {
    expect(source).toContain(
      'import { trialCalendarDaysLeft } from "@/lib/billing/trial-days"',
    );
    expect(source).toContain(
      "const daysLeft = trialCalendarDaysLeft(data.trialEndsAt, data.timezone) ?? 0",
    );
    expect(source).not.toContain("trialEnds.getTime() - Date.now()");
  });

  it("keeps staff password copy and submit gating aligned to the shared policy", () => {
    expect(AUTH_PASSWORD_MIN_LENGTH).toBe(8);
    expect(AUTH_PASSWORD_MAX_LENGTH).toBe(128);
    expect(source).toContain(
      "AUTH_PASSWORD_MAX_LENGTH,\n  AUTH_PASSWORD_MIN_LENGTH,",
    );
    expect(source).toContain(
      "placeholder={`Password (min ${AUTH_PASSWORD_MIN_LENGTH} chars)`}",
    );
    expect(source).toContain("maxLength={AUTH_PASSWORD_MAX_LENGTH}");
    expect(source).toContain("password.length >= AUTH_PASSWORD_MIN_LENGTH");
    expect(source).toContain("password.length <= AUTH_PASSWORD_MAX_LENGTH");
    expect(source).not.toContain("Password (min 6 chars)");
    expect(source).not.toContain("addForm.password.length < 6");
  });

  it("keeps appointment type duration inputs aligned to the shared policy", () => {
    expect(APPOINTMENT_TYPE_DURATION_MIN_MINUTES).toBe(5);
    expect(APPOINTMENT_TYPE_DURATION_MAX_MINUTES).toBe(480);
    expect(source).toContain("APPOINTMENT_TYPE_DURATION_MIN_MINUTES");
    expect(source).toContain("APPOINTMENT_TYPE_DURATION_MAX_MINUTES");
    expect(source).toContain(
      "duration >= APPOINTMENT_TYPE_DURATION_MIN_MINUTES",
    );
    expect(source).toContain(
      "duration <= APPOINTMENT_TYPE_DURATION_MAX_MINUTES",
    );
    expect(source).toContain("min={APPOINTMENT_TYPE_DURATION_MIN_MINUTES}");
    expect(source).toContain("max={APPOINTMENT_TYPE_DURATION_MAX_MINUTES}");
    expect(source).toContain("!isDurationValid(addForm.durationMinutes)");
    expect(source).toContain("!isDurationValid(editForm.durationMinutes)");
  });

  it("keeps appointment type and room name inputs aligned to shared bounds", () => {
    expect(APPOINTMENT_TYPE_NAME_MAX_LENGTH).toBe(128);
    expect(ROOM_NAME_MAX_LENGTH).toBe(128);
    expect(source).toContain("APPOINTMENT_TYPE_NAME_MAX_LENGTH");
    expect(source).toContain("ROOM_NAME_MAX_LENGTH");
    expect(
      source.match(/maxLength={APPOINTMENT_TYPE_NAME_MAX_LENGTH}/g),
    ).toHaveLength(2);
    expect(source).toContain("maxLength={ROOM_NAME_MAX_LENGTH}");
    expect(source).toContain(
      "const isAppointmentTypeNameValid = (name: string) =>",
    );
    expect(source).toContain(
      "name.trim().length <= APPOINTMENT_TYPE_NAME_MAX_LENGTH",
    );
    expect(source).toContain("const isRoomNameValid = (name: string) =>");
    expect(source).toContain("name.trim().length <= ROOM_NAME_MAX_LENGTH");
    expect(source).toContain("!isAppointmentTypeNameValid(addForm.name)");
    expect(source).toContain("!isAppointmentTypeNameValid(editForm.name)");
    expect(source).toContain("!isRoomNameValid(addForm.name)");
    expect(source).not.toContain(
      "disabled={!addForm.name || createMutation.isPending}",
    );
  });

  it("keeps location add and edit fields aligned to shared bounds", () => {
    expect(LOCATION_NAME_MAX_LENGTH).toBe(255);
    expect(SETTINGS_PHONE_MAX_LENGTH).toBe(32);
    expect(SETTINGS_ADDRESS_MAX_LENGTH).toBe(500);
    expect(source).toContain("LOCATION_NAME_MAX_LENGTH");
    expect(source).toContain("SETTINGS_PHONE_MAX_LENGTH");
    expect(source).toContain("SETTINGS_ADDRESS_MAX_LENGTH");
    expect(source.match(/maxLength={LOCATION_NAME_MAX_LENGTH}/g)).toHaveLength(
      2,
    );
    expect(source).toContain("maxLength={SETTINGS_PHONE_MAX_LENGTH}");
    expect(source).toContain("maxLength={SETTINGS_ADDRESS_MAX_LENGTH}");
    expect(source).toContain("const isLocationFormValid = (form: {");
    expect(source).toContain(
      "form.name.trim().length <= LOCATION_NAME_MAX_LENGTH",
    );
    expect(source).toContain(
      "form.phone.trim().length <= SETTINGS_PHONE_MAX_LENGTH",
    );
    expect(source).toContain(
      "form.address.trim().length <= SETTINGS_ADDRESS_MAX_LENGTH",
    );
    expect(source).toContain("!isLocationFormValid(addForm)");
    expect(source).toContain("!isLocationFormValid(editForm)");
    expect(source).not.toContain(
      "disabled={!addForm.name.trim() || createMutation.isPending}",
    );
    expect(source).not.toContain(
      "disabled={!editForm.name.trim() || updateMutation.isPending}",
    );
  });

  it("keeps practice info fields aligned to shared bounds", () => {
    expect(PRACTICE_NAME_MAX_LENGTH).toBe(255);
    expect(SETTINGS_WEBSITE_MAX_LENGTH).toBe(255);
    expect(SETTINGS_TIMEZONE_MAX_LENGTH).toBe(64);
    expect(isSupportedPracticeTimezone("America/New_York")).toBe(true);
    expect(isSupportedPracticeTimezone("Mars/Olympus_Mons")).toBe(false);
    expect(SETTINGS_VAT_NUMBER_MAX_LENGTH).toBe(32);
    expect(isValidSettingsTaxRate("20.00")).toBe(true);
    expect(isValidSettingsTaxRate("100")).toBe(true);
    expect(isValidSettingsTaxRate("100.00")).toBe(true);
    expect(isValidSettingsTaxRate("100.01")).toBe(false);
    expect(isValidSettingsTaxRate("999.99")).toBe(false);
    expect(source).toContain("type PracticeInfoForm = {");
    expect(source).toContain("maxLength={PRACTICE_NAME_MAX_LENGTH}");
    expect(source).toContain("maxLength={SETTINGS_ADDRESS_MAX_LENGTH}");
    expect(source).toContain("maxLength={SETTINGS_PHONE_MAX_LENGTH}");
    expect(source).toContain("maxLength={SETTINGS_EMAIL_MAX_LENGTH}");
    expect(source).toContain("maxLength={SETTINGS_WEBSITE_MAX_LENGTH}");
    expect(source).toContain("maxLength={SETTINGS_VAT_NUMBER_MAX_LENGTH}");
    expect(source).toContain(
      "const isPracticeInfoFormValid = (practiceForm: PracticeInfoForm) =>",
    );
    expect(source).toContain(
      "practiceForm.name.trim().length <= PRACTICE_NAME_MAX_LENGTH",
    );
    expect(source).toContain(
      "practiceForm.address.trim().length <= SETTINGS_ADDRESS_MAX_LENGTH",
    );
    expect(source).toContain(
      "practiceForm.phone.trim().length <= SETTINGS_PHONE_MAX_LENGTH",
    );
    expect(source).toContain(
      "practiceForm.website.trim().length <= SETTINGS_WEBSITE_MAX_LENGTH",
    );
    expect(source).toContain(
      "isSupportedPracticeTimezone(practiceForm.timezone)",
    );
    expect(source).toContain("isValidSettingsTaxRate");
    expect(source).toContain('max="100"');
    expect(source).toContain(
      "practiceForm.vatNumber.trim().length <= SETTINGS_VAT_NUMBER_MAX_LENGTH",
    );
    expect(source).toContain("email: current.email.trim() || undefined");
    expect(source).toContain("!isPracticeInfoFormValid(current)");
  });

  it("keeps staff add, invite, and edit fields aligned to shared bounds", () => {
    expect(STAFF_NAME_MAX_LENGTH).toBe(255);
    expect(SETTINGS_EMAIL_MAX_LENGTH).toBe(255);
    expect(STAFF_LICENSE_NUMBER_MAX_LENGTH).toBe(64);
    expect(source).toContain("STAFF_NAME_MAX_LENGTH");
    expect(source).toContain("SETTINGS_EMAIL_MAX_LENGTH");
    expect(source).toContain("STAFF_LICENSE_NUMBER_MAX_LENGTH");
    expect(source.match(/maxLength={STAFF_NAME_MAX_LENGTH}/g)).toHaveLength(3);
    expect(source).toContain("maxLength={SETTINGS_EMAIL_MAX_LENGTH}");
    expect(
      source.match(/maxLength={STAFF_LICENSE_NUMBER_MAX_LENGTH}/g),
    ).toHaveLength(2);
    expect(source).toContain("maxLength={SETTINGS_PHONE_MAX_LENGTH}");
    expect(source).toContain(
      "const isStaffCreateFormValid = (form: typeof addForm) =>",
    );
    expect(source).toContain(
      "const isStaffInviteFormValid = (form: typeof inviteForm) =>",
    );
    expect(source).toContain(
      "const isStaffEditFormValid = (form: typeof editForm) =>",
    );
    expect(source).toContain("isSettingsEmailInputValid(form.email)");
    expect(source).toContain("isStaffContactFieldsValid(form)");
    expect(source).toContain("!isStaffCreateFormValid(addForm)");
    expect(source).toContain("!isStaffInviteFormValid(inviteForm)");
    expect(source).toContain("!isStaffEditFormValid(editForm)");
    expect(source).not.toContain("disabled={!isValidEmail(inviteForm.email)");
    expect(source).not.toContain(
      "addForm.password.length < AUTH_PASSWORD_MIN_LENGTH",
    );
  });
});
