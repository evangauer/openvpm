import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL("./route.ts", import.meta.url)),
  "utf8",
);

const mocks = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const selectLimit = vi.fn(async () => selectResults.shift() ?? []);
  const selectWhere = vi.fn(() => ({ limit: selectLimit }));
  const selectInnerJoin = vi.fn(() => ({ where: selectWhere }));
  const selectFrom = vi.fn(() => ({
    innerJoin: selectInnerJoin,
    where: selectWhere,
  }));
  const select = vi.fn(() => ({ from: selectFrom }));

  const updateWhere = vi.fn(async (_condition: unknown) => undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const insertConflict = vi.fn(async (_config?: unknown) => undefined);
  const insertValues = vi.fn((_values: unknown) => ({
    onConflictDoNothing: insertConflict,
  }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const db = { select, update, insert };
  const verify = vi.fn();
  const Resend = vi.fn(() => ({
    webhooks: { verify },
  }));

  return {
    db,
    selectResults,
    selectLimit,
    selectInnerJoin,
    insertConflict,
    insertValues,
    updateSet,
    updateWhere,
    verify,
    Resend,
    recordAuthEmailDeliveryEvent: vi.fn(
      async (): Promise<{
        tracked: boolean;
        duplicate: boolean;
        conflict: boolean;
        attribution: string | null;
      }> => ({
        tracked: false,
        duplicate: false,
        conflict: false,
        attribution: null,
      }),
    ),
    authEmailWebhookFingerprint: vi.fn(() => "f".repeat(64)),
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(db),
    ),
    withTenant: vi.fn(
      async (_db: unknown, _practiceId: string, fn: (tx: unknown) => unknown) =>
        fn(db),
    ),
  };
});

vi.mock("resend", () => ({
  Resend: mocks.Resend,
}));

vi.mock("@openpims/db/client", () => ({
  db: mocks.db,
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
  withTenant: mocks.withTenant,
}));

vi.mock("@/lib/auth-email-delivery", () => ({
  recordAuthEmailDeliveryEvent: mocks.recordAuthEmailDeliveryEvent,
  authEmailWebhookFingerprint: mocks.authEmailWebhookFingerprint,
}));

const { POST } = await import("./route");
const { EMAIL_WEBHOOK_BODY_MAX_BYTES } =
  await import("@/lib/email-webhook-limits");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const COMMUNICATION_ID = "00000000-0000-0000-0000-0000000000cc";

function signedRequest(body: string, headers?: Record<string, string>) {
  return new Request("https://openvpm.test/api/webhooks/resend", {
    method: "POST",
    headers: {
      "svix-id": "msg_123",
      "svix-timestamp": "1782777600",
      "svix-signature": "v1,test",
      ...headers,
    },
    body,
  });
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.selectResults.length = 0;
  mocks.recordAuthEmailDeliveryEvent.mockResolvedValue({
    tracked: false,
    duplicate: false,
    conflict: false,
    attribution: null,
  });
  delete process.env.RESEND_WEBHOOK_SECRET;
  delete process.env.RESEND_API_KEY;
});

describe("Resend webhook", () => {
  it("rejects oversized payloads before signature verification or tenant work", async () => {
    const response = await POST(
      signedRequest("{}", {
        "content-length": String(EMAIL_WEBHOOK_BODY_MAX_BYTES + 1),
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Email webhook payload too large",
    });
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it("rejects streamed oversized payloads without a content-length header", async () => {
    const response = await POST(
      signedRequest("x".repeat(EMAIL_WEBHOOK_BODY_MAX_BYTES + 1)),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Email webhook payload too large",
    });
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it("uses the capped streaming body reader", () => {
    expect(ROUTE_SOURCE).toContain("readRequestTextWithLimit(");
    expect(ROUTE_SOURCE).toContain("EMAIL_WEBHOOK_BODY_MAX_BYTES");
    expect(ROUTE_SOURCE).not.toMatch(/\b(?:req|request)\.text\(\)/);
  });

  it("fails closed when the webhook secret or Svix headers are missing", async () => {
    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/resend", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "invalid signature",
    });
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
  });

  it("treats a blank webhook secret as missing before signature verification", async () => {
    process.env.RESEND_WEBHOOK_SECRET = "   ";

    const response = await POST(signedRequest("{}"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "invalid signature",
    });
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
  });

  it("marks matched outbound email communications delivered", async () => {
    process.env.RESEND_WEBHOOK_SECRET = " whsec_test ";
    process.env.RESEND_API_KEY = " re_hook ";
    mocks.verify.mockReturnValue({
      type: "email.delivered",
      created_at: "2026-06-29T12:00:00Z",
      data: {
        email_id: "email-1",
        from: "OpenVPM <noreply@mail.openvpm.com>",
        to: ["Ada@Example.com"],
        subject: "Follow up",
        created_at: "2026-06-29T12:00:00Z",
      },
    });
    mocks.selectResults.push([
      { id: COMMUNICATION_ID, practiceId: PRACTICE_ID },
    ]);

    const response = await POST(signedRequest("{}"));

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.Resend).toHaveBeenCalledWith("re_hook");
    expect(mocks.verify).toHaveBeenCalledWith({
      payload: "{}",
      webhookSecret: "whsec_test",
      headers: {
        id: "msg_123",
        timestamp: "1782777600",
        signature: "v1,test",
      },
    });
    expect(mocks.withTenant).toHaveBeenCalledWith(
      mocks.db,
      PRACTICE_ID,
      expect.any(Function),
    );
    expect(mocks.updateSet).toHaveBeenCalledWith({ status: "delivered" });
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("marks bounced emails failed and suppresses normalized recipients", async () => {
    process.env.RESEND_WEBHOOK_SECRET = "whsec_test";
    mocks.verify.mockReturnValue({
      type: "email.bounced",
      created_at: "2026-06-29T12:00:00Z",
      data: {
        email_id: "email-1",
        from: "OpenVPM <noreply@mail.openvpm.com>",
        to: [" Ada@Example.com ", "not-an-email", "ada@example.com"],
        subject: "Follow up",
        created_at: "2026-06-29T12:00:00Z",
        bounce: {
          message: "Mailbox unavailable",
          subType: "General",
          type: "Permanent",
        },
      },
    });
    mocks.selectResults.push([
      { id: COMMUNICATION_ID, practiceId: PRACTICE_ID },
    ]);

    const response = await POST(signedRequest("{}"));

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.updateSet).toHaveBeenCalledWith({ status: "failed" });
    expect(mocks.insertValues).toHaveBeenCalledWith([
      {
        practiceId: PRACTICE_ID,
        email: "ada@example.com",
        reason: "bounce",
        detail: "Mailbox unavailable",
      },
    ]);
    expect(mocks.insertConflict).toHaveBeenCalledTimes(1);
  });

  it("records verification evidence without polluting client suppressions", async () => {
    process.env.RESEND_WEBHOOK_SECRET = "whsec_test";
    const event = {
      type: "email.bounced" as const,
      created_at: "2026-06-29T12:00:00Z",
      data: {
        email_id: "email-auth-1",
        from: "OpenVPM <noreply@mail.openvpm.com>",
        to: ["owner@example.com"],
        subject: "Verify your OpenVPM email",
        created_at: "2026-06-29T12:00:00Z",
        tags: {
          openvpm_email_kind: "auth_verification",
          openvpm_attempt_id: "00000000-0000-4000-8000-000000000001",
        },
        bounce: {
          message: "Mailbox unavailable",
          subType: "General",
          type: "Permanent",
        },
      },
    };
    mocks.verify.mockReturnValue(event);
    mocks.recordAuthEmailDeliveryEvent.mockResolvedValue({
      tracked: true,
      duplicate: false,
      conflict: false,
      attribution: "attempt_tag",
    });

    const response = await POST(signedRequest("{}"));

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.recordAuthEmailDeliveryEvent).toHaveBeenCalledWith({
      event,
      webhookId: "msg_123",
      rawBodyFingerprint: "f".repeat(64),
      db: mocks.db,
    });
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("acknowledges a durably quarantined Svix identity conflict without tenant work", async () => {
    process.env.RESEND_WEBHOOK_SECRET = "whsec_test";
    mocks.verify.mockReturnValue({
      type: "email.delivered",
      created_at: "2026-06-29T12:00:00Z",
      data: {
        email_id: "email-auth-1",
        from: "OpenVPM <noreply@mail.openvpm.com>",
        to: ["owner@example.com"],
        subject: "Verify your OpenVPM email",
        created_at: "2026-06-29T12:00:00Z",
        tags: { openvpm_email_kind: "auth_verification" },
      },
    });
    mocks.recordAuthEmailDeliveryEvent.mockResolvedValue({
      tracked: true,
      duplicate: false,
      conflict: true,
      attribution: "identity_conflict",
    });

    const response = await POST(signedRequest("changed signed body"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("acks unmatched provider events without creating suppressions", async () => {
    process.env.RESEND_WEBHOOK_SECRET = "whsec_test";
    mocks.verify.mockReturnValue({
      type: "email.complained",
      created_at: "2026-06-29T12:00:00Z",
      data: {
        email_id: "missing-email-id",
        from: "OpenVPM <noreply@mail.openvpm.com>",
        to: ["ada@example.com"],
        subject: "Follow up",
        created_at: "2026-06-29T12:00:00Z",
      },
    });
    mocks.selectResults.push([]);

    const response = await POST(signedRequest("{}"));

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("matches provider email events only for active practices", () => {
    const matchLookup = ROUTE_SOURCE.match(
      /const matches = await withSystem[\s\S]+?\.limit\(20\)/,
    )?.[0];

    expect(matchLookup).toContain("innerJoin(");
    expect(matchLookup).toContain("practices");
    expect(matchLookup).toContain("isNull(practices.deletedAt)");
  });
});
