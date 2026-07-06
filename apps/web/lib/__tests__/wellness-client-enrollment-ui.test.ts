import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("wellness client enrollment UI", () => {
  it("keeps client detail write controls aligned to client and wellness roles", () => {
    const source = readFileSync("app/(dashboard)/clients/[id]/page.tsx", "utf8");
    const wellnessRouter = readFileSync("server/routers/wellness.ts", "utf8");

    expect(source).toContain('import { useSession } from "next-auth/react"');
    expect(source).toContain(
      "function canManageClientDetailsRole(role?: string | null): boolean"
    );
    expect(source).toContain(
      "function canManageWellnessMembershipRole(role?: string | null): boolean"
    );
    expect(source).toContain("const { data: session } = useSession()");
    expect(source).toContain(
      "const canManageClientDetails = canManageClientDetailsRole("
    );
    expect(source).toContain(
      "const canManageWellnessMemberships = canManageWellnessMembershipRole("
    );
    expect(source).toContain("if (!canManageClientDetails) return");
    expect(source).toContain("{canManageClientDetails && (");
    expect(source).toContain("Portal links are available to staff with client write access.");
    expect(source).toContain("{canManageClientDetails && portalPath ? (");
    expect(source).toContain("canManageWellnessMemberships={canManageWellnessMemberships}");
    expect(source).toContain("canManageWellnessMemberships &&");
    expect(source).toContain(
      "{canManageWellnessMemberships ? \"Actions\" : \"Access\"}"
    );
    expect(source).toContain("Read-only");
    expect(source).toContain("canManageClientDetails\n                ? {");

    expect(source).toContain('role === "admin"');
    expect(source).toContain('role === "veterinarian"');
    expect(source).toContain('role === "technician"');
    expect(source).toContain('role === "front_desk"');
    expect(wellnessRouter).toContain(
      'const manageRole = requireRole("admin", "front_desk")'
    );
    expect(wellnessRouter).toContain("enroll: protectedProcedure\n    .use(manageRole)");
    expect(wellnessRouter).toContain("cancel: protectedProcedure\n    .use(manageRole)");
  });

  it("keeps client detail enrollment wired to wellness APIs", () => {
    const source = readFileSync("app/(dashboard)/clients/[id]/page.tsx", "utf8");

    expect(source).toContain("WellnessEnrollmentPanel");
    expect(source).toContain("trpc.wellness.listPlans.useQuery");
    expect(source).toContain("trpc.wellness.listEnrollments.useQuery");
    expect(source).toContain("trpc.wellness.enroll.useMutation");
    expect(source).toContain("trpc.wellness.cancel.useMutation");
    expect(source).toContain("utils.wellness.listEnrollments.invalidate");
    expect(source).toContain("utils.wellness.listDue.invalidate");
    expect(source).toContain("clientId: client.id");
    expect(source).toContain("patientId: selectedPatientId || undefined");
    expect(source).toContain("const verifiedWellnessPlans =");
    expect(source).toContain("error || plansMissing || !plans ? null : plans");
    expect(source).toContain("const verifiedEnrollments =");
    expect(source).toContain("const enrollmentsReady = verifiedEnrollments !== null");
    expect(source).toContain("const activeEnrollments = verifiedEnrollments ?? []");
    expect(source).toContain("handleCancelEnrollment(enrollment.enrollmentId)");
    expect(source).toContain("Invoice schedule");
    expect(source).toContain("Enrollment creates scheduled invoices");
    expect(source).toContain("saved cards are not");
    expect(source).toContain("auto-charged");
    expect(source).toContain("Next Invoice");
  });

  it("renders enrollment billing dates through the clinical date formatter", () => {
    const source = readFileSync("app/(dashboard)/clients/[id]/page.tsx", "utf8");

    expect(source).toContain(
      'import {\n  formatClinicalDate,\n  formatClinicalDateTime,\n} from "@/lib/records/clinical-dates"'
    );
    expect(source).toContain(
      "formatClinicalDate(\n                      enrollment.nextBillingDate,\n                      enrollment.timezone"
    );
    expect(source).toContain('"\\u2014"');
    expect(source).not.toContain(
      "new Date(enrollment.nextBillingDate).toLocaleDateString()"
    );
  });

  it("keeps client detail empty and enrollment error states explicit", () => {
    const source = readFileSync("app/(dashboard)/clients/[id]/page.tsx", "utf8");

    expect(source).toContain('import { EmptyState } from "@/components/common/empty-state"');
    expect(source).toContain('title="No patients for this client yet"');
    expect(source).toContain('label: "Add patient"');
    expect(source).toContain("const plansMissing =");
    expect(source).toContain("const enrollmentsMissing =");
    expect(source).toContain(
      "enrollmentsQuery.error ||\n    enrollmentsQuery.isLoading ||\n    enrollmentsMissing ||\n    !enrollmentsQuery.data"
    );
    expect(source).toContain("Unable to load wellness plans. Please retry.");
    expect(source).toContain("Unable to load wellness memberships. Please retry.");
    expect(source).toContain("const canCreateEnrollment =");
    expect(source).toContain("enrollmentsReady");
    expect(source).toContain("disabled={enroll.isPending || !enrollmentsReady}");
    expect(source).toContain("disabled={!canCreateEnrollment}");
    expect(source).toContain("{enrollmentsQuery.error ? (");
    expect(source).toContain(") : enrollmentsMissing ? (");
    expect(source).toContain(") : enrollmentsQuery.isLoading ? (");
    expect(source.indexOf("plansMissing")).toBeLessThan(
      source.indexOf('"No active wellness plans configured."')
    );
    expect(source.indexOf("enrollmentsMissing ? (")).toBeLessThan(
      source.indexOf("activeEnrollments.length > 0")
    );
    expect(source).not.toContain("{enrollmentsQuery.error &&");
    expect(source).not.toContain("const activeEnrollments = enrollmentsQuery.data ?? []");
    expect(source).not.toContain("const activePlans = plans?.filter");
  });
});
