import { afterEach, describe, expect, it, vi } from "vitest";
import { reportClientError } from "../report-client-error";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function stubPath(pathname = "/settings") {
  vi.stubGlobal("window", { location: { pathname } });
}

describe("reportClientError", () => {
  it("queues client errors with sendBeacon when available", async () => {
    stubPath("/patients");
    const sendBeacon = vi.fn((_: string, __?: BodyInit | null) => true);
    const fetch = vi.fn();
    vi.stubGlobal("navigator", { sendBeacon });
    vi.stubGlobal("fetch", fetch);

    reportClientError("app-error", Object.assign(new Error("boom"), {
      digest: "digest-1",
    }));

    expect(sendBeacon).toHaveBeenCalledWith(
      "/api/error-report",
      expect.any(Blob)
    );
    expect(fetch).not.toHaveBeenCalled();

    const [, payload] = sendBeacon.mock.calls[0]!;
    const body = await (payload as Blob).text();
    expect(JSON.parse(body)).toMatchObject({
      source: "app-error",
      errorFamily: "Error",
      digest: "digest-1",
      path: "/patients",
    });
    expect(body).not.toContain("boom");
    expect(body).not.toContain("stack");
  });

  it("falls back to fetch when sendBeacon cannot queue the report", () => {
    stubPath("/billing");
    vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => false) });
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    reportClientError("global-error", new Error("queue full"));

    expect(fetch).toHaveBeenCalledWith(
      "/api/error-report",
      expect.objectContaining({
        method: "POST",
        keepalive: true,
        body: expect.not.stringContaining("queue full"),
      })
    );
  });

  it("falls back to fetch when sendBeacon throws", () => {
    stubPath("/records");
    vi.stubGlobal("navigator", {
      sendBeacon: vi.fn(() => {
        throw new Error("beacon unavailable");
      }),
    });
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    expect(() =>
      reportClientError("react-error-boundary", new Error("boom"))
    ).not.toThrow();
    expect(fetch).toHaveBeenCalledWith(
      "/api/error-report",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("react-error-boundary"),
      })
    );
  });

  it("does not throw when no browser transport exists", () => {
    stubPath("/settings");
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("fetch", undefined);

    expect(() =>
      reportClientError("app-error", new Error("boom"))
    ).not.toThrow();
  });

  it("redacts record identifiers and drops unsafe digests before transport", async () => {
    stubPath("/patients/323e4567-e89b-42d3-a456-426614174000/edit");
    const sendBeacon = vi.fn((_: string, __?: BodyInit | null) => true);
    vi.stubGlobal("navigator", { sendBeacon });
    vi.stubGlobal("fetch", vi.fn());

    reportClientError(
      "app-error",
      Object.assign(new Error("Patient Daisy failed to save"), {
        digest: "Daisy's record",
      })
    );

    const [, payload] = sendBeacon.mock.calls[0]!;
    const body = await (payload as Blob).text();
    expect(JSON.parse(body)).toMatchObject({
      path: "/patients/:id/edit",
      digest: null,
    });
    expect(body).not.toContain("Daisy");
    expect(body).not.toContain("323e4567");
  });
});
