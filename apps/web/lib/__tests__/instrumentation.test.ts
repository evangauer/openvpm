import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(async () => undefined),
}));

vi.mock("@/lib/error-tracking", () => ({
  captureException: mocks.captureException,
}));

const { onRequestError, resetRequestErrorDedupeForTests } = await import(
  "../../instrumentation"
);

const request = {
  path: "/patients/00000000-0000-4000-8000-000000000001?tab=chart",
  method: "GET",
  headers: {},
};

const context = {
  routerKind: "App Router" as const,
  routePath: "/patients/[id]",
  routeType: "render" as const,
  renderSource: "server-rendering" as const,
  revalidateReason: undefined,
  renderType: "dynamic" as const,
};

afterEach(() => {
  resetRequestErrorDedupeForTests();
  vi.clearAllMocks();
});

describe("Next request error instrumentation", () => {
  it("forwards request failures through the privacy-safe ops reporter", async () => {
    const error = Object.assign(new Error("database unavailable"), {
      digest: "request-digest",
    });

    await onRequestError(error, request, context);

    expect(mocks.captureException).toHaveBeenCalledWith({
      source: "next-render",
      message: "database unavailable",
      stack: expect.any(String),
      digest: "request-digest",
      path: request.path,
    });
  });

  it("deduplicates an alert storm for the same error and route", async () => {
    const error = Object.assign(new Error("database unavailable"), {
      digest: "same-digest",
    });

    await onRequestError(error, request, context);
    await onRequestError(error, request, context);

    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });

  it("keeps distinct routes independently observable", async () => {
    const error = Object.assign(new Error("database unavailable"), {
      digest: "shared-digest",
    });

    await onRequestError(error, request, context);
    await onRequestError(error, request, {
      ...context,
      routePath: "/invoices/[id]",
    });

    expect(mocks.captureException).toHaveBeenCalledTimes(2);
  });
});
