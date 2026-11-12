import { z } from "zod";
import {
  encryptedValueExists,
  EncryptedDeviceVault,
} from "../offline/encrypted-vault";
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

export async function hasOfflineNoteDraft(
  scope: NoteDraftScope,
  factory: IDBFactory = indexedDB,
) {
  return encryptedValueExists({
    database: DRAFT_DATABASE,
    storageKey: await noteDraftStorageKey(scope),
    factory,
  });
}
export type OfflineNoteVault = EncryptedDeviceVault<OfflineNoteDraft>;
export const OfflineNoteVault = {
  async unlock(
    scope: NoteDraftScope,
    passphrase: string,
    factory: IDBFactory = indexedDB,
  ) {
    const opened = await EncryptedDeviceVault.open(
      {
        database: DRAFT_DATABASE,
        storageKey: await noteDraftStorageKey(scope),
        validate: (value) => draftSchema.parse(value),
        maxBytes: 159_984,
        factory,
      },
      passphrase,
    );
    return { vault: opened.vault, draft: opened.value };
  },
};
