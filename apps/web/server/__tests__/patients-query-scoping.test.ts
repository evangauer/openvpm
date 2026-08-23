import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../routers/patients.ts", import.meta.url),
  "utf8",
);
const trpcSource = readFileSync(new URL("../trpc.ts", import.meta.url), "utf8");

describe("patients query scoping", () => {
  it("keeps patient owner display joins tenant scoped and active", () => {
    const clientLeftJoins =
      source.match(
        /leftJoin\(\s*clients,\s*and\(\s*eq\(patients\.clientId, clients\.id\),\s*eq\(clients\.practiceId, (?:ctx\.)?practiceId\),\s*isNull\(clients\.deletedAt\)/gs,
      ) ?? [];

    expect(clientLeftJoins.length).toBeGreaterThanOrEqual(3);
  });

  it("uses bounded literal patient + owner tokens with stable quick-search order", () => {
    expect(source).toContain("patientOwnerSearchConditions");
    expect(source).toContain("patientSearchTokens(value).map");
    expect(source).toContain("literalPatientSearchMatch(patients.name, token)");
    expect(source).toContain(
      "literalPatientSearchMatch(patients.breed, token)",
    );
    expect(source).toContain(
      "literalPatientSearchMatch(clients.firstName, token)",
    );
    expect(source).toContain(
      "literalPatientSearchMatch(clients.lastName, token)",
    );
    expect(source).toContain("escape '\\\\'");
    expect(source).toContain("patientSearchOrder(input.query)");
    expect(source).toContain("when lower(${patients.name}) = ${phrase} then 0");
    expect(source).toContain("asc(patients.id)");
    expect(source).toContain(".limit(10)");
  });

  it("requires an active practice for patient reads, writes, and merge dependencies", () => {
    expect(source).toContain("function activePracticePredicate");
    expect(source).toContain("function assertActivePractice");
    expect(source).toContain("from ${practices}");
    expect(source).toContain("${practices.deletedAt} is null");
    expect(source).toContain("await assertActivePractice(ctx)");
    expect(
      source.match(/activePracticePredicate\(ctx\.practiceId\)/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(10);
    expect(source).toMatch(
      /eq\(patients\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(patients\.deletedAt\)/,
    );
    expect(source).toMatch(
      /eq\(appointments\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(appointments\.deletedAt\)/,
    );
    expect(source).toMatch(
      /eq\(appointmentWaitlist\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+eq\(appointmentWaitlist\.status, "waiting"\)/,
    );
    expect(source).toContain(
      "from ${invoices} where ${invoices.practiceId} = ${practiceId} and ${invoices.patientId} = ${patientId}",
    );
  });

  it("scopes patient detail child reads through the tenant patient", () => {
    const weightsRead = source.match(
      /\.from\(patientWeights\)[\s\S]+?\.orderBy\(desc\(patientWeights\.recordedAt\)\)/,
    )?.[0];
    expect(weightsRead).toContain("eq(patientWeights.patientId, patient.id)");
    expect(weightsRead).toContain("from ${patients}");
    expect(weightsRead).toContain(
      "${patients.id} = ${patientWeights.patientId}",
    );
    expect(weightsRead).toContain("${patients.practiceId} = ${ctx.practiceId}");
    expect(weightsRead).toContain("${patients.deletedAt} is null");
    expect(weightsRead).toContain("activePracticePredicate(ctx.practiceId)");

    const allergiesRead = source.match(
      /\.from\(patientAllergies\)[\s\S]+?eq\(patientAllergies\.patientId, patient\.id\)[\s\S]+?\.orderBy\(desc\(patientAllergies\.notedAt\)/,
    )?.[0];
    expect(allergiesRead).toContain(".leftJoin(");
    expect(allergiesRead).toContain(
      "clinicalRecordCorrections.patientAllergyId",
    );
    expect(allergiesRead).toContain(
      "eq(clinicalRecordCorrections.practiceId, ctx.practiceId)",
    );
    expect(allergiesRead).toContain("from ${patients}");
    expect(allergiesRead).toContain(
      "${patients.id} = ${patientAllergies.patientId}",
    );
    expect(allergiesRead).toContain(
      "${patients.practiceId} = ${ctx.practiceId}",
    );
    expect(allergiesRead).toContain("${patients.deletedAt} is null");
    expect(allergiesRead).toContain("activePracticePredicate(ctx.practiceId)");
  });

  it("blocks patient deletes with tenant-scoped active scheduling dependencies", () => {
    const deleteStart = source.indexOf("delete: protectedProcedure");
    const addWeightStart = source.indexOf("addWeight:", deleteStart);
    expect(deleteStart).toBeGreaterThanOrEqual(0);
    expect(addWeightStart).toBeGreaterThan(deleteStart);

    const deleteBlock = source.slice(deleteStart, addWeightStart);

    expect(deleteBlock).toContain("await ctx.db.transaction");
    expect(deleteBlock).toContain("eq(patients.id, input.id)");
    expect(deleteBlock).toContain("eq(patients.practiceId, ctx.practiceId)");
    expect(deleteBlock).toContain("activePracticePredicate(ctx.practiceId)");
    expect(deleteBlock).toContain("eq(appointments.patientId, input.id)");
    expect(deleteBlock).toContain(
      "eq(appointments.practiceId, ctx.practiceId)",
    );
    expect(deleteBlock).toContain(
      "inArray(appointments.status, activeAppointmentStatuses)",
    );
    expect(deleteBlock).toContain(
      "eq(appointmentWaitlist.patientId, input.id)",
    );
    expect(deleteBlock).toContain(
      "eq(appointmentWaitlist.practiceId, ctx.practiceId)",
    );
    expect(deleteBlock).toContain('eq(appointmentWaitlist.status, "waiting")');
  });

  it("keeps merge preview and execution admin-only, transactional, and fail-closed", () => {
    const previewStart = source.indexOf("previewMerge: protectedProcedure");
    const mergeStart = source.indexOf(
      "merge: protectedProcedure",
      previewStart,
    );
    const duplicatesStart = source.indexOf(
      "findDuplicates: protectedProcedure",
      mergeStart,
    );
    const mergeBlock = source.slice(mergeStart, duplicatesStart);

    expect(previewStart).toBeGreaterThanOrEqual(0);
    expect(mergeBlock).toContain('.use(requireRole("admin"))');
    expect(mergeBlock).toContain("ctx.db.transaction(async (tx) =>");
    expect(mergeBlock).not.toContain(
      "set transaction isolation level serializable",
    );
    expect(trpcSource).toMatch(
      /path === "patients\.merge"\s*\? \{ isolationLevel: "serializable" \}/,
    );
    expect(trpcSource).toContain('path === "patients.merge" && !result.ok');
    expect(trpcSource).toContain("throw result.error");
    expect(source).toContain('.orderBy(asc(patients.id))\n    .for("update")');
    expect(source).toContain("sourceHasIncomingAliases");
    expect(source).toContain("sourceWasPreviouslyMerged");
    expect(source).toContain("targetWasPreviouslyMerged");
    expect(source).toContain("appointmentCollisions");
    expect(source).toMatch(
      /appointmentHistory:[\s\S]*?\$\{appointments\.clientId\} = \$\{mergePatient\.clientId\}[\s\S]*?\) is not true/,
    );
    expect(source).toContain("waitlistCollisions");
    expect(source).toContain("consentRequests:");
    expect(source).toContain("captureSessions:");
    expect(source).toContain("patientFiles:");
    expect(mergeBlock).toContain("patientMergeInput");
    expect(mergeBlock).toContain("patientMergeEvents.operationId");
    expect(mergeBlock).toContain("Patient merge blocked:");
  });

  it("moves only future scheduling work and never rewrites retained history", () => {
    const mergeStart = source.indexOf("merge: protectedProcedure");
    const duplicatesStart = source.indexOf(
      "findDuplicates: protectedProcedure",
      mergeStart,
    );
    const mergeBlock = source.slice(mergeStart, duplicatesStart);

    expect(mergeBlock).toContain(".update(appointments)");
    expect(mergeBlock).toContain(
      "inArray(appointments.status, mergeMovableAppointmentStatuses)",
    );
    expect(mergeBlock).toContain(".update(appointmentWaitlist)");
    expect(mergeBlock).toContain('eq(appointmentWaitlist.status, "waiting")');
    for (const table of [
      "patientWeights",
      "patientAllergies",
      "soapNotes",
      "vaccinationRecords",
      "labResults",
      "procedures",
      "clinicalNotes",
      "problemList",
      "vitalSigns",
      "cases",
      "treatmentPlans",
      "prescriptions",
      "controlledSubstanceLog",
      "clinicalRecordCorrections",
      "dispenseChargeQueue",
      "consentRequests",
      "captureSessions",
      "files",
      "invoices",
    ]) {
      expect(mergeBlock).not.toContain(`.update(${table})`);
    }

    const appointmentsWrite = mergeBlock.indexOf(".update(appointments)");
    const waitlistWrite = mergeBlock.indexOf(".update(appointmentWaitlist)");
    const eventWrite = mergeBlock.indexOf(".insert(patientMergeEvents)");
    const auditWrite = mergeBlock.indexOf(".insert(auditLog)");
    const sourceRetire = mergeBlock.lastIndexOf(".update(patients)");
    expect(appointmentsWrite).toBeLessThan(waitlistWrite);
    expect(waitlistWrite).toBeLessThan(eventWrite);
    expect(eventWrite).toBeLessThan(auditWrite);
    expect(auditWrite).toBeLessThan(sourceRetire);
  });

  it("resolves merged source IDs canonically and reports attribution metadata", () => {
    expect(source).toContain("resolveCanonicalPatientDetail");
    expect(source).toContain(
      "eq(patientMergeEvents.sourcePatientId, requestedId)",
    );
    expect(source).toContain("sourceSnapshot: mergeEvent.sourceSnapshot");
    expect(source).toContain("performedByName: mergeEvent.performedByName");
    expect(source).toContain("reason: mergeEvent.reason");
    expect(source).toContain("requestedPatientId: input.id");
    expect(source).toContain("canonicalPatientId: patient.id");
  });
});
