import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PORTAL_ROUTER = fileURLToPath(new URL("../routers/portal.ts", import.meta.url));

describe("portal public read scoping", () => {
  const src = readFileSync(PORTAL_ROUTER, "utf8");

  it("uses one bounded portal token input across public portal procedures", () => {
    expect(src).toContain("const portalTokenInput = z");
    expect(src).toContain(".max(PORTAL_ACCESS_TOKEN_MAX_LENGTH)");
    expect(src).not.toContain("token: z.string().min(1)");
  });

  it("returns the practice timezone with the portal client summary", () => {
    const timezoneHelper = src.match(
      /async function practiceTimeZone[\s\S]+?return practice\.timezone \?\? null;/
    )?.[0];
    expect(src).toContain(
      "const timezone = await practiceTimeZone(ctx.db, client.practiceId)"
    );
    expect(timezoneHelper).toContain("where(activePracticeWhere(practiceId))");
    expect(timezoneHelper).toContain("throw invalidPortalLink()");
    expect(timezoneHelper).not.toContain("practice?.timezone");
    expect(src).toContain(
      "timezone,\n        locations: appointmentLocations,\n        patients: clientPatients",
    );
  });

  it("requires portal tokens to belong to an active practice", () => {
    const tokenResolver = src.match(
      /async function getClientByToken[\s\S]+?return client;/
    )?.[0];
    expect(src).toContain("function activePracticeWhere");
    expect(tokenResolver).toContain("eq(clients.accessToken, token)");
    expect(tokenResolver).toContain("isNull(clients.deletedAt)");
    expect(tokenResolver).toContain("select({ id: practices.id })");
    expect(tokenResolver).toContain("where(activePracticeWhere(client.practiceId))");
  });

  it("requires an active practice before public portal writes", () => {
    const writeAccess = src.slice(
      src.indexOf("async function assertPortalWriteAccess"),
      src.indexOf("export const portalRouter")
    );
    expect(writeAccess).toContain("where(activePracticeWhere(practiceId))");
    expect(writeAccess).toContain("throw invalidPortalLink()");
    expect(writeAccess).toContain("if (!billingEnforced()) return");
  });

  it("keeps appointments and invoices scoped to the token client's practice", () => {
    expect(src).toContain("eq(appointments.clientId, client.id)");
    expect(src).toContain("eq(appointments.practiceId, client.practiceId)");
    expect(src).toContain("isNull(appointments.deletedAt)");
    expect(src).toContain("eq(invoices.clientId, client.id)");
    expect(src).toContain("eq(invoices.practiceId, client.practiceId)");
    expect(src).toContain('ne(invoices.status, "draft")');
    expect(src).toContain("isNull(invoices.deletedAt)");
  });

  it("keeps portal messages scoped to the token client's practice", () => {
    expect(src).toContain("getMessages: publicProcedure");
    expect(src).toContain("createMessage: publicProcedure");
    expect(src).toContain("eq(communications.clientId, client.id)");
    expect(src).toContain(
      "eq(communications.practiceId, client.practiceId)"
    );
    expect(src).toContain('eq(communications.channel, "portal")');
    expect(src).toContain("isNull(communications.deletedAt)");
  });

  it("keeps portal appointment and invoice patient display rows scoped to the token client", () => {
    const appointmentsPatientJoin = src.match(
      /\.from\(appointments\)[\s\S]+?\.leftJoin\(\s*patients,[\s\S]+?\)\s*\)\s*\.leftJoin\(\s*users,/
    )?.[0];
    expect(appointmentsPatientJoin).toContain(
      "eq(appointments.patientId, patients.id)"
    );
    expect(appointmentsPatientJoin).toContain("eq(patients.clientId, client.id)");
    expect(appointmentsPatientJoin).toContain(
      "eq(patients.practiceId, client.practiceId)"
    );
    expect(appointmentsPatientJoin).toContain("isNull(patients.deletedAt)");

    const invoicesPatientJoin = src.match(
      /\.from\(invoices\)[\s\S]+?\.leftJoin\(\s*patients,[\s\S]+?\)\s*\)\s*\.where\(\s*and\(/
    )?.[0];
    expect(invoicesPatientJoin).toContain("eq(invoices.patientId, patients.id)");
    expect(invoicesPatientJoin).toContain("eq(patients.clientId, client.id)");
    expect(invoicesPatientJoin).toContain(
      "eq(patients.practiceId, client.practiceId)"
    );
    expect(invoicesPatientJoin).toContain("isNull(patients.deletedAt)");
  });

  it("keeps portal invoice adjustment totals scoped through the token client invoice", () => {
    const adjustmentLookup = src.match(
      /select sum\(\$\{invoiceAdjustments\.amount\}\)[\s\S]+?\$\{invoiceAdjustments\.deletedAt\} is null/
    )?.[0];

    expect(adjustmentLookup).toContain(
      "where ${invoices.id} = ${invoiceAdjustments.invoiceId}"
    );
    expect(adjustmentLookup).toContain("and ${invoices.clientId} = ${client.id}");
    expect(adjustmentLookup).toContain(
      "and ${invoices.practiceId} = ${client.practiceId}"
    );
    expect(adjustmentLookup).toContain("and ${invoices.deletedAt} is null");
    expect(adjustmentLookup).toContain("${invoiceAdjustments.deletedAt} is null");
  });

  it("returns online payment availability with portal invoices", () => {
    expect(src).toContain('import { stripeConfigured } from "@/lib/stripe-config"');
    expect(src).toContain(
      'import { billingEnforced, hasHostedFullAccess } from "@/lib/billing/plans"'
    );
    expect(src).toContain("const hostedBillingEnforced = billingEnforced()");
    expect(src).toContain("stripeConfigured() &&");
    expect(src).toContain("hasHostedFullAccess(");
    expect(src).not.toContain("Boolean(process.env.STRIPE_SECRET_KEY)");
    expect(src).toContain("onlinePaymentsEnabled,");
  });

  it("returns the practice timezone with portal invoices for display", () => {
    expect(src).toContain("timezone: practices.timezone");
    expect(src).toContain("where(activePracticeWhere(client.practiceId))");
    expect(src).toContain("throw invalidPortalLink()");
    expect(src).toContain("const timezone = practice.timezone ?? null");
    expect(src).toContain("timezone,\n          onlinePaymentsEnabled");
  });

  it("keeps portal pet detail on active, non-deleted records", () => {
    expect(src).toContain("eq(patients.clientId, client.id)");
    expect(src).toContain("eq(patients.practiceId, client.practiceId)");
    expect(src).toContain('eq(patients.status, "active")');
    expect(src).toContain("clientName: `${client.firstName} ${client.lastName}`");
    expect(src).toContain("timezone: practice.timezone");
    expect(src).toContain("practice,\n        weights,");
    expect(src).toContain("isNull(patientWeights.deletedAt)");
    expect(src).toContain("isNull(patientAllergies.deletedAt)");
    expect(src).toContain("isNull(vaccinationRecords.deletedAt)");
    expect(src).toContain("isNull(prescriptions.deletedAt)");
    expect(src).toContain("lotNumber: vaccinationRecords.lotNumber");
    expect(src).toContain("manufacturer: vaccinationRecords.manufacturer");
  });

  it("returns bounded practice identity for portal vaccination certificates", () => {
    const profileHelper = src.match(
      /async function practicePortalProfile[\s\S]+?function formatPortalSlotTime/
    )?.[0];
    expect(src).toContain("async function practicePortalProfile");
    expect(src).toContain("name: practices.name");
    expect(src).toContain("address: practices.address");
    expect(src).toContain("phone: practices.phone");
    expect(src).toContain("email: practices.email");
    expect(profileHelper).toContain("where(activePracticeWhere(practiceId))");
    expect(profileHelper).toContain("throw invalidPortalLink()");
    expect(profileHelper).toContain('practice.name?.trim() || "Veterinary Practice"');
    expect(profileHelper).not.toContain("practice?.name");
    expect(src).toContain(
      "const practice = await practicePortalProfile(ctx.db, client.practiceId)"
    );
  });

  it("scopes portal pet-detail child records through the token client patient", () => {
    const weightsBlock = src.match(
      /\.from\(patientWeights\)[\s\S]+?\.orderBy\(desc\(patientWeights\.recordedAt\)\)/
    )?.[0];
    expect(weightsBlock).toContain(".innerJoin(");
    expect(weightsBlock).toContain("eq(patientWeights.patientId, patients.id)");
    expect(weightsBlock).toContain("eq(patients.id, input.patientId)");
    expect(weightsBlock).toContain("eq(patients.clientId, client.id)");
    expect(weightsBlock).toContain("eq(patients.practiceId, client.practiceId)");
    expect(weightsBlock).toContain('eq(patients.status, "active")');
    expect(weightsBlock).toContain("isNull(patients.deletedAt)");

    const allergiesBlock = src.match(
      /\.from\(patientAllergies\)[\s\S]+?eq\(patientAllergies\.patientId, input\.patientId\)[\s\S]+?\)/
    )?.[0];
    expect(allergiesBlock).toContain(".innerJoin(");
    expect(allergiesBlock).toContain(
      "eq(patientAllergies.patientId, patients.id)"
    );
    expect(allergiesBlock).toContain("eq(patients.id, input.patientId)");
    expect(allergiesBlock).toContain("eq(patients.clientId, client.id)");
    expect(allergiesBlock).toContain(
      "eq(patients.practiceId, client.practiceId)"
    );
    expect(allergiesBlock).toContain('eq(patients.status, "active")');
    expect(allergiesBlock).toContain("isNull(patients.deletedAt)");
    expect(allergiesBlock).toContain("not exists (");
    expect(allergiesBlock).toContain(
      "allergy_correction.patient_allergy_id = ${patientAllergies.id}"
    );

    const vaccinationsBlock = src.match(
      /\.from\(vaccinationRecords\)[\s\S]+?\.orderBy\(desc\(vaccinationRecords\.administeredAt\)\)/
    )?.[0];
    expect(vaccinationsBlock).toContain(".innerJoin(");
    expect(vaccinationsBlock).toContain(
      "eq(vaccinationRecords.patientId, patients.id)"
    );
    expect(vaccinationsBlock).toContain("eq(patients.id, input.patientId)");
    expect(vaccinationsBlock).toContain("eq(patients.clientId, client.id)");
    expect(vaccinationsBlock).toContain(
      "eq(patients.practiceId, client.practiceId)"
    );
    expect(vaccinationsBlock).toContain('eq(patients.status, "active")');
    expect(vaccinationsBlock).toContain("isNull(patients.deletedAt)");

    const prescriptionsBlock = src.match(
      /\.from\(prescriptions\)[\s\S]+?eq\(prescriptions\.patientId, input\.patientId\)[\s\S]+?\)/
    )?.[0];
    expect(prescriptionsBlock).toContain(".innerJoin(");
    expect(prescriptionsBlock).toContain(
      "eq(prescriptions.patientId, patients.id)"
    );
    expect(prescriptionsBlock).toContain("eq(patients.id, input.patientId)");
    expect(prescriptionsBlock).toContain("eq(patients.clientId, client.id)");
    expect(prescriptionsBlock).toContain(
      "eq(patients.practiceId, client.practiceId)"
    );
    expect(prescriptionsBlock).toContain('eq(patients.status, "active")');
    expect(prescriptionsBlock).toContain("isNull(patients.deletedAt)");
  });

  it("keeps portal patient list and booking patient validation practice-scoped", () => {
    const patientPracticeFilters = src.match(
      /eq\(patients\.practiceId, client\.practiceId\)/g
    );
    expect(patientPracticeFilters?.length).toBeGreaterThanOrEqual(3);
    const activePatientFilters = src.match(/eq\(patients\.status, "active"\)/g);
    expect(activePatientFilters?.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps portal doctor history tenant scoped after staff deactivation", () => {
    expect(src).toMatch(
      /leftJoin\(\s*users,\s*and\(\s*eq\(appointments\.doctorId, users\.id\),\s*eq\(users\.practiceId, client\.practiceId\)\s*\)\s*\)/s
    );
    expect(src).not.toMatch(
      /eq\(appointments\.doctorId, users\.id\)[\s\S]{0,120}?isNull\(users\.deletedAt\)/s
    );
  });

  it("returns the practice timezone with portal appointments for display", () => {
    expect(src).toContain(
      "const timezone = await practiceTimeZone(ctx.db, client.practiceId)"
    );
    expect(src).toContain("return rows.map((row) => ({");
    expect(src).toContain("...row,\n        timezone,");
  });
});
