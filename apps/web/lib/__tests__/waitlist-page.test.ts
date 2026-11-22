import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/routers/_app";
import WaitlistPage from "@/app/(dashboard)/schedule/waitlist/page";

const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock("@/lib/trpc", () => ({
  trpc: { waitlist: { list: { useQuery } } },
}));

type Entry = inferRouterOutputs<AppRouter>["waitlist"]["list"][number];
const entry: Entry = {
  id: "request-1",
  status: "waiting",
  typeId: null,
  preferredFrom: "2026-03-05",
  preferredTo: "2026-03-05",
  notes: "Call after 3 pm.\nAsk for <Sam>.",
  createdAt: new Date("2026-03-01T12:00:00Z"),
  clientFirstName: "Sam",
  clientLastName: "River",
  clientPhone: "555-0100",
  patientName: "Pippin",
  typeName: null,
};

function render(state: {
  data?: Entry[];
  isPending?: boolean;
  isFetching?: boolean;
  isError?: boolean;
}) {
  useQuery.mockReturnValue({
    isPending: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
    ...state,
  });
  return renderToStaticMarkup(React.createElement(WaitlistPage));
}

describe("staff appointment waitlist", () => {
  // The repository's Vitest JSX transform uses the classic runtime.
  beforeAll(() => vi.stubGlobal("React", React));
  afterAll(() => vi.unstubAllGlobals());
  beforeEach(() => vi.clearAllMocks());

  it("does not report an empty clinic while loading or after a failed refresh", () => {
    const loading = render({ isPending: true, isFetching: true });
    expect(loading).toContain("Loading waitlist");
    expect(loading).not.toContain("No clients waiting");

    const failure = render({ data: [entry], isError: true });
    expect(failure).toContain('role="alert"');
    expect(failure).toContain("Unable to load the waitlist");
    expect(failure).not.toContain("No clients waiting");
    expect(failure).not.toContain("Sam River");
  });

  it("shows an empty state only after the list succeeds", () => {
    expect(render({ data: [] })).toContain("No clients waiting");
    expect(useQuery).toHaveBeenCalledWith(
      { status: "waiting" },
      { refetchOnMount: "always" },
    );
  });

  it("preserves request order and shows contact, date preferences and escaped notes", () => {
    const markup = render({ data: [entry, { ...entry, id: "request-2", clientFirstName: "Alex" }] });
    expect(markup.indexOf("Sam River")).toBeLessThan(markup.indexOf("Alex River"));
    expect(markup).toContain("2 requests waiting");
    expect(markup).toContain("555-0100");
    expect(markup).toContain("Pippin");
    expect(markup).toContain("03/05/2026");
    expect(markup).toContain("Any type");
    expect(markup).toContain("Ask for &lt;Sam&gt;");
    expect(markup).toContain('href="/schedule"');
  });

  it("handles missing joined records without claiming a removed type is unrestricted", () => {
    const markup = render({ data: [{
      ...entry,
      clientFirstName: null,
      clientLastName: null,
      clientPhone: null,
      patientName: null,
      typeId: "removed-type",
      preferredFrom: null,
      preferredTo: null,
    }] });
    expect(markup).toContain("Client unavailable");
    expect(markup).toContain("Not specified or unavailable");
    expect(markup).toContain("Type unavailable");
    expect(markup).toContain("Any date");
    expect(markup).not.toContain("Any type");
  });

  it("keeps one-sided date windows and date ranges understandable", () => {
    expect(render({ data: [{ ...entry, preferredTo: null }] })).toContain("From 03/05/2026");
    expect(render({ data: [{ ...entry, preferredFrom: null }] })).toContain("Through 03/05/2026");
    expect(render({ data: [{ ...entry, preferredTo: "2026-03-07" }] })).toContain("03/05/2026 – 03/07/2026");
  });
});
