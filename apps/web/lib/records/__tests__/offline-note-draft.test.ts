import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import {
  DRAFT_DATABASE,
  hasOfflineNoteDraft,
  noteDraftStorageKey,
  OfflineNoteVault,
  type NoteDraftScope,
  type OfflineNoteDraft,
} from "../offline-note-draft";

const scope: NoteDraftScope = {
  practiceId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  patientId: "33333333-3333-4333-8333-333333333333",
};
const other = "44444444-4444-4444-8444-444444444444";
const password = "synthetic draft recovery passphrase";
const draft: OfflineNoteDraft = {
  content: "Synthetic clinical text\nLiteral <script> & Unicode 🐈",
  noteType: "phone_call",
  operationId: "55555555-5555-4555-8555-555555555555",
};

async function record(factory: IDBFactory, key: string, replacement?: unknown) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DRAFT_DATABASE, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<any>((resolve, reject) => {
      const tx = db.transaction(
        "drafts",
        replacement === undefined ? "readonly" : "readwrite",
      );
      const request =
        replacement === undefined
          ? tx.objectStore("drafts").get(key)
          : tx.objectStore("drafts").put(replacement, key);
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

describe("encrypted chart-note recovery", () => {
  it("persists ciphertext only and recovers the complete note and original retry ID", async () => {
    const factory = new IDBFactory();
    const { vault } = await OfflineNoteVault.unlock(scope, password, factory);
    await vault.save(draft);
    const raw = await record(factory, await noteDraftStorageKey(scope));
    expect(Object.keys(raw).sort()).toEqual([
      "ciphertext",
      "iv",
      "revision",
      "salt",
      "version",
    ]);
    expect(new TextDecoder().decode(raw.ciphertext)).not.toContain("Synthetic");
    expect(JSON.stringify(raw)).not.toContain(password);
    expect(JSON.stringify(raw)).not.toContain(scope.patientId);
    expect(JSON.stringify(raw)).not.toContain(draft.operationId);
    const recovered = await OfflineNoteVault.unlock(scope, password, factory);
    expect(recovered.draft).toEqual(draft);
    await recovered.vault.clear();
    expect(await hasOfflineNoteDraft(scope, factory)).toBe(false);
  });

  it("wrong passphrases fail without changing the recoverable copy", async () => {
    const factory = new IDBFactory();
    const { vault } = await OfflineNoteVault.unlock(scope, password, factory);
    await vault.save(draft);
    await expect(
      OfflineNoteVault.unlock(scope, "wrong synthetic passphrase", factory),
    ).rejects.toThrow("Unable to unlock");
    expect(
      (await OfflineNoteVault.unlock(scope, password, factory)).draft,
    ).toEqual(draft);
  });

  it("isolates practice, author and patient and authenticates the encrypted scope", async () => {
    const factory = new IDBFactory();
    const { vault } = await OfflineNoteVault.unlock(scope, password, factory);
    await vault.save(draft);
    const raw = await record(factory, await noteDraftStorageKey(scope));
    for (const field of ["practiceId", "userId", "patientId"] as const) {
      const foreign = { ...scope, [field]: other };
      expect(await hasOfflineNoteDraft(foreign, factory)).toBe(false);
      // Moving a ciphertext into another scope cannot make it decrypt there.
      await record(factory, await noteDraftStorageKey(foreign), raw);
      await expect(
        OfflineNoteVault.unlock(foreign, password, factory),
      ).rejects.toThrow("Unable to unlock");
    }
  });

  it("rejects tampered ciphertext without returning clinical data", async () => {
    const factory = new IDBFactory();
    const { vault } = await OfflineNoteVault.unlock(scope, password, factory);
    await vault.save(draft);
    const key = await noteDraftStorageKey(scope);
    const raw = await record(factory, key);
    new Uint8Array(raw.ciphertext)[0] ^= 1;
    await record(factory, key, raw);
    await expect(
      OfflineNoteVault.unlock(scope, password, factory),
    ).rejects.toThrow("Unable to unlock");
  });

  it("serializes pending writes and prevents a stale tab from overwriting or deleting a newer draft", async () => {
    const factory = new IDBFactory();
    const first = await OfflineNoteVault.unlock(scope, password, factory);
    await first.vault.save({ ...draft, content: "First", operationId: null });
    const second = await OfflineNoteVault.unlock(scope, password, factory);
    await Promise.all([
      first.vault.save({ ...draft, content: "Second", operationId: null }),
      first.vault.save({ ...draft, content: "Newest", operationId: null }),
    ]);
    await expect(second.vault.save(draft)).rejects.toThrow("another tab");
    await expect(second.vault.clear()).rejects.toThrow("another tab");
    expect(
      (await OfflineNoteVault.unlock(scope, password, factory)).draft?.content,
    ).toBe("Newest");
  });

  it("lets exactly one tab create a new draft when both start from an empty slot", async () => {
    const factory = new IDBFactory();
    const [a, b] = await Promise.all([
      OfflineNoteVault.unlock(scope, password, factory),
      OfflineNoteVault.unlock(scope, password, factory),
    ]);
    const results = await Promise.allSettled([
      a.vault.save(draft),
      b.vault.save({ ...draft, content: "Other tab" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("fails closed for denied storage, invalid records, and oversized drafts", async () => {
    const denied = {
      open() {
        throw new DOMException("denied", "SecurityError");
      },
    } as unknown as IDBFactory;
    await expect(hasOfflineNoteDraft(scope, denied)).rejects.toThrow();
    const factory = new IDBFactory();
    const { vault } = await OfflineNoteVault.unlock(scope, password, factory);
    expect(() =>
      vault.save({ ...draft, content: "x".repeat(20_001) }),
    ).toThrow();
    expect(await hasOfflineNoteDraft(scope, factory)).toBe(false);
    await vault.save(draft);
    await record(factory, await noteDraftStorageKey(scope), { version: 999 });
    await expect(
      OfflineNoteVault.unlock(scope, password, factory),
    ).rejects.toThrow("not been overwritten");
  });

  it("requires a substantial passphrase and valid tenant scope", async () => {
    const factory = new IDBFactory();
    await expect(
      OfflineNoteVault.unlock(scope, "short", factory),
    ).rejects.toThrow("12 characters");
    await expect(
      noteDraftStorageKey({ ...scope, patientId: "" }),
    ).rejects.toThrow();
  });

  it("reports a quota failure and keeps the last committed copy recoverable", async () => {
    const factory = new IDBFactory();
    const { vault } = await OfflineNoteVault.unlock(scope, password, factory);
    await vault.save(draft);
    const put = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementationOnce(() => {
        throw new DOMException(
          "Synthetic quota exhausted",
          "QuotaExceededError",
        );
      });
    try {
      await expect(
        vault.save({ ...draft, content: "Uncommitted change" }),
      ).rejects.toThrow("Unable to save");
    } finally {
      put.mockRestore();
    }
    // Failure cannot silently resume or erase the last acknowledged device copy.
    await expect(vault.clear()).rejects.toThrow("Unable to save");
    expect(
      (await OfflineNoteVault.unlock(scope, password, factory)).draft,
    ).toEqual(draft);
  });
});
