import { describe, expect, it } from "vitest";
import {
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
  authPasswordInput,
} from "../auth-password";

describe("auth password validation", () => {
  it("accepts passwords within the shared policy bounds", () => {
    expect(authPasswordInput.safeParse("p".repeat(AUTH_PASSWORD_MIN_LENGTH)).success).toBe(true);
    expect(authPasswordInput.safeParse("p".repeat(AUTH_PASSWORD_MAX_LENGTH)).success).toBe(true);
  });

  it("rejects short and oversized passwords before hashing", () => {
    expect(authPasswordInput.safeParse("p".repeat(AUTH_PASSWORD_MIN_LENGTH - 1)).success).toBe(
      false
    );
    expect(authPasswordInput.safeParse("p".repeat(AUTH_PASSWORD_MAX_LENGTH + 1)).success).toBe(
      false
    );
  });
});
