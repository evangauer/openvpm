import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import { invoices, payments } from "@openpims/db";
import { withTenant } from "@/lib/tenant-db";
import { billingRouter } from "../../routers/billing";
import { dashboardRouter } from "../../routers/dashboard";
import { reportsRouter } from "../../routers/reports";
import type { runGoldenClinic } from "./golden-clinic";

/** Exercise the cash ledger against real SQL, after the golden visit has collected 19.44. */
export async function runCollectionRegression(clinic: Awaited<ReturnType<typeof runGoldenClinic>>) {
  const ctx = clinic.context();
  const billing = billingRouter.createCaller(ctx);
  const dashboard = dashboardRouter.createCaller(ctx);
  const reports = reportsRouter.createCaller(ctx);
  const makeInvoice = () => billing.createInvoice({
    clientId: clinic.client.id,
    patientId: clinic.patient.id,
    items: [{ description: "Synthetic consultation", quantity: 1, unitPrice: "21.00", itemType: "service" }],
  });
  const refunded = await makeInvoice();
  await billing.updateInvoiceStatus({ id: refunded.id, status: "sent" });
  await billing.recordPayment({ invoiceId: refunded.id, amount: refunded.total, method: "cash", operationId: randomUUID() });
  const [payment] = await billing.listPayments({ invoiceId: refunded.id });
  await billing.refundPayment({ paymentId: payment!.id, reason: "Synthetic acceptance refund" });
  await expect(billing.voidInvoice({ id: refunded.id, reason: "Synthetic cancellation" })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: expect.stringContaining("Apply a credit"),
  });
  await billing.applyInvoiceAdjustment({ invoiceId: refunded.id, operationId: randomUUID(), type: "credit", amount: refunded.total, reason: "Synthetic cancellation credit" });
  expect(await billing.getInvoice({ id: refunded.id })).toMatchObject({ status: "paid", paidAmount: "0.00" });
  expect((await reports.revenue()).total).toBe(19.44);
  expect((await dashboard.getStats()).revenueMtd).toBe(19.44);

  // A credit-only settlement is not cash, while a partial payment is cash even
  // though the invoice is not paid and was issued in an earlier period.
  const credited = await makeInvoice();
  await billing.updateInvoiceStatus({ id: credited.id, status: "sent" });
  await billing.applyInvoiceAdjustment({ invoiceId: credited.id, operationId: randomUUID(), type: "credit", amount: credited.total, reason: "Synthetic courtesy credit" });
  const partial = await makeInvoice();
  await billing.updateInvoiceStatus({ id: partial.id, status: "sent" });
  await withTenant(ctx.db, clinic.practice.id, tx => tx.update(invoices).set({ createdAt: new Date("2020-01-01T12:00:00Z") }).where(eq(invoices.id, partial.id)));
  await billing.recordPayment({ invoiceId: partial.id, amount: "10.00", method: "cash", operationId: randomUUID() });
  expect((await reports.revenue()).total).toBe(29.44);
  expect((await dashboard.getStats()).revenueMtd).toBe(29.44);
  const charts = await dashboard.getCharts();
  expect(charts.revenueByDay.reduce((sum, day) => sum + day.revenue, 0)).toBeCloseTo(29.44);
  expect(charts.productionByDoctor.reduce((sum, doctor) => sum + doctor.production, 0)).toBeCloseTo(29.44);

  expect((await reportsRouter.createCaller(clinic.context(clinic.foreignDoctor)).revenue()).total).toBe(0);
  const [partialPayment] = await billing.listPayments({ invoiceId: partial.id });
  await withTenant(ctx.db, clinic.practice.id, tx => tx.update(payments).set({ deletedAt: new Date() }).where(eq(payments.id, partialPayment!.id)));
  expect((await reports.revenue()).total).toBe(19.44);
  await withTenant(ctx.db, clinic.practice.id, tx => tx.update(payments).set({ deletedAt: null }).where(eq(payments.id, partialPayment!.id)));

  // Receiving and refunding in different periods must yield a negative refund
  // period, even after a credit closes the invoice. Use historical dates so
  // this also proves the report is independent of invoice creation time.
  const ledger = await billing.listPayments({ invoiceId: refunded.id });
  const refund = ledger.find(row => Number(row.amount) < 0)!;
  await withTenant(ctx.db, clinic.practice.id, async tx => {
    await tx.update(payments).set({ receivedAt: new Date("2020-01-31T23:59:59Z") }).where(eq(payments.id, payment!.id));
    await tx.update(payments).set({ receivedAt: new Date("2020-02-01T00:00:00Z") }).where(eq(payments.id, refund.id));
  });
  const january = await reports.revenue({ startDate: "2020-01-31", endDate: "2020-01-31" });
  const february = await reports.revenue({ startDate: "2020-02-01", endDate: "2020-02-01" });
  expect(january.total).toBe(Number(refunded.total));
  expect(february.total).toBe(-Number(refunded.total));
  expect(february.daily).toEqual([{ date: "2020-02-01", amount: -Number(refunded.total) }]);
}
