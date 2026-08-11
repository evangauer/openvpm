import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@openpims/db/client";
import { projectInboundSmsReplyInTransaction } from "../inbound";

type RecordedWrite = { table: string; values: Record<string, unknown> };

function tableName(table: unknown): string {
  if (!table || typeof table !== "object") return "";
  for (const symbol of Object.getOwnPropertySymbols(table)) {
    if (symbol.description?.includes("Name")) {
      const value = (table as Record<symbol, unknown>)[symbol];
      if (typeof value === "string") return value;
    }
  }
  return "";
}

function fakeTransaction(input: {
  selects: unknown[][];
  inserts?: unknown[][];
  updates?: unknown[][];
}) {
  const state = {
    inserts: [] as RecordedWrite[],
    updates: [] as RecordedWrite[],
    deletes: [] as string[],
    executes: [] as unknown[],
  };
  const selectResults = [...input.selects];
  const insertResults = [...(input.inserts ?? [])];
  const updateResults = [...(input.updates ?? [])];
  const terminal = (result: unknown[]) => {
    const value = {
      for: vi.fn(() => value),
      then: (
        resolve: (rows: unknown[]) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject),
    };
    return value;
  };
  const tx = {
    execute: vi.fn(async (query: unknown) => {
      state.executes.push(query);
    }),
    select: vi.fn(() => {
      const builder = {
        from: () => builder,
        innerJoin: () => builder,
        where: () => builder,
        orderBy: () => builder,
        limit: () => terminal(selectResults.shift() ?? []),
      };
      return builder;
    }),
    insert: vi.fn((table: unknown) => {
      const name = tableName(table);
      let values: Record<string, unknown> = {};
      const conflict = {
        returning: vi.fn(async () => insertResults.shift() ?? []),
        then: (
          resolve: (rows: unknown[]) => unknown,
          reject?: (error: unknown) => unknown,
        ) => Promise.resolve([]).then(resolve, reject),
      };
      return {
        values(inputValues: Record<string, unknown>) {
          values = inputValues;
          state.inserts.push({ table: name, values });
          return {
            onConflictDoNothing: () => conflict,
            onConflictDoUpdate: () => conflict,
          };
        },
      };
    }),
    update: vi.fn((table: unknown) => {
      const name = tableName(table);
      let values: Record<string, unknown> = {};
      const where = {
        returning: vi.fn(async () => updateResults.shift() ?? []),
        then: (
          resolve: (rows: unknown[]) => unknown,
          reject?: (error: unknown) => unknown,
        ) => Promise.resolve([]).then(resolve, reject),
      };
      return {
        set(inputValues: Record<string, unknown>) {
          values = inputValues;
          state.updates.push({ table: name, values });
          return { where: () => where };
        },
      };
    }),
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(async () => {
        state.deletes.push(tableName(table));
      }),
    })),
  };
  return { tx: tx as unknown as Database, state };
}

const base = {
  provider: "telnyx" as const,
  practiceId: "00000000-0000-0000-0000-000000000001",
  locationId: "00000000-0000-0000-0000-000000000002",
  fromPhone: "+15555550199",
  providerMessageId: "message-1",
  occurredAt: new Date("2026-08-11T12:00:00.000Z"),
};

beforeEach(() => vi.clearAllMocks());

describe("atomic inbound SMS projection", () => {
  it("applies STOP evidence, suppression, client revocation, and communication together", async () => {
    const { tx, state } = fakeTransaction({
      selects: [[], [{ id: "client-1" }]],
      inserts: [[{ id: "consent-1" }]],
      updates: [[{ id: "client-1" }]],
    });
    await expect(
      projectInboundSmsReplyInTransaction(tx, {
        ...base,
        text: "STOP",
        classification: "stop",
      }),
    ).resolves.toEqual({ ok: true, action: "suppressed" });

    expect(state.executes).toHaveLength(1);
    expect(state.inserts.map((write) => write.table)).toEqual([
      "sms_consent_events",
      "sms_suppressions",
      "communications",
    ]);
    expect(state.updates).toContainEqual(
      expect.objectContaining({
        table: "clients",
        values: expect.objectContaining({ smsConsent: false }),
      }),
    );
    expect(state.inserts[0]!.values.detail).toBe(
      "Inbound SMS opt-out received.",
    );
    expect(state.inserts[2]!.values.content).toBe("STOP");
  });

  it("removes only STOP and restores consent for a unique START match", async () => {
    const { tx, state } = fakeTransaction({
      selects: [[], [{ id: "client-1" }], [{ reason: "stop" }]],
      inserts: [[{ id: "consent-1" }]],
      updates: [[{ id: "client-1" }]],
    });
    await expect(
      projectInboundSmsReplyInTransaction(tx, {
        ...base,
        text: "START",
        classification: "start",
      }),
    ).resolves.toEqual({ ok: true, action: "unsuppressed" });
    expect(state.deletes).toEqual(["sms_suppressions"]);
    expect(state.updates).toContainEqual(
      expect.objectContaining({
        table: "clients",
        values: expect.objectContaining({
          smsConsent: true,
          smsConsentAt: base.occurredAt,
        }),
      }),
    );
  });

  it.each(["manual", "bounce", "complaint"] as const)(
    "keeps %s suppression authoritative over START",
    async (reason) => {
      const { tx, state } = fakeTransaction({
        selects: [[], [{ id: "client-1" }], [{ reason }]],
        inserts: [[{ id: "consent-1" }]],
      });
      await expect(
        projectInboundSmsReplyInTransaction(tx, {
          ...base,
          text: "START",
          classification: "start",
        }),
      ).resolves.toEqual({ ok: true, action: "suppressed" });
      expect(state.deletes).toHaveLength(0);
      expect(state.updates).toHaveLength(0);
    },
  );

  it("does not broadly restore clients when phone identity is ambiguous", async () => {
    const { tx, state } = fakeTransaction({
      selects: [
        [],
        [{ id: "client-1" }, { id: "client-2" }],
        [{ reason: "stop" }],
      ],
      inserts: [[{ id: "consent-1" }]],
    });
    await projectInboundSmsReplyInTransaction(tx, {
      ...base,
      text: "START",
      classification: "start",
    });
    expect(state.deletes).toEqual(["sms_suppressions"]);
    expect(state.updates).toHaveLength(0);
    const communication = state.inserts.find(
      (write) => write.table === "communications",
    );
    expect(communication?.values.clientId).toBeUndefined();
  });

  it("does not replay START state mutation when consent evidence already exists", async () => {
    const { tx, state } = fakeTransaction({
      selects: [[], [{ id: "client-1" }], [{ reason: "stop" }]],
      inserts: [[]],
    });
    await projectInboundSmsReplyInTransaction(tx, {
      ...base,
      text: "START",
      classification: "start",
    });
    expect(state.deletes).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it("prevents an older START from clearing a newer STOP", async () => {
    const { tx, state } = fakeTransaction({
      selects: [
        [{ action: "revoked", occurredAt: new Date("2026-08-11T12:01:00Z") }],
        [{ id: "client-1" }],
        [{ reason: "stop" }],
      ],
      inserts: [[{ id: "consent-1" }]],
    });
    await expect(
      projectInboundSmsReplyInTransaction(tx, {
        ...base,
        text: "START",
        classification: "start",
      }),
    ).resolves.toEqual({ ok: true, action: "suppressed" });
    expect(state.deletes).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it("does not log a communication when START projection fails atomically", async () => {
    const { tx, state } = fakeTransaction({
      selects: [[], [{ id: "client-1" }], [{ reason: "stop" }]],
      inserts: [[{ id: "consent-1" }]],
      updates: [[]],
    });
    await expect(
      projectInboundSmsReplyInTransaction(tx, {
        ...base,
        text: "START",
        classification: "start",
      }),
    ).rejects.toThrow(
      "Inbound SMS opt-in client changed before consent could be projected",
    );
    expect(
      state.inserts.some((write) => write.table === "communications"),
    ).toBe(false);
  });
});
