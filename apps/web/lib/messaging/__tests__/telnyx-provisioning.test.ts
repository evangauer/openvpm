import { afterEach, describe, it, expect, vi } from "vitest";
import {
  checkHostedEligibility,
  parseAvailableNumbers,
  searchAvailableNumbers,
  TelnyxNotConfiguredError,
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
          { phone_number: "+14157271696", cost_information: { monthly_cost: "1.00000" } },
          { phone_number: "+14158735087", cost_information: { monthly_cost: "1.00000" } },
        ],
      })
    ).toEqual([
      { phoneNumber: "+14157271696", monthlyCost: "1.00000" },
      { phoneNumber: "+14158735087", monthlyCost: "1.00000" },
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
                phone_number: "+14157271696",
                cost_information: { monthly_cost: "1.00000" },
              },
            ],
          })
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      searchAvailableNumbers({ areaCode: "415", limit: 3 })
    ).resolves.toEqual([
      { phoneNumber: "+14157271696", monthlyCost: "1.00000" },
    ]);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain(
      "https://api.telnyx.com/v2/available_phone_numbers?"
    );
    expect(String(url)).toContain("filter%5Bcountry_code%5D=US");
    expect(String(url)).toContain("filter%5Bfeatures%5D%5B%5D=sms");
    expect(String(url)).toContain("filter%5Blimit%5D=3");
    expect(String(url)).toContain("filter%5Bnational_destination_code%5D=415");
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
});
