import { afterEach, describe, it, expect, vi } from "vitest";
import {
  checkHostedEligibility,
  parseAvailableNumbers,
  searchAvailableNumbers,
  TelnyxNotConfiguredError,
  TelnyxMutationUncertainError,
  createMessagingProfile,
  ensureMessagingProfileAutoresponses,
  getMessagingProfile,
  getMessagingProfileAutoresponses,
  messagingProfileAutoresponseSafetyIssues,
  OPENVPM_MESSAGING_PROFILE_AUTORESPONSES,
  messagingProfileSafetyIssues,
  openVpmMessagingProfileName,
  updateMessagingProfileEnabled,
  buyNumber,
  deleteMessagingProfile,
  deleteOwnedPhoneNumber,
  findMessagingProfilesByName,
  findOwnedPhoneNumbers,
  findAvailableNumberQuotes,
  findNumberOrdersByCustomerReference,
  findA2pCampaignByReference,
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

function autoresponseInventoryResponse(
  data: unknown[],
  meta?: Partial<{
    page_number: number;
    page_size: number;
    total_pages: number;
    total_results: number;
  }>,
) {
  return new Response(
    JSON.stringify({
      data,
      meta: {
        page_number: 1,
        page_size: 100,
        total_pages: 1,
        total_results: data.length,
        ...meta,
      },
    }),
  );
}

describe("parseAvailableNumbers", () => {
  it("maps phone numbers only when the complete provider quote is present", () => {
    expect(
      parseAvailableNumbers({
        data: [
          {
            phone_number: "+15555550100",
            cost_information: {
              upfront_cost: "3.21000",
              monthly_cost: "1.00000",
              currency: "USD",
            },
          },
          {
            phone_number: "+15555550101",
            cost_information: {
              upfront_cost: "0.00",
              monthly_cost: "1.00000",
              currency: "USD",
            },
          },
        ],
      }),
    ).toEqual([
      {
        phoneNumber: "+15555550100",
        upfrontCost: "3.21000",
        monthlyCost: "1.00000",
        currency: "USD",
      },
      {
        phoneNumber: "+15555550101",
        upfrontCost: "0.00",
        monthlyCost: "1.00000",
        currency: "USD",
      },
    ]);
  });

  it("fails closed by dropping incomplete or invalid quotes", () => {
    expect(
      parseAvailableNumbers({
        data: [
          { cost_information: { monthly_cost: "1.0" } },
          { phone_number: "+15555550100" },
          {
            phone_number: "+15555550101",
            cost_information: {
              upfront_cost: "0",
              monthly_cost: "not-a-price",
              currency: "USD",
            },
          },
        ],
      }),
    ).toEqual([]);
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
        _init?: Parameters<typeof fetch>[1],
      ) =>
        new Response(
          JSON.stringify({
            data: [
              {
                phone_number: "+15555550100",
                cost_information: {
                  upfront_cost: "3.21000",
                  monthly_cost: "1.00000",
                  currency: "USD",
                },
              },
            ],
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      searchAvailableNumbers({ areaCode: "555", limit: 3 }),
    ).resolves.toEqual([
      {
        phoneNumber: "+15555550100",
        upfrontCost: "3.21000",
        monthlyCost: "1.00000",
        currency: "USD",
      },
    ]);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain(
      "https://api.telnyx.com/v2/available_phone_numbers?",
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
      }),
    );
  });

  it("treats a blank API key as unconfigured before provider requests", async () => {
    vi.stubEnv("TELNYX_API_KEY", "   ");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchAvailableNumbers({ limit: 1 })).rejects.toBeInstanceOf(
      TelnyxNotConfiguredError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a US-scoped messaging profile with the production webhook format", async () => {
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    const fetchMock = vi.fn(
      async (
        _url: Parameters<typeof fetch>[0],
        _init?: Parameters<typeof fetch>[1],
      ) =>
        new Response(
          JSON.stringify({
            data: { id: "3fa85f64-5717-4562-b3fc-2c963f66afa6" },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createMessagingProfile({
        name: "Healthy Pets — OpenVPM",
        webhookUrl: "https://app.openvpm.com/api/webhooks/telnyx",
      }),
    ).resolves.toEqual({ id: "3fa85f64-5717-4562-b3fc-2c963f66afa6" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telnyx.com/v2/messaging_profiles",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(body).toEqual({
      name: "Healthy Pets — OpenVPM",
      enabled: false,
      webhook_url: "https://app.openvpm.com/api/webhooks/telnyx",
      webhook_api_version: "2",
      whitelisted_destinations: ["US"],
      daily_spend_limit_enabled: true,
      daily_spend_limit: "10.00",
      smart_encoding: true,
    });
  });

  it("reads and validates the exact safe messaging-profile launch state", async () => {
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    const profileId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const locationId = "00000000-0000-0000-0000-000000000002";
    const webhookUrl = "https://app.openvpm.com/api/webhooks/telnyx";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                id: profileId,
                name: openVpmMessagingProfileName(locationId),
                webhook_url: webhookUrl,
                webhook_api_version: "2",
                enabled: true,
                whitelisted_destinations: ["US"],
                daily_spend_limit_enabled: true,
                daily_spend_limit: "10.00",
                smart_encoding: true,
              },
            }),
          ),
      ),
    );

    const profile = await getMessagingProfile(profileId);
    expect(profile).toMatchObject({
      id: profileId,
      enabled: true,
      whitelistedDestinations: ["US"],
      dailySpendLimitEnabled: true,
      dailySpendLimit: "10.00",
      smartEncoding: true,
    });
    expect(
      messagingProfileSafetyIssues(profile, {
        id: profileId,
        name: openVpmMessagingProfileName(locationId),
        webhookUrl,
      }),
    ).toEqual([]);
  });

  it("idempotently installs and reads back the exact US START, STOP, and HELP contract", async () => {
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    const profileId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const providerRows = OPENVPM_MESSAGING_PROFILE_AUTORESPONSES.map(
      (config, index) => ({
        id: `autoresponse-${index + 1}`,
        op: config.operation,
        keywords: [...config.keywords],
        resp_text: config.responseText,
        country_code: config.countryCode,
      }),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(autoresponseInventoryResponse([]))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: providerRows[0] })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: providerRows[1] })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: providerRows[2] })),
      )
      .mockResolvedValueOnce(autoresponseInventoryResponse(providerRows));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      ensureMessagingProfileAutoresponses(profileId, {
        expectedPolicy: OPENVPM_MESSAGING_PROFILE_AUTORESPONSES,
      }),
    ).resolves.toHaveLength(3);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://api.telnyx.com/v2/messaging_profiles/${profileId}/autoresp_configs`,
    );
    for (const [
      index,
      expected,
    ] of OPENVPM_MESSAGING_PROFILE_AUTORESPONSES.entries()) {
      const [url, init] = fetchMock.mock.calls[index + 1] ?? [];
      expect(String(url)).toBe(
        `https://api.telnyx.com/v2/messaging_profiles/${profileId}/autoresp_configs`,
      );
      expect(init).toEqual(
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            op: expected.operation,
            keywords: [...expected.keywords],
            resp_text: expected.responseText,
            country_code: "US",
          }),
        }),
      );
    }
  });

  it("does not mutate an already attested auto-response contract", async () => {
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    const providerRows = OPENVPM_MESSAGING_PROFILE_AUTORESPONSES.map(
      (config, index) => ({
        id: `autoresponse-${index + 1}`,
        op: config.operation,
        keywords: [...config.keywords].reverse(),
        resp_text: config.responseText,
        country_code: config.countryCode,
      }),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(autoresponseInventoryResponse(providerRows))
      .mockResolvedValueOnce(autoresponseInventoryResponse(providerRows));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      ensureMessagingProfileAutoresponses("profile-1", {
        expectedPolicy: OPENVPM_MESSAGING_PROFILE_AUTORESPONSES,
      }),
    ).resolves.toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.every((call) => call[1]?.method === "GET"),
    ).toBe(true);
  });

  it("fails closed without overwriting provider auto-response drift", async () => {
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    const fetchMock = vi.fn(async () =>
      autoresponseInventoryResponse([
        {
          id: "autoresponse-1",
          op: "start",
          keywords: ["START"],
          resp_text: "Unexpected response",
          country_code: "US",
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      ensureMessagingProfileAutoresponses("profile-1", {
        expectedPolicy: OPENVPM_MESSAGING_PROFILE_AUTORESPONSES,
      }),
    ).rejects.toMatchObject({ name: "TelnyxError", status: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats ambiguous auto-response mutations as resumable uncertainty", async () => {
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(autoresponseInventoryResponse([]))
      .mockRejectedValueOnce(new Error("connection reset"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      ensureMessagingProfileAutoresponses("profile-1", {
        expectedPolicy: OPENVPM_MESSAGING_PROFILE_AUTORESPONSES,
      }),
    ).rejects.toBeInstanceOf(TelnyxMutationUncertainError);
  });

  it("rejects incomplete auto-response inventory and reports exact policy drift", async () => {
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: {} }))),
    );
    await expect(
      getMessagingProfileAutoresponses("profile-1"),
    ).rejects.toMatchObject({ name: "TelnyxError", status: 502 });

    expect(
      messagingProfileAutoresponseSafetyIssues(
        [
          {
            id: "config-1",
            operation: "start",
            keywords: ["START"],
            responseText: "Wrong",
            countryCode: "US",
          },
        ],
        OPENVPM_MESSAGING_PROFILE_AUTORESPONSES,
      ),
    ).toEqual([
      "start auto-response does not match policy",
      "stop auto-response is missing or duplicated",
      "help auto-response is missing or duplicated",
    ]);
  });

  it("rejects paginated or truncated auto-response evidence without mutating", async () => {
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    const expected = OPENVPM_MESSAGING_PROFILE_AUTORESPONSES.map(
      (config, index) => ({
        id: `autoresponse-${index + 1}`,
        op: config.operation,
        keywords: [...config.keywords],
        resp_text: config.responseText,
        country_code: config.countryCode,
      }),
    );
    const fetchMock = vi.fn(async () =>
      autoresponseInventoryResponse(expected.slice(0, 2), {
        page_size: 2,
        total_pages: 2,
        total_results: 3,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getMessagingProfileAutoresponses("profile-1"),
    ).rejects.toMatchObject({ name: "TelnyxError", status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        autoresponseInventoryResponse(expected.slice(0, 2), {
          total_results: 3,
        }),
      ),
    );
    await expect(
      getMessagingProfileAutoresponses("profile-1"),
    ).rejects.toMatchObject({ name: "TelnyxError", status: 502 });
  });

  it("fails the profile safety check on broadened or incomplete provider state", () => {
    expect(
      messagingProfileSafetyIssues(
        {
          id: "profile-1",
          name: "Unexpected profile",
          webhookUrl: "https://wrong.example/webhook",
          webhookApiVersion: "1",
          enabled: false,
          whitelistedDestinations: ["US", "CA"],
          dailySpendLimitEnabled: false,
          dailySpendLimit: "100.00",
          smartEncoding: false,
        },
        {
          id: "profile-1",
          name: "OpenVPM provision location-1",
          webhookUrl: "https://app.example.com/api/webhooks/telnyx",
        },
      ),
    ).toEqual([
      "profile name mismatch",
      "webhook URL mismatch",
      "webhook API version is not v2",
      "destination allowlist is not US-only",
      "daily spend limit is not enabled",
      "daily spend limit is not $10.00",
      "smart encoding is not enabled",
    ]);
  });

  it("uses an explicit PATCH for profile activation and verifies its response", async () => {
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    const profileId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              id: profileId,
              name: "OpenVPM provision location-1",
              enabled: true,
            },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateMessagingProfileEnabled({ profileId, enabled: true }),
    ).resolves.toMatchObject({ id: profileId, enabled: true });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.telnyx.com/v2/messaging_profiles/${profileId}`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ enabled: true }),
      }),
    );
  });

  it.each([408, 429, 500, 503])(
    "classifies a profile-activation HTTP %s as uncertain",
    async (status) => {
      vi.stubEnv("TELNYX_API_KEY", "KEY123");
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({ errors: [{ detail: "temporary" }] }),
              {
                status,
              },
            ),
        ),
      );

      await expect(
        updateMessagingProfileEnabled({
          profileId: "profile-123",
          enabled: true,
        }),
      ).rejects.toBeInstanceOf(TelnyxMutationUncertainError);
    },
  );

  it.each([408, 429, 500, 503])(
    "classifies a messaging-profile HTTP %s as uncertain",
    async (status) => {
      vi.stubEnv("TELNYX_API_KEY", "KEY123");
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({ errors: [{ detail: "temporary" }] }),
              {
                status,
              },
            ),
        ),
      );

      await expect(
        createMessagingProfile({
          name: "OpenVPM provision location-1",
          webhookUrl: "https://app.example.com/api/webhooks/telnyx",
        }),
      ).rejects.toBeInstanceOf(TelnyxMutationUncertainError);
    },
  );

  it("classifies profile transport and malformed success responses as uncertain", async () => {
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {} })))
      .mockResolvedValueOnce(new Response("not-json"));
    vi.stubGlobal("fetch", fetchMock);

    const request = () =>
      createMessagingProfile({
        name: "OpenVPM provision location-1",
        webhookUrl: "https://app.example.com/api/webhooks/telnyx",
      });
    await expect(request()).rejects.toBeInstanceOf(
      TelnyxMutationUncertainError,
    );
    await expect(request()).rejects.toBeInstanceOf(
      TelnyxMutationUncertainError,
    );
    await expect(request()).rejects.toBeInstanceOf(
      TelnyxMutationUncertainError,
    );
  });

  it("finds only exact durable profile and owned-number identities", async () => {
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        autoresponseInventoryResponse([
          {
            id: "profile-1",
            name: "OpenVPM provision location-1",
            webhook_url: "https://app.example.com/api/webhooks/telnyx",
            enabled: false,
          },
          { id: "profile-2", name: "not-an-exact-match" },
        ]),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "number-1",
                phone_number: "+15555550100",
                messaging_profile_id: "profile-1",
                status: "active",
              },
              { id: "number-2", phone_number: "+15555550101" },
            ],
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      findMessagingProfilesByName("OpenVPM provision location-1"),
    ).resolves.toEqual([
      {
        id: "profile-1",
        name: "OpenVPM provision location-1",
        webhookUrl: "https://app.example.com/api/webhooks/telnyx",
        enabled: false,
      },
    ]);
    await expect(findOwnedPhoneNumbers("+15555550100")).resolves.toEqual([
      {
        id: "number-1",
        phoneNumber: "+15555550100",
        messagingProfileId: "profile-1",
        status: "active",
      },
    ]);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "filter%5Bname%5D%5Beq%5D=OpenVPM+provision+location-1",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "filter%5Bphone_number%5D=%2B15555550100",
    );
  });

  it("re-reads an exact selected quote and exact customer-reference orders", async () => {
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                phone_number: "+15555550100",
                cost_information: {
                  upfront_cost: "3.21",
                  monthly_cost: "6.54",
                  currency: "USD",
                },
              },
              {
                phone_number: "+15555550101",
                cost_information: {
                  upfront_cost: "3.21",
                  monthly_cost: "6.54",
                  currency: "USD",
                },
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        autoresponseInventoryResponse([
          {
            id: "order-1",
            status: "pending",
            customer_reference: "openvpm:practice-1:location-1",
            messaging_profile_id: "profile-1",
            phone_numbers: [{ phone_number: "+15555550100" }],
          },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(findAvailableNumberQuotes("+15555550100")).resolves.toEqual([
      {
        phoneNumber: "+15555550100",
        upfrontCost: "3.21",
        monthlyCost: "6.54",
        currency: "USD",
      },
    ]);
    await expect(
      findNumberOrdersByCustomerReference("openvpm:practice-1:location-1"),
    ).resolves.toEqual([
      {
        id: "order-1",
        status: "pending",
        customerReference: "openvpm:practice-1:location-1",
        messagingProfileId: "profile-1",
        phoneNumbers: ["+15555550100"],
      },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "filter%5Bphone_number%5D%5Bstarts_with%5D=5555550100",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "filter%5Bcustomer_reference%5D=openvpm%3Apractice-1%3Alocation-1",
    );
  });

  it("uses a stable customer reference and exposes exact cleanup mutations", async () => {
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { id: "order-1", status: "pending" } }),
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      buyNumber({
        phoneNumber: "+15555550100",
        messagingProfileId: "profile-1",
        customerReference: "openvpm:practice-1:location-1",
      }),
    ).resolves.toEqual({ orderId: "order-1", status: "pending" });
    await deleteOwnedPhoneNumber("number/1");
    await deleteMessagingProfile("profile/1");

    const body = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      customer_reference: "openvpm:practice-1:location-1",
      messaging_profile_id: "profile-1",
      phone_numbers: [{ phone_number: "+15555550100" }],
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.telnyx.com/v2/phone_numbers/number%2F1",
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "https://api.telnyx.com/v2/messaging_profiles/profile%2F1",
    );
  });

  it.each([408, 429, 500, 503])(
    "classifies an order HTTP %s as uncertain",
    async (status) => {
      vi.stubEnv("TELNYX_API_KEY", "KEY123");
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({ errors: [{ detail: "temporary" }] }),
              {
                status,
              },
            ),
        ),
      );

      await expect(
        buyNumber({
          phoneNumber: "+15555550100",
          messagingProfileId: "profile-1",
          customerReference: "openvpm:practice-1:location-1",
        }),
      ).rejects.toBeInstanceOf(TelnyxMutationUncertainError);
    },
  );

  it("classifies transport and malformed successful order responses as uncertain", async () => {
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { status: "pending" } })),
      )
      .mockResolvedValueOnce(new Response("not-json"));
    vi.stubGlobal("fetch", fetchMock);

    const request = () =>
      buyNumber({
        phoneNumber: "+15555550100",
        messagingProfileId: "profile-1",
        customerReference: "openvpm:practice-1:location-1",
      });
    await expect(request()).rejects.toBeInstanceOf(
      TelnyxMutationUncertainError,
    );
    await expect(request()).rejects.toBeInstanceOf(
      TelnyxMutationUncertainError,
    );
    await expect(request()).rejects.toBeInstanceOf(
      TelnyxMutationUncertainError,
    );
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
          }),
      ),
    );

    const result = expect(
      checkHostedEligibility("+15555550100"),
    ).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(TELNYX_API_TIMEOUT_MS);
    await result;
  });

  it("uses the current hosted-number eligibility endpoint and response shape", async () => {
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            phone_numbers: [
              {
                phone_number: "+15555550100",
                eligible: false,
                detail: "number_can_not_be_wireless",
              },
            ],
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkHostedEligibility("+15555550100")).resolves.toEqual({
      eligible: false,
      detail: "number_can_not_be_wireless",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telnyx.com/v2/messaging_hosted_number_orders/eligibility_numbers_check",
      expect.objectContaining({ method: "POST" }),
    );
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
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            campaignId: "campaign-1",
            campaignStatus: "TCR_PENDING",
            submissionStatus: "PENDING",
          }),
        ),
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
      }),
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
      }),
    ).resolves.toMatchObject({
      campaignId: "campaign-1",
      campaignStatus: "TCR_PENDING",
    });

    const brandBody = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(brandBody).toMatchObject({
      companyName: "Healthy Pets LLC",
      ein: "123456789",
      vertical: "HEALTHCARE",
      webhookURL: "https://app.example.com/api/webhooks/telnyx",
    });
    const campaignBody = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body),
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
      }),
    ).resolves.toMatchObject(existing);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(
      ensureA2pNumberAssignment({
        phoneNumber: "+15555550100",
        campaignId: "campaign-2",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects duplicate or cross-brand campaign recovery evidence", async () => {
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    const duplicateFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            records: [
              {
                campaignId: "campaign-1",
                brandId: "brand-1",
                referenceId: "openvpm-clinic-1",
              },
              {
                campaignId: "campaign-2",
                brandId: "brand-1",
                referenceId: "openvpm-clinic-1",
              },
            ],
          }),
        ),
    );
    vi.stubGlobal("fetch", duplicateFetch);

    await expect(
      findA2pCampaignByReference({
        brandId: "brand-1",
        referenceId: "openvpm-clinic-1",
      }),
    ).rejects.toMatchObject({ status: 409 });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              records: [
                {
                  campaignId: "campaign-3",
                  brandId: "brand-other",
                  referenceId: "openvpm-clinic-1",
                },
              ],
            }),
          ),
      ),
    );
    await expect(
      findA2pCampaignByReference({
        brandId: "brand-1",
        referenceId: "openvpm-clinic-1",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("classifies ambiguous fee-bearing carrier mutations as uncertain", async () => {
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ errors: [{ code: "rate_limited" }] }), {
            status: 429,
          }),
      ),
    );
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
      }),
    ).rejects.toBeInstanceOf(TelnyxMutationUncertainError);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: {} }))),
    );
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
      }),
    ).rejects.toBeInstanceOf(TelnyxMutationUncertainError);

    const assignmentFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ code: "unavailable" }] }), {
          status: 503,
        }),
      );
    vi.stubGlobal("fetch", assignmentFetch);
    await expect(
      ensureA2pNumberAssignment({
        phoneNumber: "+15555550100",
        campaignId: "campaign-1",
      }),
    ).rejects.toBeInstanceOf(TelnyxMutationUncertainError);
  });
});
