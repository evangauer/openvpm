import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../routers/patients.ts", import.meta.url),
  "utf8"
);

describe("patients query scoping", () => {
  it("keeps patient owner display joins tenant scoped and active", () => {
    const clientLeftJoins =
      source.match(
        /leftJoin\(\s*clients,\s*and\(\s*eq\(patients\.clientId, clients\.id\),\s*eq\(clients\.practiceId, ctx\.practiceId\),\s*isNull\(clients\.deletedAt\)\s*\)\s*\)/gs
      ) ?? [];

    expect(clientLeftJoins.length).toBeGreaterThanOrEqual(3);
  });

  it("requires an active practice for patient reads, writes, and merge dependencies", () => {
    expect(source).toContain("function activePracticePredicate");
    expect(source).toContain("function assertActivePractice");
    expect(source).toContain("from ${practices}");
    expect(source).toContain("${practices.deletedAt} is null");
    expect(source).toContain("await assertActivePractice(ctx)");
    expect(
      source.match(/activePracticePredicate\(ctx\.practiceId\)/g)?.length ?? 0
    ).toBeGreaterThanOrEqual(25);
    expect(source).toMatch(
      /eq\(patients\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(patients\.deletedAt\)/
    );
    expect(source).toMatch(
      /eq\(appointments\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(appointments\.deletedAt\)/
    );
    expect(source).toMatch(
      /eq\(appointmentWaitlist\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+eq\(appointmentWaitlist\.status, "waiting"\)/
    );
    expect(source).toMatch(
      /eq\(invoices\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\)/
    );
  });

  it("scopes patient detail child reads through the tenant patient", () => {
    const weightsRead = source.match(
      /\.from\(patientWeights\)[\s\S]+?\.orderBy\(desc\(patientWeights\.recordedAt\)\)/
    )?.[0];
    expect(weightsRead).toContain("eq(patientWeights.patientId, input.id)");
    expect(weightsRead).toContain("from ${patients}");
    expect(weightsRead).toContain("${patients.id} = ${patientWeights.patientId}");
    expect(weightsRead).toContain("${patients.practiceId} = ${ctx.practiceId}");
    expect(weightsRead).toContain("${patients.deletedAt} is null");
    expect(weightsRead).toContain("activePracticePredicate(ctx.practiceId)");

    const allergiesRead = source.match(
      /\.from\(patientAllergies\)[\s\S]+?eq\(patientAllergies\.patientId, input\.id\)[\s\S]+?isNull\(patientAllergies\.deletedAt\)/
    )?.[0];
    expect(allergiesRead).toContain("from ${patients}");
    expect(allergiesRead).toContain(
      "${patients.id} = ${patientAllergies.patientId}"
    );
    expect(allergiesRead).toContain(
      "${patients.practiceId} = ${ctx.practiceId}"
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
    expect(deleteBlock).toContain("eq(appointments.practiceId, ctx.practiceId)");
    expect(deleteBlock).toContain(
      "inArray(appointments.status, activeAppointmentStatuses)"
    );
    expect(deleteBlock).toContain(
      "eq(appointmentWaitlist.patientId, input.id)"
    );
    expect(deleteBlock).toContain(
      "eq(appointmentWaitlist.practiceId, ctx.practiceId)"
    );
    expect(deleteBlock).toContain('eq(appointmentWaitlist.status, "waiting")');
  });

  it("tenant-scopes patient merge child updates", () => {
    const mergeBlock = source.match(
      /\/\/ Re-point all records from mergeId to keepId[\s\S]+?\/\/ Soft-delete the merged patient/
    )?.[0];
    expect(source).toContain("await ctx.db.transaction(async (tx) => {");

    for (const table of [
      "appointments",
      "appointmentWaitlist",
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
      "insurancePolicies",
      "wellnessEnrollments",
      "patientWeights",
      "patientAllergies",
      "invoices",
    ]) {
      expect(mergeBlock).toContain(`eq(${table}.patientId, input.mergeId)`);
    }

    expect(mergeBlock).toContain("eq(appointments.clientId, keepPatient.clientId)");
    expect(mergeBlock).toContain("eq(appointments.practiceId, ctx.practiceId)");
    expect(mergeBlock).toContain("activePracticePredicate(ctx.practiceId)");
    expect(mergeBlock).toContain(
      "eq(appointmentWaitlist.practiceId, ctx.practiceId)"
    );
    expect(mergeBlock).toContain(
      "eq(appointmentWaitlist.clientId, keepPatient.clientId)"
    );
    expect(mergeBlock).toContain("eq(soapNotes.practiceId, ctx.practiceId)");
    expect(mergeBlock).toContain(
      "eq(vaccinationRecords.practiceId, ctx.practiceId)"
    );
    expect(mergeBlock).toContain("eq(labResults.practiceId, ctx.practiceId)");
    expect(mergeBlock).toContain("eq(procedures.practiceId, ctx.practiceId)");
    expect(mergeBlock).toContain("eq(clinicalNotes.practiceId, ctx.practiceId)");
    expect(mergeBlock).toContain("eq(problemList.practiceId, ctx.practiceId)");
    expect(mergeBlock).toContain("eq(vitalSigns.practiceId, ctx.practiceId)");
    expect(mergeBlock).toContain("eq(cases.practiceId, ctx.practiceId)");
    expect(mergeBlock).toContain("eq(treatmentPlans.practiceId, ctx.practiceId)");
    expect(mergeBlock).toContain(
      "eq(prescriptions.practiceId, ctx.practiceId)"
    );
    expect(mergeBlock).toContain(
      "eq(controlledSubstanceLog.practiceId, ctx.practiceId)"
    );
    expect(mergeBlock).toContain(
      "eq(insurancePolicies.clientId, keepPatient.clientId)"
    );
    expect(mergeBlock).toContain(
      "eq(insurancePolicies.practiceId, ctx.practiceId)"
    );
    expect(mergeBlock).toContain(
      "eq(wellnessEnrollments.clientId, keepPatient.clientId)"
    );
    expect(mergeBlock).toContain(
      "eq(wellnessEnrollments.practiceId, ctx.practiceId)"
    );
    expect(mergeBlock).toContain("eq(invoices.clientId, keepPatient.clientId)");
    expect(mergeBlock).toContain("eq(invoices.practiceId, ctx.practiceId)");
    expect(mergeBlock).toContain(
      "${patients.id} = ${patientWeights.patientId}"
    );
    expect(mergeBlock).toContain(
      "${patients.id} = ${patientAllergies.patientId}"
    );
    expect(source).toContain("eq(patients.id, input.mergeId)");
    expect(source).toContain("eq(patients.id, input.keepId)");
    expect(source).toContain("clientId: patients.clientId");
    expect(source).toContain(
      "if (keepPatient.clientId !== mergePatient.clientId)"
    );
  });
});
