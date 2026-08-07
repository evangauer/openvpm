import { afterEach, describe, it, expect, vi } from "vitest";
import {
  checkHostedEligibility,
  parseAvailableNumbers,
  searchAvailableNumbers,
  TelnyxNotConfiguredError,
  createA2pBrand,
  createA2pCampaign,
  ensureA2pNumberAssignment,
} from "../telnyx-provisioning";
import { TELNYX_API_TIMEOUT_MS } from "../telnyx-http";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseAvailableNumbers", () => {
  it("maps phone numbers and monthly cost", () => {
    expect(
      parseAvailableNumbers({
        data: [
          { phone_number: "+15555550100", cost_information: { monthly_cost: "1.00000" } },
          { phone_number: "+15555550101", cost_information: { monthly_cost: "1.00000" } },
        ],
      })
    ).toEqual([
      { phoneNumber: "+15555550100", monthlyCost: "1.00000" },
      { phoneNumber: "+15555550101", monthlyCost: "1.00000" },
    ]);
  });

  it("drops entries without a phone number and tolerates missing cost", () => {
    expect(
      parseAvailableNumbers({
        data: [{ cost_information: { monthly_cost: "1.0" } }, { phone_number: "+15555550100" }],
      })
    ).toEqual([{ phoneNumber: "+15555550100", monthlyCost: null }]);
  });

  it("returns [] for an empty/missing data array", () => {
    expect(parseAvailableNumbers({})).toEqual([]);
  });
});

describe("Telnyx provisioning requests", () => {
  it("searches available numbers with an authed timeout signal", async () => {
    vi.stubEnv("TELNYX_API_KEY", " KEY123 ");
    const fetchMock = vi.fn(
      async (
        _url: Parameters<typeof fetch>[0],
        _init?: Parameters<typeof fetch>[1]
      ) =>
        new Response(
          JSON.stringify({
            data: [
              {
                phone_number: "+15555550100",
                cost_information: { monthly_cost: "1.00000" },
              },
            ],
          })
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      searchAvailableNumbers({ areaCode: "555", limit: 3 })
    ).resolves.toEqual([
      { phoneNumber: "+15555550100", monthlyCost: "1.00000" },
    ]);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain(
      "https://api.telnyx.com/v2/available_phone_numbers?"
    );
    expect(String(url)).toContain("filter%5Bcountry_code%5D=US");
    expect(String(url)).toContain("filter%5Bfeatures%5D%5B%5D=sms");
    expect(String(url)).toContain("filter%5Blimit%5D=3");
    expect(String(url)).toContain("filter%5Bnational_destination_code%5D=555");
    expect(init).toEqual(
      expect.objectContaining({
        method: "GET",
        headers: {
          Authorization: "Bearer KEY123",
          "Content-Type": "application/json",
        },
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("treats a blank API key as unconfigured before provider requests", async () => {
    vi.stubEnv("TELNYX_API_KEY", "   ");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchAvailableNumbers({ limit: 1 })).rejects.toBeInstanceOf(
      TelnyxNotConfiguredError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts hung hosted eligibility checks", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          })
      )
    );

    const result = expect(checkHostedEligibility("+15555550100")).rejects.toThrow(
      "aborted"
    );
    await vi.advanceTimersByTimeAsync(TELNYX_API_TIMEOUT_MS);
    await result;
  });

  it("submits provider-compatible brand and campaign payloads", async () => {
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            brandId: "brand-1",
            identityStatus: "VERIFIED",
            status: "OK",
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            campaignId: "campaign-1",
            campaignStatus: "TCR_PENDING",
            submissionStatus: "PENDING",
          })
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createA2pBrand({
        entityType: "PRIVATE_PROFIT",
        displayName: "Healthy Pets",
        legalName: "Healthy Pets LLC",
        ein: "123456789",
        firstName: "Alex",
        lastName: "Vet",
        email: "alex@example.com",
        phone: "+15555550100",
        street: "1 Main St",
        city: "Denver",
        state: "CO",
        postalCode: "80202",
        website: "https://example.com",
        webhookUrl: "https://app.example.com/api/webhooks/telnyx",
      })
    ).resolves.toMatchObject({
      brandId: "brand-1",
      identityStatus: "VERIFIED",
    });

    await expect(
      createA2pCampaign({
        brandId: "brand-1",
        referenceId: "openvpm-clinic-1",
        displayName: "Healthy Pets",
        description: "Clinic reminders and support",
        sample1: "Sample one. Reply STOP to opt out.",
        sample2: "Sample two. Reply STOP to opt out.",
        sample3: "Sample three. Reply STOP to opt out.",
        messageFlow: "Clients opt in during intake.",
        helpMessage: "Reply HELP for help.",
        optinMessage: "You are subscribed.",
        optoutMessage: "You are unsubscribed.",
        privacyPolicyUrl: "https://example.com/privacy",
        termsUrl: "https://example.com/terms",
        webhookUrl: "https://app.example.com/api/webhooks/telnyx",
      })
    ).resolves.toMatchObject({
      campaignId: "campaign-1",
      campaignStatus: "TCR_PENDING",
    });

    const brandBody = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body)
    ) as Record<string, unknown>;
    expect(brandBody).toMatchObject({
      companyName: "Healthy Pets LLC",
      ein: "123456789",
      vertical: "HEALTHCARE",
      webhookURL: "https://app.example.com/api/webhooks/telnyx",
    });
    const campaignBody = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body)
    ) as Record<string, unknown>;
    expect(campaignBody).toMatchObject({
      usecase: "MIXED",
      referenceId: "openvpm-clinic-1",
      subscriberOptin: true,
      subscriberOptout: true,
      termsAndConditions: true,
      autoRenewal: true,
    });
  });

  it("reuses an existing number assignment and refuses a campaign mismatch", async () => {
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    const existing = {
      phoneNumber: "+15555550100",
      campaignId: "campaign-1",
      assignmentStatus: "ASSIGNED",
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(existing)));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      ensureA2pNumberAssignment({
        phoneNumber: "+15555550100",
        campaignId: "campaign-1",
      })
    ).resolves.toMatchObject(existing);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(
      ensureA2pNumberAssignment({
        phoneNumber: "+15555550100",
        campaignId: "campaign-2",
      })
    ).rejects.toMatchObject({ status: 409 });
  });
});
