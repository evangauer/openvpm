import { describe, expect, it } from "vitest";
import {
  addDaysYmd,
  classifyExpiration,
  classifyStock,
  inventoryAlert,
} from "../alerts";

const TODAY = new Date("2026-06-27T12:00:00Z");

describe("inventory alerts", () => {
  it("classifies out, low, and ok stock", () => {
    expect(classifyStock(0, 10)).toBe("out");
    expect(classifyStock(5, 10)).toBe("low");
    expect(classifyStock(11, 10)).toBe("ok");
    expect(classifyStock(10, null)).toBe("low");
  });

  it("classifies expiration windows separately from expired stock", () => {
    expect(classifyExpiration(null, TODAY)).toBe("none");
    expect(classifyExpiration("2026-06-26", TODAY)).toBe("expired");
    expect(classifyExpiration("2026-06-27", TODAY)).toBe("expiring_soon");
    expect(classifyExpiration("2026-09-25", TODAY)).toBe("expiring_soon");
    expect(classifyExpiration("2026-09-26", TODAY)).toBe("ok");
  });

  it("accepts practice-local date keys for expiration windows", () => {
    const nearMidnightUtc = new Date("2026-07-15T02:30:00.000Z");

    expect(classifyExpiration("2026-07-14", nearMidnightUtc)).toBe("expired");
    expect(classifyExpiration("2026-07-14", "2026-07-14")).toBe(
      "expiring_soon"
    );
    expect(addDaysYmd("2026-07-14", 90)).toBe("2026-10-12");
    expect(
      inventoryAlert(
        { stockQuantity: 20, reorderPoint: 10, expirationDate: "2026-07-14" },
        "2026-07-14"
      )
    ).toMatchObject({
      expirationStatus: "expiring_soon",
      needsAttention: true,
    });
  });

  it("marks products needing inventory attention", () => {
    expect(
      inventoryAlert(
        { stockQuantity: 8, reorderPoint: 10, expirationDate: "2027-01-01" },
        TODAY
      )
    ).toMatchObject({ stockStatus: "low", needsAttention: true });

    expect(
      inventoryAlert(
        { stockQuantity: 20, reorderPoint: 10, expirationDate: "2026-07-01" },
        TODAY
      )
    ).toMatchObject({
      expirationStatus: "expiring_soon",
      needsAttention: true,
    });

    expect(
      inventoryAlert(
        { stockQuantity: 20, reorderPoint: 10, expirationDate: "2027-01-01" },
        TODAY
      )
    ).toMatchObject({ stockStatus: "ok", expirationStatus: "ok", needsAttention: false });
  });
});
