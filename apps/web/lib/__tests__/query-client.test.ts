import { describe, expect, it, vi } from "vitest";
import {
  createAppQueryClient,
  isRevokedStaffSessionError,
  QUERY_GC_TIME_MS,
  QUERY_STALE_TIME_MS,
  shouldRetryQuery,
} from "../query-client";

describe("createAppQueryClient", () => {
  it("uses conservative global query defaults", () => {
    const defaults = createAppQueryClient().getDefaultOptions();

    expect(defaults.queries?.staleTime).toBe(QUERY_STALE_TIME_MS);
    expect(defaults.queries?.gcTime).toBe(QUERY_GC_TIME_MS);
    expect(defaults.queries?.refetchOnWindowFocus).toBe(false);
    expect(defaults.queries?.retry).toBe(shouldRetryQuery);
    expect(defaults.mutations?.retry).toBe(false);
  });
});

describe("shouldRetryQuery", () => {
  it("retries unknown transient failures once", () => {
    expect(shouldRetryQuery(0, new Error("network"))).toBe(true);
    expect(shouldRetryQuery(1, new Error("network"))).toBe(false);
  });

  it("does not retry expected tRPC client failures", () => {
    expect(
      shouldRetryQuery(0, { data: { code: "UNAUTHORIZED", httpStatus: 401 } })
    ).toBe(false);
    expect(
      shouldRetryQuery(0, { shape: { data: { code: "BAD_REQUEST" } } })
    ).toBe(false);
  });

  it("does not retry other 4xx responses", () => {
    expect(shouldRetryQuery(0, { status: 404 })).toBe(false);
    expect(shouldRetryQuery(0, { data: { httpStatus: 409 } })).toBe(false);
  });
});

describe("revoked staff sessions", () => {
  const unauthorized = { data: { code: "UNAUTHORIZED", httpStatus: 401 } };

  it("recognizes UNAUTHORIZED from staff procedures", () => {
    expect(
      isRevokedStaffSessionError(unauthorized, [["patients", "list"], {}]),
    ).toBe(true);
    expect(
      isRevokedStaffSessionError(
        { shape: { data: { code: "UNAUTHORIZED" } } },
        [["settings", "updateUser"]],
      ),
    ).toBe(true);
  });

  it("ignores client-portal sessions and other errors", () => {
    expect(
      isRevokedStaffSessionError(unauthorized, [["portal", "me"], {}]),
    ).toBe(false);
    expect(
      isRevokedStaffSessionError(
        { data: { code: "FORBIDDEN" } },
        [["patients", "list"]],
      ),
    ).toBe(false);
    expect(isRevokedStaffSessionError(unauthorized, undefined)).toBe(false);
  });

  it("notifies the app when a staff query or mutation is rejected", async () => {
    const onSessionRevoked = vi.fn();
    const client = createAppQueryClient({ onSessionRevoked });

    await client
      .fetchQuery({
        queryKey: [["patients", "list"], { type: "query" }],
        queryFn: () => Promise.reject(unauthorized),
        retry: false,
      })
      .catch(() => undefined);
    await client
      .getMutationCache()
      .build(client, {
        mutationKey: [["settings", "updateUser"]],
        mutationFn: () => Promise.reject(unauthorized),
      })
      .execute(undefined)
      .catch(() => undefined);
    await client
      .fetchQuery({
        queryKey: [["portal", "me"], { type: "query" }],
        queryFn: () => Promise.reject(unauthorized),
        retry: false,
      })
      .catch(() => undefined);

    expect(onSessionRevoked).toHaveBeenCalledTimes(2);
  });
});
