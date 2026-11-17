import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(
    async (): Promise<{ success: boolean; id?: string; error?: string }> => ({
      success: true,
      id: "email_1",
    }),
  ),
  alertOps: vi.fn(async () => undefined),
}));

vi.mock("@/lib/email", () => ({
  sendEmail: mocks.sendEmail,
}));

vi.mock("@/lib/alerts", () => ({
  alertOps: mocks.alertOps,
}));

const { notifyNewClinic } = await import("../new-clinic-alert");

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.sendEmail.mockResolvedValue({ success: true, id: "email_1" });
});

describe("notifyNewClinic", () => {
  it("sends from the platform mail.openvpm.com sender", async () => {
    vi.stubEnv("NEW_CLINIC_ALERT_EMAIL", " ops-alerts@example.com ");
    vi.stubEnv("EMAIL_FROM", "");

    await notifyNewClinic({
      practiceId: "practice-1",
      practiceName: "Neighborhood <Veterinary>",
    });

    expect(mocks.sendEmail).toHaveBeenCalledWith({
      to: "ops-alerts@example.com",
      subject: "New OpenVPM clinic: Neighborhood <Veterinary> [practice-1]",
      html: "<p>New OpenVPM clinic: Neighborhood &lt;Veterinary&gt; [practice-1]</p>",
      from: "OpenVPM <noreply@mail.openvpm.com>",
      idempotencyKey: "new-clinic:practice-1",
    });
    expect(mocks.alertOps).not.toHaveBeenCalled();
  });

  it("does nothing when the recipient env is unset", async () => {
    vi.stubEnv("NEW_CLINIC_ALERT_EMAIL", "");

    await notifyNewClinic({
      practiceId: "practice-1",
      practiceName: "Neighborhood Veterinary",
    });

    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.alertOps).not.toHaveBeenCalled();
  });

  it("logs and alerts a provider failure without throwing", async () => {
    vi.stubEnv("NEW_CLINIC_ALERT_EMAIL", "ops-alerts@example.com");
    mocks.sendEmail.mockResolvedValueOnce({
      success: false,
      error: "provider rejected",
    });
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      notifyNewClinic({
        practiceId: "practice-1",
        practiceName: "Neighborhood Veterinary",
      }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith("[register] new clinic alert failed");
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "New clinic alert failed",
      "New OpenVPM clinic: Neighborhood Veterinary [practice-1]: provider rejected",
    );
    errorSpy.mockRestore();
  });
});
