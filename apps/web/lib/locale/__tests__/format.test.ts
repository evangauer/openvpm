import { describe, it, expect } from "vitest";
import {
  formatCurrency,
  formatDate,
  regulatoryFramework,
  regionDefaults,
  localeForCountry,
} from "../format";

describe("formatCurrency", () => {
  it("formats USD with a dollar sign", () => {
    const s = formatCurrency(65, "usd");
    expect(s).toContain("$");
    expect(s).toContain("65");
  });
  it("formats GBP with a pound sign in en-GB", () => {
    const s = formatCurrency(65, "gbp", "GB");
    expect(s).toContain("£");
    expect(s).toContain("65");
  });
  it("formats EUR", () => {
    expect(formatCurrency(40, "eur", "IE")).toContain("€");
  });
  it("formats JPY in ja-JP without minor units", () => {
    const s = formatCurrency(4500, "jpy", "JP");
    expect(s).toMatch(/[¥￥]/);
    expect(s).toContain("4,500");
    expect(s).not.toContain(".00");
  });
  it("accepts string amounts from the DB and coerces them", () => {
    const s = formatCurrency("65.00", "gbp", "GB");
    expect(s).toContain("£");
    expect(s).toContain("65");
  });
  it("treats null/undefined/non-numeric as zero", () => {
    expect(formatCurrency(null)).toContain("0");
    expect(formatCurrency(undefined)).toContain("0");
    expect(formatCurrency("not-a-number")).toContain("0");
  });
});

describe("formatDate", () => {
  it("uses month/day order for the US and day/month for the UK", () => {
    const us = formatDate("2026-06-07", "US");
    const gb = formatDate("2026-06-07", "GB");
    expect(us).toBe("06/07/2026");
    expect(gb).toBe("07/06/2026");
  });
  it("uses year/month/day order for Japan", () => {
    expect(formatDate("2026-06-07", "JP")).toBe("2026/06/07");
  });
});

describe("regulatoryFramework", () => {
  it("returns uk_vmd for GB, us_dea otherwise", () => {
    expect(regulatoryFramework("GB")).toBe("uk_vmd");
    expect(regulatoryFramework("US")).toBe("us_dea");
    expect(regulatoryFramework(null)).toBe("us_dea");
  });
});

describe("regionDefaults", () => {
  it("returns USD/8% for US (and unknown), GBP/20% for GB", () => {
    expect(regionDefaults("US")).toMatchObject({ currency: "usd", taxRatePercent: "8.00" });
    expect(regionDefaults("ZZ")).toMatchObject({ currency: "usd" });
    expect(regionDefaults("GB")).toMatchObject({
      currency: "gbp",
      taxRatePercent: "20.00",
      timezone: "Europe/London",
    });
  });
  it("returns JPY/10%/Asia/Tokyo for Japan", () => {
    expect(regionDefaults("JP")).toEqual({
      currency: "jpy",
      taxRatePercent: "10.00",
      timezone: "Asia/Tokyo",
    });
    expect(localeForCountry("JP")).toBe("ja-JP");
  });
});

describe("localeForCountry", () => {
  it("maps known countries and falls back to en-US", () => {
    expect(localeForCountry("GB")).toBe("en-GB");
    expect(localeForCountry("xx")).toBe("en-US");
    expect(localeForCountry(null)).toBe("en-US");
  });
});
