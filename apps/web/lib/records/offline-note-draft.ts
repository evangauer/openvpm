import { z } from "zod";
import {
  PATIENT_NOTE_MAX_LENGTH,
  PATIENT_NOTE_TYPES,
} from "./patient-note-policy";

export type NoteDraftScope = {
  practiceId: string;
  userId: string;
  patientId: string;
};
const draftSchema = z
  .object({
    content: z.string().max(PATIENT_NOTE_MAX_LENGTH),
    noteType: z.enum(PATIENT_NOTE_TYPES),
    operationId: z.string().uuid().nullable(),
  })
  .strict();
export type OfflineNoteDraft = z.infer<typeof draftSchema>;
export const EMPTY_NOTE_DRAFT: OfflineNoteDraft = {
  content: "",
  noteType: "general",
  operationId: null,
};
export const DRAFT_DATABASE = "openvpm-encrypted-note-drafts-v1";
const STORE = "drafts";
const recordSchema = z
  .object({
    version: z.literal(1),
    revision: z.string().uuid(),
    salt: z.array(z.number().int().min(0).max(255)).length(16),
    iv: z.array(z.number().int().min(0).max(255)).length(12),
    ciphertext: z
      .instanceof(ArrayBuffer)
      .refine((value) => value.byteLength <= 160_000),
  })
  .strict();
type DraftRecord = z.infer<typeof recordSchema>;
const conflictMessage =
  "This device draft changed in another tab. Reopen the chart to recover that version. Your current text is still here.";

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DRAFT_DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () =>
      reject(new Error("Device draft storage is unavailable."));
    request.onblocked = () =>
      reject(new Error("Close other OpenVPM tabs and try again."));
    request.onsuccess = () => resolve(request.result);
  });
}

async function readRecord(
  factory: IDBFactory,
  key: string,
): Promise<DraftRecord | null> {
  const db = await openDatabase(factory);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, "readonly");
      const request = transaction.objectStore(STORE).get(key);
      transaction.oncomplete = () => {
        if (request.result === undefined) return resolve(null);
        const parsed = recordSchema.safeParse(request.result);
        if (parsed.success) resolve(parsed.data);
        else
          reject(
            new Error(
              "The device draft cannot be read. It has not been overwritten.",
            ),
          );
      };
      transaction.onabort = () =>
        reject(new Error("Unable to read the device draft."));
    });
  } finally {
    db.close();
  }
}

/** Compare-and-swap inside one IndexedDB transaction: another tab cannot silently overwrite a draft. */
async function replaceRecord(
  factory: IDBFactory,
  key: string,
  expectedRevision: string | null,
  value: DraftRecord | null,
) {
  const db = await openDatabase(factory);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const read = store.get(key);
      let conflict = false;
      read.onsuccess = () => {
        if ((read.result?.revision ?? null) !== expectedRevision) {
          conflict = true;
          transaction.abort();
          return;
        }
        if (value) store.put(value, key);
        else store.delete(key);
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(
          new Error(
            conflict
              ? conflictMessage
              : "Unable to save the device draft. Keep this tab open.",
          ),
        );
    });
  } finally {
    db.close();
  }
}

export async function noteDraftStorageKey(
  scope: NoteDraftScope,
): Promise<string> {
  const id = z.string().uuid();
  const context = JSON.stringify([
    id.parse(scope.practiceId),
    id.parse(scope.userId),
    id.parse(scope.patientId),
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(context),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>) {
  if (passphrase.length < 12 || passphrase.length > 1024)
    throw new Error("Use a draft passphrase of at least 12 characters.");
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 600_000 },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function hasOfflineNoteDraft(
  scope: NoteDraftScope,
  factory: IDBFactory = indexedDB,
) {
  return Boolean(await readRecord(factory, await noteDraftStorageKey(scope)));
}

/** Keys and passphrases are never persisted. Only authenticated ciphertext and an opaque scope digest reach IndexedDB. */
export class OfflineNoteVault {
  private queue: Promise<void> = Promise.resolve();
  private constructor(
    private factory: IDBFactory,
    private storageKey: string,
    private key: CryptoKey,
    private salt: Uint8Array<ArrayBuffer>,
    private revision: string | null,
  ) {}

  static async unlock(
    scope: NoteDraftScope,
    passphrase: string,
    factory: IDBFactory = indexedDB,
  ) {
    const storageKey = await noteDraftStorageKey(scope);
    const record = await readRecord(factory, storageKey);
    const salt = record
      ? new Uint8Array(record.salt)
      : crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(passphrase, salt);
    let draft: OfflineNoteDraft | null = null;
    if (record) {
      try {
        const plaintext = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: new Uint8Array(record.iv),
            additionalData: new TextEncoder().encode(storageKey),
          },
          key,
          record.ciphertext,
        );
        draft = draftSchema.parse(
          JSON.parse(new TextDecoder().decode(plaintext)),
        );
      } catch {
        throw new Error(
          "Unable to unlock this draft. Check the passphrase. The saved copy has not changed.",
        );
      }
    }
    return {
      vault: new OfflineNoteVault(
        factory,
        storageKey,
        key,
        salt,
        record?.revision ?? null,
      ),
      draft,
    };
  }

  save(draft: OfflineNoteDraft): Promise<void> {
    // Snapshot before entering the queue, so later keystrokes cannot mutate a pending write.
    const snapshot = draftSchema.parse(draft);
    const write = this.queue.then(async () => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: new TextEncoder().encode(this.storageKey),
        },
        this.key,
        new TextEncoder().encode(JSON.stringify(snapshot)),
      );
      const revision = crypto.randomUUID();
      await replaceRecord(this.factory, this.storageKey, this.revision, {
        version: 1,
        revision,
        salt: Array.from(this.salt),
        iv: Array.from(iv),
        ciphertext,
      });
      this.revision = revision;
    });
    // A failed write freezes this vault; reopening explicitly resolves conflicts.
    this.queue = write;
    return write;
  }

  clear(): Promise<void> {
    const clear = this.queue.then(async () => {
      await replaceRecord(this.factory, this.storageKey, this.revision, null);
      this.revision = null;
    });
    this.queue = clear;
    return clear;
  }
}
