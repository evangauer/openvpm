import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendClientPaymentReceiptEmail: vi.fn(async () => ({ success: true })),
  lockPracticeForExternalSideEffects: vi.fn(async () => true),
  withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
  ),
}));

vi.mock("@openpims/db/client", () => ({ db: {} }));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
}));

vi.mock("@/lib/recovery-hold", () => ({
  lockPracticeForExternalSideEffects:
    mocks.lockPracticeForExternalSideEffects,
}));

vi.mock("@/lib/email", () => ({
  sendClientPaymentReceiptEmail: mocks.sendClientPaymentReceiptEmail,
}));

const { deliverClientReceipt, loadClientReceipt } = await import(
  "../client-receipts"
);

function dbWithRow(row: unknown) {
  const builder = {
    from: vi.fn(() => builder),
    innerJoin: vi.fn(() => builder),
    leftJoin: vi.fn(() => builder),
    where: vi.fn(() => builder),
    limit: vi.fn(async () => (row ? [row] : [])),
  };
  return { select: vi.fn(() => builder) } as never;
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.sendClientPaymentReceiptEmail.mockResolvedValue({ success: true });
  mocks.lockPracticeForExternalSideEffects.mockResolvedValue(true);
});

describe("loadClientReceipt", () => {
  it("assembles the receipt context and clamps negative balances", async () => {
    const receipt = await loadClientReceipt(
      dbWithRow({
        clientEmail: "jane@example.com",
        clientFirstName: "Jane",
        clientLastName: "Client",
        patientName: "Biscuit",
        practiceId: "practice-1",
        practiceName: "Neighborhood Veterinary",
        practicePhone: "(555) 867-5309",
        currency: "usd",
        country: "US",
      }),
      "invoice-1",
      { amountPaidCents: 12500, balanceRemainingCents: -3 }
    );

    expect(receipt).toEqual({
      practiceId: "practice-1",
      to: "jane@example.com",
      clientName: "Jane Client",
      patientName: "Biscuit",
      practiceName: "Neighborhood Veterinary",
      practicePhone: "(555) 867-5309",
      currency: "usd",
      country: "US",
      amountPaidCents: 12500,
      balanceRemainingCents: 0,
    });
  });

  it("returns null when the client has no email on file", async () => {
    await expect(
      loadClientReceipt(
        dbWithRow({ clientEmail: null, clientFirstName: "Jane" }),
        "invoice-1",
        { amountPaidCents: 100, balanceRemainingCents: 0 }
      )
    ).resolves.toBeNull();
    await expect(
      loadClientReceipt(dbWithRow(null), "invoice-1", {
        amountPaidCents: 100,
        balanceRemainingCents: 0,
      })
    ).resolves.toBeNull();
  });
});

describe("deliverClientReceipt", () => {
  const receipt = {
    practiceId: "practice-1",
    to: "jane@example.com",
    clientName: "Jane Client",
    patientName: "Biscuit",
    practiceName: "Neighborhood Veterinary",
    practicePhone: undefined,
    currency: "usd",
    country: "US",
    amountPaidCents: 12500,
    balanceRemainingCents: 2500,
  };

  it("formats amounts in the practice currency and flags partial payments", async () => {
    await deliverClientReceipt(receipt);

    expect(mocks.sendClientPaymentReceiptEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "jane@example.com",
        amountPaid: "$125.00",
        balanceRemaining: "$25.00",
        fullyPaid: false,
        practiceName: "Neighborhood Veterinary",
      })
    );
  });

  it("marks a zero balance as fully paid", async () => {
    await deliverClientReceipt({ ...receipt, balanceRemainingCents: 0 });

    expect(mocks.sendClientPaymentReceiptEmail).toHaveBeenCalledWith(
      expect.objectContaining({ fullyPaid: true })
    );
  });

  it("does not call the email provider while the practice is held", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.lockPracticeForExternalSideEffects.mockResolvedValueOnce(false);

    await expect(deliverClientReceipt(receipt)).resolves.toBeUndefined();

    expect(mocks.sendClientPaymentReceiptEmail).not.toHaveBeenCalled();
    expect(mocks.lockPracticeForExternalSideEffects).toHaveBeenCalledWith(
      {},
      "practice-1",
    );
    warning.mockRestore();
  });

  it("never throws when sending fails", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.sendClientPaymentReceiptEmail.mockRejectedValueOnce(
      new Error("smtp down")
    );

    await expect(deliverClientReceipt(receipt)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
