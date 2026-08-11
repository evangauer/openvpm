import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type WebhookRow = {
  url: string;
  secret: string;
  events: string[];
};

const mocks = vi.hoisted(() => {
  const activeWebhooks: WebhookRow[] = [];
  const selectWhere = vi.fn(async () => activeWebhooks);
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: selectWhere })),
    })),
  };

  return {
    activeWebhooks,
    db: {},
    tx,
    selectWhere,
    alertOps: vi.fn(async () => undefined),
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    ),
    lockPracticeForExternalSideEffects: vi.fn(async () => true),
  };
});

vi.mock("@openpims/db/client", () => ({
  db: mocks.db,
}));

vi.mock("@/lib/alerts", () => ({
  alertOps: mocks.alertOps,
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
}));

vi.mock("@/lib/recovery-hold", () => ({
  lockPracticeForExternalSideEffects:
    mocks.lockPracticeForExternalSideEffects,
}));

const { WEBHOOK_DELIVERY_TIMEOUT_MS, dispatchWebhookEvent } = await import(
  "../webhook-dispatcher"
);

const PRACTICE_ID = "00000000-0000-0000-0000-000000000001";
const EVENT = "appointment.created";

function webhook(overrides: Partial<WebhookRow> = {}): WebhookRow {
  return {
    url: "https://example.com/openvpm",
    secret: "secret",
    events: [EVENT],
    ...overrides,
  };
}

beforeEach(() => {
  mocks.activeWebhooks.length = 0;
  mocks.lockPracticeForExternalSideEffects.mockResolvedValue(true);
  mocks.selectWhere.mockImplementation(async () => mocks.activeWebhooks);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("webhook dispatcher delivery", () => {
  it("does not query or deliver while the practice is on recovery hold", async () => {
    mocks.lockPracticeForExternalSideEffects.mockResolvedValueOnce(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await dispatchWebhookEvent(PRACTICE_ID, EVENT, { id: "appt-1" });

    expect(mocks.tx.select).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("delivers subscribed events with a timeout signal", async () => {
    mocks.activeWebhooks.push(webhook());
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await dispatchWebhookEvent(PRACTICE_ID, EVENT, { id: "appt-1" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as unknown as [string, RequestInit];
    expect(url).toBe("https://example.com/openvpm");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Webhook-Event": EVENT,
      "X-Webhook-Signature": expect.any(String),
    });
    expect(JSON.parse(init.body as string)).toMatchObject({
      event: EVENT,
      data: { id: "appt-1" },
    });
    await vi.waitFor(() => expect(mocks.alertOps).not.toHaveBeenCalled());
  });

  it("does not resolve until webhook deliveries settle", async () => {
    mocks.activeWebhooks.push(webhook());
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    let settled = false;
    const dispatch = dispatchWebhookEvent(PRACTICE_ID, EVENT, { id: "appt-1" });
    void dispatch.then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveFetch(new Response(null, { status: 204 }));
    await dispatch;

    expect(settled).toBe(true);
    expect(mocks.alertOps).not.toHaveBeenCalled();
  });

  it("alerts when a webhook delivery times out", async () => {
    vi.useFakeTimers();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.activeWebhooks.push(webhook({ url: "https://slow.example/hook" }));
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const dispatch = dispatchWebhookEvent(PRACTICE_ID, EVENT, { id: "appt-1" });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(WEBHOOK_DELIVERY_TIMEOUT_MS);
      await dispatch;

      await vi.waitFor(() =>
        expect(mocks.alertOps).toHaveBeenCalledWith(
          "Webhook delivery failed",
          expect.stringContaining(
            `1 of 1 '${EVENT}' webhook deliveries failed for practice ${PRACTICE_ID}.`,
          ),
        ),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("alerts when webhook subscriptions cannot be loaded", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.selectWhere.mockRejectedValueOnce(new Error("db down"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    try {
      await dispatchWebhookEvent(PRACTICE_ID, EVENT, { id: "appt-1" });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.alertOps).toHaveBeenCalledWith(
        "Webhook dispatch query failed",
        `Could not load webhook subscriptions for practice ${PRACTICE_ID} while dispatching '${EVENT}'.`
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not fetch stale invalid delivery URLs", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.activeWebhooks.push(webhook({ url: "ftp://example.com/hook" }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    try {
      await dispatchWebhookEvent(PRACTICE_ID, EVENT, { id: "appt-1" });

      expect(fetchMock).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(mocks.alertOps).toHaveBeenCalledWith(
          "Webhook delivery failed",
          expect.stringContaining(`1 of 1 '${EVENT}' webhook deliveries failed`),
        ),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
