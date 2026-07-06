import { describe, expect, it } from "vitest";
import {
  POSTGRES_INTEGER_MAX,
  integerColumnDeltaInput,
  nonnegativeIntegerColumnInput,
  positiveIntegerColumnInput,
} from "../routers/storage-bounds";

describe("integer-backed storage bounds", () => {
  it("rejects values outside a Postgres integer column", () => {
    expect(nonnegativeIntegerColumnInput.safeParse(0).success).toBe(true);
    expect(nonnegativeIntegerColumnInput.safeParse(POSTGRES_INTEGER_MAX).success).toBe(true);
    expect(nonnegativeIntegerColumnInput.safeParse(POSTGRES_INTEGER_MAX + 1).success).toBe(false);

    expect(positiveIntegerColumnInput.safeParse(1).success).toBe(true);
    expect(positiveIntegerColumnInput.safeParse(0).success).toBe(false);
    expect(positiveIntegerColumnInput.safeParse(POSTGRES_INTEGER_MAX + 1).success).toBe(false);

    expect(integerColumnDeltaInput.safeParse(-POSTGRES_INTEGER_MAX).success).toBe(true);
    expect(integerColumnDeltaInput.safeParse(POSTGRES_INTEGER_MAX).success).toBe(true);
    expect(integerColumnDeltaInput.safeParse(POSTGRES_INTEGER_MAX + 1).success).toBe(false);
  });
});
