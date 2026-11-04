import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock("@/lib/trpc", () => ({
  trpc: { clients: { getAccountBalance: { useQuery: mocks.useQuery } } },
}));

const { ClientAccountBalance, ClientAccountBalanceContent } = await import(
  "@/components/clients/client-account-balance"
);

const syntheticBalance = {
  outstandingCents: 11_500,
  overdueCents: 5_000,
  openInvoiceCount: 2,
  currency: "gbp",
  country: "GB",
};

function render(props: Parameters<typeof ClientAccountBalanceContent>[0]) {
  return renderToStaticMarkup(createElement(ClientAccountBalanceContent, props));
}

beforeEach(() => mocks.useQuery.mockReset());

describe("client balance display", () => {
  it("keeps a loading balance distinct from a settled account", () => {
    const html = render({ loading: true, unavailable: false });
    expect(html).toContain("Loading client balance...");
    expect(html).not.toContain("No issued balance due");
    expect(html).not.toContain("$0.00");
  });

  it("suppresses stale balance amounts after a failed refresh", () => {
    const html = render({ data: syntheticBalance, loading: false, unavailable: true });
    expect(html).toContain("Client balance unavailable");
    expect(html).not.toContain("115.00");
    expect(html).not.toContain("No issued balance due");
  });

  it("shows total owed and overdue slice in the verified practice currency", () => {
    const html = render({ data: syntheticBalance, loading: false, unavailable: false });
    expect(html).toContain("£115.00");
    expect(html).toContain("£50.00 overdue");
    expect(html).not.toContain("$115.00");
  });

  it("shows the number of open invoices when none are overdue", () => {
    const html = render({
      data: { ...syntheticBalance, overdueCents: 0 },
      loading: false,
      unavailable: false,
    });
    expect(html).toContain("2 open invoices");
  });

  it("shows zero only after a successful settled-account read", () => {
    const html = render({
      data: { ...syntheticBalance, outstandingCents: 0, overdueCents: 0, openInvoiceCount: 0 },
      loading: false,
      unavailable: false,
      onRefresh: () => undefined,
    });
    expect(html).toContain("£0.00");
    expect(html).toContain("No issued balance due");
    expect(html).toContain('aria-label="Refresh client balance"');
  });
});

describe("client balance query and refresh", () => {
  it("does not render a cached amount when the real query reports a refresh failure", () => {
    mocks.useQuery.mockReturnValue({
      data: syntheticBalance,
      isLoading: false,
      isFetching: false,
      error: new Error("Request failed"),
      refetch: vi.fn(),
    });

    const html = renderToStaticMarkup(
      createElement(ClientAccountBalance, { clientId: "client-a" }),
    );
    expect(html).toContain("Client balance unavailable");
    expect(html).not.toContain("115.00");
    expect(html).not.toContain("50.00");
    expect(html).not.toContain("No issued balance due");
  });

  it("invokes the query refetch when staff select the refresh button", () => {
    const refetch = vi.fn(async () => undefined);
    mocks.useQuery.mockReturnValue({
      data: syntheticBalance,
      isLoading: false,
      isFetching: false,
      error: null,
      refetch,
    });

    // The query wrapper has no other hooks. Invoke it with the mocked query
    // state, then exercise the actual button callback from the returned view.
    const wrapper = ClientAccountBalance({ clientId: "client-a" });
    const content = ClientAccountBalanceContent(wrapper.props);
    const button = Children.toArray(content.props.children).find(
      (child) => isValidElement(child) && child.type === "button",
    );
    if (!isValidElement<{ onClick: () => void }>(button)) {
      throw new Error("Refresh control was not rendered");
    }
    button.props.onClick();

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("requests the new client and hides old data while that balance is loading", () => {
    mocks.useQuery
      .mockReturnValueOnce({
        data: syntheticBalance,
        isLoading: false,
        isFetching: false,
        error: null,
        refetch: vi.fn(),
      })
      .mockReturnValueOnce({
        // Even accidental previous data must not appear as the new client's
        // balance while the replacement request is pending.
        data: syntheticBalance,
        isLoading: true,
        isFetching: true,
        error: null,
        refetch: vi.fn(),
      });

    const first = renderToStaticMarkup(
      createElement(ClientAccountBalance, { clientId: "client-a" }),
    );
    const second = renderToStaticMarkup(
      createElement(ClientAccountBalance, { clientId: "client-b" }),
    );

    expect(first).toContain("£115.00");
    expect(second).toContain("Loading client balance...");
    expect(second).not.toContain("115.00");
    expect(mocks.useQuery.mock.calls.map(([input]) => input)).toEqual([
      { clientId: "client-a" },
      { clientId: "client-b" },
    ]);
  });

  it("prevents another refresh while one is already in flight", () => {
    mocks.useQuery.mockReturnValue({
      data: syntheticBalance,
      isLoading: false,
      isFetching: true,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderToStaticMarkup(
      createElement(ClientAccountBalance, { clientId: "client-a" }),
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Refresh client balance"/);
  });

  it("overrides the app's disabled focus refetch for current balance reads", () => {
    mocks.useQuery.mockReturnValue({
      data: syntheticBalance,
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    });

    renderToStaticMarkup(
      createElement(ClientAccountBalance, { clientId: "client-a" }),
    );
    expect(mocks.useQuery).toHaveBeenCalledWith(
      { clientId: "client-a" },
      {
        enabled: true,
        staleTime: 0,
        refetchOnMount: true,
        refetchOnWindowFocus: true,
        refetchInterval: 60_000,
      },
    );
  });
});
