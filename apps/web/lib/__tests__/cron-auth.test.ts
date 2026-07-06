import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isCronAuthorized } from "../cron-auth";

function req(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/cron/test", { headers });
}

describe("isCronAuthorized", () => {
  const ORIGINAL = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "s3cret-value";
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = ORIGINAL;
  });

  it("accepts the Vercel Cron `Authorization: Bearer <secret>` header", () => {
    expect(isCronAuthorized(req({ authorization: "Bearer s3cret-value" }))).toBe(true);
  });

  it("trims the configured secret and provided headers before comparison", () => {
    process.env.CRON_SECRET = " s3cret-value ";

    expect(isCronAuthorized(req({ authorization: "Bearer s3cret-value" }))).toBe(true);
    expect(isCronAuthorized(req({ "x-cron-secret": " s3cret-value " }))).toBe(true);
  });

  it("accepts a lowercase `bearer` scheme", () => {
    expect(isCronAuthorized(req({ authorization: "bearer s3cret-value" }))).toBe(true);
  });

  it("accepts the `x-cron-secret` fallback header (manual/local triggers)", () => {
    expect(isCronAuthorized(req({ "x-cron-secret": "s3cret-value" }))).toBe(true);
  });

  it("rejects a wrong secret in either header", () => {
    expect(isCronAuthorized(req({ authorization: "Bearer nope" }))).toBe(false);
    expect(isCronAuthorized(req({ "x-cron-secret": "nope" }))).toBe(false);
  });

  it("rejects when no auth header is provided", () => {
    expect(isCronAuthorized(req({}))).toBe(false);
  });

  it("rejects everything when CRON_SECRET is unset", () => {
    delete process.env.CRON_SECRET;
    expect(isCronAuthorized(req({ authorization: "Bearer s3cret-value" }))).toBe(false);
    expect(isCronAuthorized(req({ "x-cron-secret": "s3cret-value" }))).toBe(false);
  });

  it("rejects everything when CRON_SECRET is blank", () => {
    process.env.CRON_SECRET = "   ";
    expect(isCronAuthorized(req({ authorization: "Bearer s3cret-value" }))).toBe(false);
    expect(isCronAuthorized(req({ "x-cron-secret": "   " }))).toBe(false);
  });
});
