import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../routers/billing.ts", import.meta.url),
  "utf8"
);

describe("billing query scoping", () => {
  it("keeps invoice client and patient display joins tenant scoped and active", () => {
    const clientLeftJoins =
      source.match(
        /leftJoin\(\s*clients,\s*and\(\s*eq\(invoices\.clientId, clients\.id\),\s*eq\(clients\.practiceId, ctx\.practiceId\),\s*isNull\(clients\.deletedAt\)\s*,?\s*\)\s*,?\s*\)/gs
      ) ?? [];
    const patientLeftJoins =
      source.match(
        /leftJoin\(\s*patients,\s*and\(\s*eq\(invoices\.patientId, patients\.id\),\s*eq\(patients\.clientId, invoices\.clientId\),\s*eq\(patients\.practiceId, ctx\.practiceId\),\s*isNull\(patients\.deletedAt\)\s*,?\s*\)\s*,?\s*\)/gs
      ) ?? [];

    expect(clientLeftJoins.length).toBeGreaterThanOrEqual(2);
    expect(patientLeftJoins.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps checkout client and practice joins tenant scoped and active", () => {
    expect(source).toMatch(
      /innerJoin\(\s*clients,\s*and\(\s*eq\(invoices\.clientId, clients\.id\),\s*eq\(clients\.practiceId, ctx\.practiceId\),\s*isNull\(clients\.deletedAt\)\s*,?\s*\)\s*,?\s*\)/s
    );
    expect(source).toMatch(
      /leftJoin\(\s*practices,\s*and\(\s*eq\(invoices\.practiceId, practices\.id\),\s*eq\(practices\.id, ctx\.practiceId\),\s*isNull\(practices\.deletedAt\)\s*,?\s*\)\s*,?\s*\)/s
    );
  });

  it("requires an active practice before exposing billing tax config", () => {
    const taxConfigBlock = source.slice(
      source.indexOf("getTaxConfig: protectedProcedure"),
      source.indexOf("listInvoices:", source.indexOf("getTaxConfig: protectedProcedure"))
    );
    expect(source).toContain("function activePracticeWhere");
    expect(taxConfigBlock).toContain("where(activePracticeWhere(ctx.practiceId))");
    expect(taxConfigBlock).toContain("throw practiceNotFound()");
  });

  it("requires an active practice before creating invoices", () => {
    const createInvoiceBlock = source.slice(
      source.indexOf("createInvoice: protectedProcedure"),
      source.indexOf("searchInvoices:", source.indexOf("createInvoice: protectedProcedure"))
    );
    expect(createInvoiceBlock).toContain("where(activePracticeWhere(ctx.practiceId))");
    expect(createInvoiceBlock).toContain("if (!practice) {");
    expect(createInvoiceBlock).toContain("throw practiceNotFound()");
  });

  it("keeps billing staff display joins tenant scoped and active", () => {
    expect(source).toMatch(
      /leftJoin\(\s*users,\s*and\(\s*eq\(payments\.receivedBy, users\.id\),\s*eq\(users\.practiceId, ctx\.practiceId\),\s*isNull\(users\.deletedAt\)\s*,?\s*\)\s*,?\s*\)/s
    );
    expect(source).toMatch(
      /leftJoin\(\s*users,\s*and\(\s*eq\(invoiceAdjustments\.createdBy, users\.id\),\s*eq\(users\.practiceId, ctx\.practiceId\),\s*isNull\(users\.deletedAt\)\s*,?\s*\)\s*,?\s*\)/s
    );
  });

  it("keeps billing child ledger reads scoped through their parent invoice", () => {
    expect(source).toContain("function invoiceItemPracticeScope");
    expect(source).toContain("function paymentPracticeScope");
    expect(source).toContain("function adjustmentPracticeScope");
    expect(source).toContain("where ${invoices.id} = ${invoiceItems.invoiceId}");
    expect(source).toContain("where ${invoices.id} = ${payments.invoiceId}");
    expect(source).toContain(
      "where ${invoices.id} = ${invoiceAdjustments.invoiceId}"
    );
    expect(source.match(/invoiceItemPracticeScope\(ctx\)/g)?.length).toBeGreaterThanOrEqual(
      2
    );
    expect(source.match(/paymentPracticeScope\(ctx\)/g)?.length).toBeGreaterThanOrEqual(
      1
    );
    expect(
      source.match(/adjustmentPracticeScope\(ctx\)/g)?.length
    ).toBeGreaterThanOrEqual(2);
  });
});
