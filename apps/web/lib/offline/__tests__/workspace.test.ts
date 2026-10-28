import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  addPreparedChart,
  beginSoapSync,
  chartHasChanges,
  chartKey,
  completeSoapSync,
  EMPTY_SOAP,
  offlineAccessValid,
  openWorkspace,
  WORKSPACE_DATABASE,
  WORKSPACE_KEY,
  workspaceSchema,
  type ChartSnapshot,
  type OfflineWorkspace,
} from "../workspace";

const patientId = "11111111-1111-4111-8111-111111111111",
  appointmentId = "22222222-2222-4222-8222-222222222222",
  userId = "33333333-3333-4333-8333-333333333333",
  practiceId = "44444444-4444-4444-8444-444444444444",
  noteId = "55555555-5555-4555-8555-555555555555";
const now = Date.parse("2026-10-28T12:00:00Z");
const identity = {
  userId,
  practiceId,
  userName: "Synthetic Clinician",
  practiceName: "Synthetic Clinic",
  authorizedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 86_400_000).toISOString(),
  enabled: true,
};
const snapshot: ChartSnapshot = {
  patient: {
    id: patientId,
    name: "Synthetic patient",
    species: "feline",
    breed: null,
    sex: null,
    dob: null,
  },
  capturedAt: identity.authorizedAt,
  allergies: [
    {
      allergen: "Synthetic allergy",
      reaction: "Synthetic reaction",
      severity: "severe",
    },
  ],
  notes: [],
  soapHistory: [],
  visit: {
    appointmentId,
    startTime: identity.authorizedAt,
    noteId: null,
    revision: 0,
    sections: { ...EMPTY_SOAP },
  },
};
const initial: OfflineWorkspace = { version: 1, identity, charts: [] };
const prepared = () => addPreparedChart(initial, snapshot, identity);

describe("offline chart workspace", () => {
  it("preserves complete clinical context and pending retry through encrypted reload", async () => {
    const factory = new IDBFactory(),
      phrase = "synthetic workspace passphrase";
    const opened = await openWorkspace(phrase, factory),
      value = prepared();
    value.charts[0]!.sections.subjective = "<p>Unsent text 🐈</p>";
    value.charts[0] = beginSoapSync(value.charts[0]!);
    await opened.vault.save(value);
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = factory.open(WORKSPACE_DATABASE);
      request.onsuccess = () => resolve(request.result);
    });
    const raw = await new Promise<Record<string, unknown>>((resolve) => {
      const request = db
        .transaction("drafts")
        .objectStore("drafts")
        .get(WORKSPACE_KEY);
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    expect(Object.keys(raw).sort()).toEqual([
      "ciphertext",
      "iv",
      "revision",
      "salt",
      "version",
    ]);
    expect(JSON.stringify(raw)).not.toMatch(
      /Synthetic|Unsent|33333333|44444444/,
    );
    const recovered = await openWorkspace(phrase, factory);
    expect(recovered.value).toEqual(value);
    expect(beginSoapSync(recovered.value!.charts[0]!).pending).toEqual(
      value.charts[0]!.pending,
    );
    await expect(
      openWorkspace("incorrect synthetic passphrase", factory),
    ).rejects.toThrow("Unable to unlock");
  });
  it("keeps newer server content separate without overwriting local notes", () => {
    const chart = prepared().charts[0]!;
    chart.sections.plan = "Local plan";
    const pending = beginSoapSync(chart);
    const conflict = completeSoapSync(pending, {
      outcome: "conflict",
      sections: { ...EMPTY_SOAP, plan: "Server plan" },
    });
    expect(conflict.sections.plan).toBe("Local plan");
    expect(conflict.conflict?.sections.plan).toBe("Server plan");
    expect(() => beginSoapSync(conflict)).toThrow("Resolve");
    expect(
      completeSoapSync(pending, {
        outcome: "already_finalized",
        sections: EMPTY_SOAP,
      }).conflict?.kind,
    ).toBe("already_finalized");
  });
  it("advances a draft revision only after acknowledgment and supports later edits", () => {
    const chart = prepared().charts[0]!;
    chart.sections.subjective = "New local text";
    const saved = completeSoapSync(beginSoapSync(chart), {
      outcome: "saved",
      noteId,
      revision: 1,
    });
    expect(chartHasChanges(saved)).toBe(false);
    saved.sections = { ...saved.sections, plan: "Next plan" };
    expect(beginSoapSync(saved).pending).toMatchObject({
      noteId,
      expectedRevision: 1,
      sections: { plan: "Next plan" },
    });
  });
  it("refuses account changes, dirty refreshes, and foreign pending identities", () => {
    const value = prepared();
    value.charts[0]!.sections.plan = "Local change";
    expect(() => addPreparedChart(value, snapshot, identity)).toThrow(
      "before refreshing",
    );
    expect(() =>
      addPreparedChart(initial, snapshot, { ...identity, userId: noteId }),
    ).toThrow("Sign in");
    value.charts[0] = beginSoapSync(value.charts[0]!);
    value.charts[0].pending!.appointmentId = noteId;
    expect(() => workspaceSchema.parse(value)).toThrow("Invalid pending");
  });
  it("distinguishes chart snapshots from separate visits and rejects duplicates", () => {
    const chartOnly = { ...snapshot, visit: null };
    const first = addPreparedChart(initial, chartOnly, identity);
    const both = addPreparedChart(first, snapshot, identity);
    expect(both.charts.map((c) => c.key)).toEqual([
      chartKey(chartOnly),
      chartKey(snapshot),
    ]);
    expect(() => beginSoapSync(first.charts[0]!)).toThrow("in-exam");
    expect(() =>
      workspaceSchema.parse({
        ...both,
        charts: [both.charts[0], both.charts[0]],
      }),
    ).toThrow("Invalid saved chart");
  });
  it("limits offline access to its bounded lease and rejects clock rollback", () => {
    expect(offlineAccessValid(identity, now)).toBe(true);
    expect(offlineAccessValid(identity, now + 86_400_000)).toBe(false);
    expect(offlineAccessValid(identity, now - 1)).toBe(false);
    expect(
      offlineAccessValid(
        { ...identity, expiresAt: new Date(now + 86_400_001).toISOString() },
        now,
      ),
    ).toBe(false);
  });
  it("blocks stale workspace writes from another tab, preserving the winning copy", async () => {
    const factory = new IDBFactory(),
      phrase = "synthetic workspace passphrase";
    const first = await openWorkspace(phrase, factory);
    await first.vault.save(prepared());
    const second = await openWorkspace(phrase, factory);
    const winner = prepared();
    winner.charts[0]!.sections.plan = "Winner";
    await first.vault.save(winner);
    await expect(second.vault.save(prepared())).rejects.toThrow("another tab");
    expect(
      (await openWorkspace(phrase, factory)).value?.charts[0]?.sections.plan,
    ).toBe("Winner");
  });
});
