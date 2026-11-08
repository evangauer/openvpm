import { z } from "zod";

const STORE = "drafts";
const recordSchema = z
  .object({
    version: z.literal(1),
    revision: z.string().uuid(),
    salt: z.array(z.number().int().min(0).max(255)).length(16),
    iv: z.array(z.number().int().min(0).max(255)).length(12),
    ciphertext: z
      .instanceof(ArrayBuffer)
      .refine((value) => value.byteLength <= 8_000_000),
  })
  .strict();
type DraftRecord = z.infer<typeof recordSchema>;
const conflictMessage =
  "This device draft changed in another tab. Reopen the chart to recover that version. Your current text is still here.";

function openDatabase(
  factory: IDBFactory,
  database: string,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(database, 1);
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
  database: string,
  key: string,
): Promise<DraftRecord | null> {
  const db = await openDatabase(factory, database);
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
  database: string,
  key: string,
  expectedRevision: string | null,
  value: DraftRecord | null,
) {
  const db = await openDatabase(factory, database);
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

export interface VaultOptions<T> {
  database: string;
  storageKey: string;
  validate: (value: unknown) => T;
  maxBytes: number;
  factory?: IDBFactory;
}

export async function encryptedValueExists(
  options: Pick<VaultOptions<unknown>, "database" | "storageKey" | "factory">,
) {
  return Boolean(
    await readRecord(
      options.factory ?? indexedDB,
      options.database,
      options.storageKey,
    ),
  );
}

/** Persist only authenticated ciphertext. A failed write freezes the instance. */
export class EncryptedDeviceVault<T> {
  private queue: Promise<void> = Promise.resolve();
  private constructor(
    private options: VaultOptions<T>,
    private key: CryptoKey,
    private salt: Uint8Array<ArrayBuffer>,
    private revision: string | null,
  ) {}
  static async open<T>(options: VaultOptions<T>, passphrase: string) {
    const record = await readRecord(
      options.factory ?? indexedDB,
      options.database,
      options.storageKey,
    );
    if (record && record.ciphertext.byteLength > options.maxBytes + 16)
      throw new Error(
        "The device draft cannot be read. It has not been overwritten.",
      );
    const salt = record
      ? new Uint8Array(record.salt)
      : crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(passphrase, salt);
    let value: T | null = null;
    if (record) {
      try {
        const plaintext = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: new Uint8Array(record.iv),
            additionalData: new TextEncoder().encode(options.storageKey),
          },
          key,
          record.ciphertext,
        );
        value = options.validate(
          JSON.parse(new TextDecoder().decode(plaintext)),
        );
      } catch {
        throw new Error(
          "Unable to unlock this draft. Check the passphrase. The saved copy has not changed.",
        );
      }
    }
    return {
      vault: new EncryptedDeviceVault(
        options,
        key,
        salt,
        record?.revision ?? null,
      ),
      value,
    };
  }
  save(value: T): Promise<void> {
    const snapshot = optionsSnapshot(this.options, value);
    const write = this.queue.then(async () => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: new TextEncoder().encode(this.options.storageKey),
        },
        this.key,
        snapshot,
      );
      const revision = crypto.randomUUID();
      await replaceRecord(
        this.options.factory ?? indexedDB,
        this.options.database,
        this.options.storageKey,
        this.revision,
        {
          version: 1,
          revision,
          salt: Array.from(this.salt),
          iv: Array.from(iv),
          ciphertext,
        },
      );
      this.revision = revision;
    });
    this.queue = write;
    return write;
  }
  clear(): Promise<void> {
    const clear = this.queue.then(async () => {
      await replaceRecord(
        this.options.factory ?? indexedDB,
        this.options.database,
        this.options.storageKey,
        this.revision,
        null,
      );
      this.revision = null;
    });
    this.queue = clear;
    return clear;
  }
}

function optionsSnapshot<T>(options: VaultOptions<T>, value: T) {
  const validated = options.validate(structuredClone(value));
  const bytes = new TextEncoder().encode(JSON.stringify(validated));
  if (bytes.byteLength > options.maxBytes)
    throw new Error(
      "The device workspace is full. Save your notes online before adding more charts.",
    );
  return bytes;
}
