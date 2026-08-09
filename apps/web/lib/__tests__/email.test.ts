import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const resendSend = vi.fn();
  return {
    billingEnforced: vi.fn(() => false),
    resendSend,
    Resend: vi.fn(() => ({
      emails: { send: resendSend },
    })),
  };
});

vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: mocks.billingEnforced,
}));

vi.mock("resend", () => ({
  Resend: mocks.Resend,
}));

async function loadEmail() {
  vi.resetModules();
  return import("../email");
}

async function loadEmailBrand() {
  vi.resetModules();
  return import("@openpims/email");
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  mocks.billingEnforced.mockReturnValue(false);
  mocks.resendSend.mockReset();
  mocks.Resend.mockImplementation(() => ({
    emails: { send: mocks.resendSend },
  }));
});

describe("sendEmail", () => {
  it("logs to console in self-hosted/dev mode without Resend", async () => {
    const consoleLog = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const { sendEmail } = await loadEmail();

    await expect(
      sendEmail({
        to: "client@example.com",
        subject: "Reminder",
        html: "<p>Hello</p>",
      }),
    ).resolves.toEqual({ success: true, id: "dev-console" });

    expect(consoleLog).toHaveBeenCalledWith(
      "[Email] No RESEND_API_KEY configured – logging email to console",
    );
    expect(mocks.Resend).not.toHaveBeenCalled();
    consoleLog.mockRestore();
  });

  it("fails closed in hosted mode without Resend", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    const consoleLog = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const { sendEmail } = await loadEmail();

    await expect(
      sendEmail({
        to: "client@example.com",
        subject: "Reminder",
        html: "<p>Hello</p>",
      }),
    ).resolves.toEqual({
      success: false,
      error: "Email provider is not configured for hosted sending.",
    });

    expect(consoleLog).not.toHaveBeenCalled();
    expect(mocks.Resend).not.toHaveBeenCalled();
    consoleLog.mockRestore();
  });

  it("treats a blank Resend API key as missing in hosted mode", async () => {
    vi.stubEnv("RESEND_API_KEY", "   ");
    mocks.billingEnforced.mockReturnValue(true);
    const consoleLog = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const { sendEmail } = await loadEmail();

    await expect(
      sendEmail({
        to: "client@example.com",
        subject: "Reminder",
        html: "<p>Hello</p>",
      }),
    ).resolves.toEqual({
      success: false,
      error: "Email provider is not configured for hosted sending.",
    });

    expect(consoleLog).not.toHaveBeenCalled();
    expect(mocks.Resend).not.toHaveBeenCalled();
    consoleLog.mockRestore();
  });

  it("keeps the console fallback available in demo mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", " true ");
    mocks.billingEnforced.mockReturnValue(true);
    const consoleLog = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const { sendEmail } = await loadEmail();

    await expect(
      sendEmail({
        to: "client@example.com",
        subject: "Reminder",
        html: "<p>Hello</p>",
      }),
    ).resolves.toEqual({ success: true, id: "dev-console" });

    expect(consoleLog).toHaveBeenCalled();
    consoleLog.mockRestore();
  });

  it("uses Resend when a provider key is configured", async () => {
    vi.stubEnv("RESEND_API_KEY", " re_test ");
    vi.stubEnv("EMAIL_FROM", " OpenVPM <clinic@example.com> ");
    mocks.billingEnforced.mockReturnValue(true);
    mocks.resendSend.mockResolvedValue({ data: { id: "email-1" } });
    const { EMAIL_SEND_TIMEOUT_MS, sendEmail } = await loadEmail();

    await expect(
      sendEmail({
        to: "client@example.com",
        subject: "Reminder",
        html: "<p>Hello</p>",
      }),
    ).resolves.toEqual({ success: true, id: "email-1" });

    expect(mocks.Resend).toHaveBeenCalledWith("re_test");
    expect(mocks.resendSend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "OpenVPM <clinic@example.com>",
        to: "client@example.com",
        subject: "Reminder",
      }),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
    expect(EMAIL_SEND_TIMEOUT_MS).toBe(10_000);
  });

  it("falls back from blank from/reply-to values before sending", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM", "   ");
    mocks.resendSend.mockResolvedValue({ data: { id: "email-1" } });
    const { sendEmail } = await loadEmail();

    await expect(
      sendEmail({
        to: "client@example.com",
        from: "\t",
        replyTo: " ",
        subject: "Reminder",
        html: "<p>Hello</p>",
      }),
    ).resolves.toEqual({ success: true, id: "email-1" });

    const [payload] = mocks.resendSend.mock.calls[0] ?? [];
    expect(payload).toMatchObject({
      from: "OpenVPM <noreply@mail.openvpm.com>",
      to: "client@example.com",
      subject: "Reminder",
    });
    expect(payload).not.toHaveProperty("replyTo");
  });

  it("keeps provider ids on notification template helper results", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    mocks.resendSend
      .mockResolvedValueOnce({ data: { id: "email-appt-1" } })
      .mockResolvedValueOnce({ data: { id: "email-vax-1" } })
      .mockResolvedValueOnce({ data: { id: "email-invoice-1" } });
    const {
      sendAppointmentReminder,
      sendInvoiceEmail,
      sendVaccinationReminder,
    } = await loadEmail();

    await expect(
      sendAppointmentReminder({
        to: "client@example.com",
        clientName: "Ada Lovelace",
        patientName: "Miso",
        appointmentDate: "July 2",
        appointmentTime: "9:00 AM",
        practiceName: "Neighborhood Veterinary",
      }),
    ).resolves.toMatchObject({ success: true, id: "email-appt-1" });

    await expect(
      sendVaccinationReminder({
        to: "client@example.com",
        clientName: "Ada Lovelace",
        patientName: "Miso",
        vaccineName: "Rabies",
        dueDate: "July 2",
        practiceName: "Neighborhood Veterinary",
      }),
    ).resolves.toMatchObject({ success: true, id: "email-vax-1" });

    await expect(
      sendInvoiceEmail({
        to: "client@example.com",
        clientName: "Ada Lovelace",
        invoiceTotal: "$123.45",
        practiceName: "Neighborhood Veterinary",
      }),
    ).resolves.toMatchObject({ success: true, id: "email-invoice-1" });
  });

  it("keeps verification provider evidence and says the trial is already active", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    mocks.resendSend.mockResolvedValue({ data: { id: "email-verify-1" } });
    const { sendVerificationEmail } = await loadEmail();

    await expect(
      sendVerificationEmail({
        to: "admin@example.com",
        name: "Dr Admin",
        verifyUrl: "https://app.openvpm.com/verify-email?token=safe-token",
      }),
    ).resolves.toEqual({ success: true, id: "email-verify-1" });

    const [payload] = mocks.resendSend.mock.calls[0] ?? [];
    expect(payload).toMatchObject({
      to: "admin@example.com",
      subject: "Verify your OpenVPM email",
    });
    expect(payload.html).toContain("Your trial is already active.");
    expect(payload.html).toContain("Confirm email");
    expect(payload.html).not.toMatch(
      /activate your account|start your free trial/i,
    );
  });

  it("attaches a durable attempt tag and Resend idempotency key to tracked verification", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    mocks.resendSend.mockResolvedValue({ data: { id: "email-verify-1" } });
    const { sendVerificationEmailWithProviderEvidence } = await loadEmail();
    const attemptId = "00000000-0000-4000-8000-000000000001";

    await expect(
      sendVerificationEmailWithProviderEvidence({
        to: "admin@example.com",
        name: "Dr Admin",
        verifyUrl: "https://app.openvpm.com/verify-email?token=safe-token",
        attemptId,
        idempotencyKey: `auth-email:${attemptId}`,
      }),
    ).resolves.toEqual({
      success: true,
      provider: "resend",
      id: "email-verify-1",
      outcome: "accepted",
    });

    expect(mocks.resendSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: [
          { name: "openvpm_attempt_id", value: attemptId },
          { name: "openvpm_email_kind", value: "auth_verification" },
        ],
      }),
      expect.objectContaining({ idempotencyKey: `auth-email:${attemptId}` }),
    );
  });

  it("redacts the auth recipient from development fallback logs", async () => {
    const consoleLog = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const { sendVerificationEmailWithProviderEvidence } = await loadEmail();

    await expect(
      sendVerificationEmailWithProviderEvidence({
        to: "private-owner@example.com",
        name: "Dr Admin",
        verifyUrl: "https://app.openvpm.com/verify-email?token=safe-token",
        attemptId: "00000000-0000-4000-8000-000000000001",
        idempotencyKey: "auth-email:00000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toMatchObject({
      success: true,
      provider: "console",
      id: "dev-console:auth-email:00000000-0000-4000-8000-000000000001",
      outcome: "accepted",
    });

    expect(consoleLog).toHaveBeenCalledWith(
      "  To:      [redacted auth recipient]",
    );
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain(
      "private-owner@example.com",
    );
    consoleLog.mockRestore();
  });

  it("models hosted missing configuration as a definite Resend failure", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    const { sendVerificationEmailWithProviderEvidence } = await loadEmail();

    await expect(
      sendVerificationEmailWithProviderEvidence({
        to: "private-owner@example.com",
        name: "Dr Admin",
        verifyUrl: "https://app.openvpm.com/verify-email?token=safe-token",
        attemptId: "00000000-0000-4000-8000-000000000001",
        idempotencyKey: "auth-email:00000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toMatchObject({
      success: false,
      provider: "resend",
      outcome: "definite_failure",
      failureCode: "provider_not_configured",
    });
    expect(mocks.resendSend).not.toHaveBeenCalled();
  });

  it("redacts auth verification provider rejection detail from logs", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.resendSend.mockResolvedValue({
      data: null,
      error: {
        message: "Rejected private-owner@example.com",
        name: "validation_error",
        statusCode: 422,
      },
    });
    const { sendVerificationEmailWithProviderEvidence } = await loadEmail();

    await expect(
      sendVerificationEmailWithProviderEvidence({
        to: "private-owner@example.com",
        name: "Dr Admin",
        verifyUrl: "https://app.openvpm.com/verify-email?token=safe-token",
        attemptId: "00000000-0000-4000-8000-000000000001",
        idempotencyKey: "auth-email:00000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toMatchObject({
      success: false,
      outcome: "definite_failure",
      failureCode: "provider_rejected",
    });

    expect(consoleError).toHaveBeenCalledWith(
      "[Email] Resend error:",
      "auth verification provider rejection",
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      "private-owner@example.com",
    );
    consoleError.mockRestore();
  });

  it("classifies a missing provider id as an unknown outcome", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    mocks.resendSend.mockResolvedValue({ data: null, error: null });
    const { sendVerificationEmailWithProviderEvidence } = await loadEmail();

    await expect(
      sendVerificationEmailWithProviderEvidence({
        to: "admin@example.com",
        name: "Dr Admin",
        verifyUrl: "https://app.openvpm.com/verify-email?token=safe-token",
        attemptId: "00000000-0000-4000-8000-000000000001",
        idempotencyKey: "auth-email:00000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toMatchObject({
      success: false,
      outcome: "outcome_unknown",
      failureCode: "missing_provider_id",
    });
  });

  it("aborts hung Resend sends and returns a timeout error", async () => {
    vi.useFakeTimers();
    vi.stubEnv("RESEND_API_KEY", "re_test");
    mocks.billingEnforced.mockReturnValue(true);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.resendSend.mockImplementation(
      (_payload: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          options?.signal?.addEventListener("abort", () => {
            resolve({
              data: null,
              error: {
                message:
                  "Unable to fetch data. The request could not be resolved.",
                statusCode: null,
                name: "application_error",
              },
            });
          });
        }),
    );
    const { EMAIL_SEND_TIMEOUT_MS, sendEmail } = await loadEmail();

    const result = sendEmail({
      to: "client@example.com",
      subject: "Reminder",
      html: "<p>Hello</p>",
    });
    await vi.advanceTimersByTimeAsync(EMAIL_SEND_TIMEOUT_MS);

    await expect(result).resolves.toEqual({
      success: false,
      error: `Email send timed out after ${EMAIL_SEND_TIMEOUT_MS}ms`,
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[Email] Resend error:",
      expect.objectContaining({ name: "application_error" }),
    );
  });
});

describe("openvpmBrand", () => {
  it("trims configured email brand env values", async () => {
    vi.stubEnv("EMAIL_COMPANY_NAME", " Open Vet Ops ");
    vi.stubEnv("EMAIL_SUPPORT_ADDRESS", " support@example.com ");
    vi.stubEnv("EMAIL_COMPANY_ADDRESS", " 123 Clinic Way ");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", " https://app.example.com ");
    vi.stubEnv("EMAIL_LOGO_URL", " https://cdn.example.com/logo.png ");
    const { openvpmBrand } = await loadEmailBrand();

    expect(openvpmBrand()).toMatchObject({
      name: "OpenVPM",
      companyName: "Open Vet Ops",
      supportEmail: "support@example.com",
      companyAddress: "123 Clinic Way",
      appUrl: "https://app.example.com",
      logoUrl: "https://cdn.example.com/logo.png",
    });
  });

  it("falls back from blank email brand env values", async () => {
    vi.stubEnv("EMAIL_COMPANY_NAME", "   ");
    vi.stubEnv("EMAIL_SUPPORT_ADDRESS", "\t");
    vi.stubEnv("EMAIL_COMPANY_ADDRESS", "\n");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", " ");
    vi.stubEnv("EMAIL_LOGO_URL", "   ");
    const { openvpmBrand } = await loadEmailBrand();

    expect(openvpmBrand()).toMatchObject({
      companyName: "OpenVPM",
      supportEmail: "support@openvpm.com",
      appUrl: "https://app.openvpm.com",
    });
    expect(openvpmBrand().companyAddress).toBeUndefined();
    expect(openvpmBrand().logoUrl).toBeUndefined();
  });
});

describe("lifecycle email branding", () => {
  it("uses the normalized brand support email as lifecycle reply-to", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_SUPPORT_ADDRESS", " support@example.com ");
    mocks.resendSend.mockResolvedValue({ data: { id: "email-1" } });
    const { sendWelcomeEmail } = await loadEmail();

    await expect(
      sendWelcomeEmail({
        to: "owner@example.com",
        practiceName: "Neighborhood Veterinary",
        trialDays: 14,
      }),
    ).resolves.toEqual({ success: true, id: "email-1" });

    const [payload] = mocks.resendSend.mock.calls[0] ?? [];
    expect(payload).toEqual(
      expect.objectContaining({
        replyTo: "support@example.com",
        to: "owner@example.com",
      }),
    );
  });

  it("falls back from a blank support email before lifecycle sends", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_SUPPORT_ADDRESS", "   ");
    mocks.resendSend.mockResolvedValue({ data: { id: "email-1" } });
    const { sendPaymentReceiptEmail } = await loadEmail();

    await expect(
      sendPaymentReceiptEmail({
        to: "owner@example.com",
        practiceName: "Neighborhood Veterinary",
        amount: "$79.00",
        periodLabel: "July 2026",
      }),
    ).resolves.toEqual({ success: true, id: "email-1" });

    const [payload] = mocks.resendSend.mock.calls[0] ?? [];
    expect(payload).toEqual(
      expect.objectContaining({
        replyTo: "support@openvpm.com",
        to: "owner@example.com",
      }),
    );
  });
});
