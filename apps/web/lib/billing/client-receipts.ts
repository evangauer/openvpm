import { and, eq, isNull } from "drizzle-orm";
import { clients, invoices, patients, practices } from "@openpims/db";
import { db as systemDb, type Database } from "@openpims/db/client";
import { sendClientPaymentReceiptEmail } from "@/lib/email";
import { formatCurrency } from "@/lib/locale/format";
import { centsToMoney } from "@/lib/billing/invoice-balance";
import { lockPracticeForExternalSideEffects } from "@/lib/recovery-hold";
import { withSystem } from "@/lib/tenant-db";

/**
 * Everything needed to email a pet owner a receipt after a payment lands —
 * gathered inside the recording transaction, delivered after commit so a
 * failed email never rolls back money state.
 */
export type ClientReceipt = {
  practiceId: string;
  to: string;
  clientName: string;
  patientName?: string;
  practiceName: string;
  practicePhone?: string;
  currency: string;
  country: string;
  amountPaidCents: number;
  balanceRemainingCents: number;
};

/**
 * Load receipt context for an invoice payment. Returns null when the client
 * has no email on file (nothing to send) or the invoice chain is missing.
 */
export async function loadClientReceipt(
  db: Database,
  invoiceId: string,
  amounts: { amountPaidCents: number; balanceRemainingCents: number }
): Promise<ClientReceipt | null> {
  const [row] = await db
    .select({
      clientEmail: clients.email,
      clientFirstName: clients.firstName,
      clientLastName: clients.lastName,
      patientName: patients.name,
      practiceId: practices.id,
      practiceName: practices.name,
      practicePhone: practices.phone,
      currency: practices.currency,
      country: practices.country,
    })
    .from(invoices)
    .innerJoin(
      clients,
      and(
        eq(invoices.clientId, clients.id),
        eq(clients.practiceId, invoices.practiceId),
        isNull(clients.deletedAt)
      )
    )
    .innerJoin(
      practices,
      and(eq(invoices.practiceId, practices.id), isNull(practices.deletedAt))
    )
    .leftJoin(
      patients,
      and(
        eq(invoices.patientId, patients.id),
        eq(patients.clientId, invoices.clientId),
        eq(patients.practiceId, invoices.practiceId),
        isNull(patients.deletedAt)
      )
    )
    .where(and(eq(invoices.id, invoiceId), isNull(invoices.deletedAt)))
    .limit(1);

  if (!row?.clientEmail) return null;

  return {
    practiceId: row.practiceId,
    to: row.clientEmail,
    clientName: [row.clientFirstName, row.clientLastName]
      .filter(Boolean)
      .join(" "),
    patientName: row.patientName ?? undefined,
    practiceName: row.practiceName,
    practicePhone: row.practicePhone ?? undefined,
    currency: row.currency ?? "usd",
    country: row.country ?? "US",
    amountPaidCents: amounts.amountPaidCents,
    balanceRemainingCents: Math.max(0, amounts.balanceRemainingCents),
  };
}

/** Send the receipt. Never throws — a lost email must not fail a payment. */
export async function deliverClientReceipt(
  receipt: ClientReceipt
): Promise<void> {
  try {
    await withSystem(systemDb, async (tx) => {
      const deliveryAllowed = await lockPracticeForExternalSideEffects(
        tx,
        receipt.practiceId
      );
      if (!deliveryAllowed) {
        console.warn(
          `[client-receipt] delivery paused by recovery hold practice=${receipt.practiceId}`
        );
        return;
      }
      const result = await sendClientPaymentReceiptEmail({
        to: receipt.to,
        clientName: receipt.clientName,
        patientName: receipt.patientName,
        amountPaid: formatCurrency(
          centsToMoney(receipt.amountPaidCents),
          receipt.currency,
          receipt.country
        ),
        balanceRemaining: formatCurrency(
          centsToMoney(receipt.balanceRemainingCents),
          receipt.currency,
          receipt.country
        ),
        fullyPaid: receipt.balanceRemainingCents <= 0,
        practiceName: receipt.practiceName,
        practicePhone: receipt.practicePhone,
      });
      if (!result.success) {
        console.error("[client-receipt] send failed:", result.error);
      }
    });
  } catch (err) {
    console.error("[client-receipt] send failed:", err);
  }
}
