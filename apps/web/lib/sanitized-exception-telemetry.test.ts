import { describe, expect, it } from "vitest";
import { sanitizedExceptionTelemetry } from "./sanitized-exception-telemetry";

describe("sanitized exception telemetry", () => {
  it("retains only bounded classifications", () => {
    const error = Object.assign(
      new Error("patient=Fluffy token=raw-secret query=insert"),
      { code: "23505", cause: { detail: "private" } },
    );
    expect(sanitizedExceptionTelemetry(error)).toEqual({
      errorName: "Error",
      errorCode: "23505",
    });
    expect(JSON.stringify(sanitizedExceptionTelemetry(error))).not.toMatch(
      /Fluffy|raw-secret|private|insert/,
    );
  });

  it("fails closed for attacker-controlled names and codes", () => {
    const error = Object.assign(new Error("private"), {
      name: "token raw-secret",
      code: "credential=raw-secret",
    });
    expect(sanitizedExceptionTelemetry(error)).toEqual({
      errorName: "UnknownError",
    });
  });
});
