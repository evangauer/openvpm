import { describe, it, expect } from "vitest";
import { parseAvailableNumbers } from "../telnyx-provisioning";

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
