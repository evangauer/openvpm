import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import {
  csvToClientRecords,
  csvToPatientRecords,
  csvToSoapNoteRecords,
  csvToVaccinationRecords,
} from "@/lib/csv/import";
import { parseCsv } from "@/lib/csv/parse";
import { IMPORT_CSV_MAX_BYTES, IMPORT_MAX_ROWS } from "@/lib/import/policy";
import type { MigrationImportMode } from "@/lib/import/sources";

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const UNICODE_PATH_EXTRA_FIELD_ID = 0x7075;
const AES_EXTRA_FIELD_ID = 0x9901;
const ZIP_EOCD_MIN_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 65_535;

export const MIGRATION_ARCHIVE_LIMITS = {
  archiveBytes: 2_000_000_000,
  centralDirectoryBytes: 64_000_000,
  entries: 50_000,
  advertisedUncompressedBytes: 10_000_000_000,
  aggregateEntries: 100_000,
  csvCandidatesPerArchive: 128,
  aggregateCsvCandidates: 256,
  candidateCompressedBytes: IMPORT_CSV_MAX_BYTES + 65_536,
  candidateCompressionRatio: 200,
  csvLogicalRecords: IMPORT_MAX_ROWS + 1,
  csvColumnsPerRecord: 512,
  csvTotalCells: 1_000_000,
} as const;

export function candidateCompressionRatioExceedsLimit(
  compressedBytes: number,
  uncompressedBytes: number,
): boolean {
  return (
    uncompressedBytes / Math.max(1, compressedBytes) >
    MIGRATION_ARCHIVE_LIMITS.candidateCompressionRatio
  );
}

export function aggregateArchiveEntryBudgetExceeded(
  consumedEntries: number,
  incomingEntries: number,
  aggregateEntryLimit: number = MIGRATION_ARCHIVE_LIMITS.aggregateEntries,
): boolean {
  return consumedEntries + incomingEntries > aggregateEntryLimit;
}

export type MigrationArchivePreflightTestHooks = {
  /** Test-only synchronization point. Production callers must leave this unset. */
  afterArchiveInitialHash?: (context: {
    alias: string;
  }) => void | Promise<void>;
  /** Test-only compact substitute for the public 100,000-entry aggregate cap. */
  aggregateEntryLimitOverride?: number;
};

export type ArchiveBlockerCode =
  | "input_not_regular_file"
  | "input_symlink_rejected"
  | "input_owner_mismatch"
  | "input_permissions_too_open"
  | "input_owner_check_unavailable"
  | "archive_too_large"
  | "archive_truncated"
  | "archive_not_zip"
  | "archive_sfx_rejected"
  | "archive_zip64_rejected"
  | "archive_multidisk_rejected"
  | "central_directory_too_large"
  | "central_directory_invalid"
  | "too_many_entries"
  | "aggregate_entry_limit_exceeded"
  | "csv_candidate_limit_exceeded"
  | "advertised_output_too_large"
  | "entry_path_invalid"
  | "entry_path_collision"
  | "entry_name_encoding_invalid"
  | "entry_symlink_rejected"
  | "entry_special_file_rejected"
  | "entry_type_path_mismatch"
  | "entry_encrypted_rejected"
  | "entry_flags_unsupported"
  | "entry_compression_unsupported"
  | "entry_data_descriptor_rejected"
  | "entry_zip64_rejected"
  | "entry_unicode_path_override_rejected"
  | "entry_local_header_mismatch"
  | "entry_span_invalid"
  | "entry_span_gap"
  | "directory_payload_rejected"
  | "nested_archive_rejected"
  | "candidate_compressed_too_large"
  | "candidate_output_too_large"
  | "candidate_ratio_too_large"
  | "candidate_local_header_mismatch"
  | "candidate_data_out_of_bounds"
  | "candidate_decompression_failed"
  | "candidate_trailing_data_rejected"
  | "candidate_size_mismatch"
  | "candidate_crc_mismatch"
  | "candidate_utf8_invalid"
  | "candidate_csv_structure_limit_exceeded"
  | "candidate_row_limit_exceeded"
  | "candidate_csv_invalid"
  | "candidate_schema_unrecognized"
  | "candidate_schema_ambiguous"
  | "input_read_failed"
  | "input_changed_during_read";

export type SafeCsvErrorCategory =
  | "unterminated_quote"
  | "invalid_header"
  | "duplicate_header"
  | "extra_columns"
  | "missing_column"
  | "empty_csv"
  | "missing_identity"
  | "invalid_email"
  | "external_id_too_long"
  | "missing_name"
  | "invalid_species"
  | "invalid_date"
  | "missing_content"
  | "field_too_long"
  | "other";

export type ArchiveCandidateEvidence = {
  opaqueId: string;
  compressedBytes: number;
  uncompressedBytes: number;
  contentSha256: string | null;
  crcVerified: boolean;
  utf8Valid: boolean;
  sourceRows: number | null;
  validRows: number;
  errorCount: number;
  errorCategories: Partial<Record<SafeCsvErrorCategory, number>>;
  modeCandidates: MigrationImportMode[];
  inferredMode: MigrationImportMode | null;
  status: "valid" | "review_required" | "blocked";
  blockerCodes: ArchiveBlockerCode[];
  duplicateContent: boolean;
};

export type ArchiveEvidence = {
  alias: string;
  archiveSha256: string | null;
  archiveBytes: number | null;
  entryCount: number;
  directoryEntryCount: number;
  csvCandidateCount: number;
  unsupportedEntryCount: number;
  advertisedCompressedBytes: number;
  advertisedUncompressedBytes: number;
  status: "safe" | "review_required" | "blocked";
  blockerCodes: ArchiveBlockerCode[];
  candidates: ArchiveCandidateEvidence[];
};

export type MigrationArchivePreflightEvidence = {
  schemaVersion: 1;
  generatedAt: string;
  tool: "openvpm_migration_archive_preflight";
  source: "shepherd";
  networkUsed: false;
  databaseUsed: false;
  archiveExtractionUsed: false;
  authoritativeImportClaim: false;
  limits: typeof MIGRATION_ARCHIVE_LIMITS & {
    csvBytes: number;
    csvRows: number;
  };
  archives: ArchiveEvidence[];
  exactDuplicateCandidateCount: number;
  safeToContinueOfflineReview: boolean;
  readyForAuthoritativeCsvPreview: boolean;
  requiresUnsupportedDataReview: boolean;
};

type CentralDirectoryEntry = {
  nameBytes: Buffer;
  localHeaderOffset: number;
  dataOffset: number;
  spanEnd: number;
  generalPurposeFlags: number;
  compressionMethod: number;
  crc32: number;
  compressedBytes: number;
  uncompressedBytes: number;
  isDirectory: boolean;
  isCsv: boolean;
};

type InspectedArchive = {
  centralDirectoryOffset: number;
  entries: CentralDirectoryEntry[];
  directoryEntryCount: number;
  unsupportedEntryCount: number;
  advertisedCompressedBytes: number;
  advertisedUncompressedBytes: number;
};

class SafeArchiveError extends Error {
  constructor(readonly code: ArchiveBlockerCode) {
    super(code);
    this.name = "SafeArchiveError";
  }
}

function safeError(error: unknown): SafeArchiveError {
  return error instanceof SafeArchiveError
    ? error
    : new SafeArchiveError("input_read_failed");
}

async function readExactly(
  handle: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  if (length < 0 || position < 0 || !Number.isSafeInteger(length + position)) {
    throw new SafeArchiveError("archive_truncated");
  }
  const buffer = Buffer.alloc(length);
  let consumed = 0;
  while (consumed < length) {
    const result = await handle.read(
      buffer,
      consumed,
      length - consumed,
      position + consumed,
    );
    if (result.bytesRead === 0) {
      throw new SafeArchiveError("archive_truncated");
    }
    consumed += result.bytesRead;
  }
  return buffer;
}

async function sha256FileHandle(
  handle: FileHandle,
  fileBytes: number,
): Promise<string> {
  const hash = createHash("sha256");
  const chunkBytes = 1024 * 1024;
  for (let position = 0; position < fileBytes; position += chunkBytes) {
    hash.update(
      await readExactly(
        handle,
        position,
        Math.min(chunkBytes, fileBytes - position),
      ),
    );
  }
  return hash.digest("hex");
}

function hasExtraField(extra: Buffer, wantedId: number): boolean {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) {
      throw new SafeArchiveError("central_directory_invalid");
    }
    const id = extra.readUInt16LE(offset);
    const length = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + length > extra.length) {
      throw new SafeArchiveError("central_directory_invalid");
    }
    if (id === wantedId) return true;
    offset += length;
  }
  return false;
}

function decodeEntryName(nameBytes: Buffer, utf8: boolean): string {
  try {
    if (!utf8 && nameBytes.some((byte) => byte >= 0x80)) {
      throw new SafeArchiveError("entry_name_encoding_invalid");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
  } catch (error) {
    if (error instanceof SafeArchiveError) throw error;
    throw new SafeArchiveError("entry_name_encoding_invalid");
  }
}

function validateEntryPath(name: string): string {
  if (
    name.length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(name) ||
    name.includes("\\") ||
    name.startsWith("/") ||
    name.startsWith("//") ||
    /^[a-z]:/iu.test(name)
  ) {
    throw new SafeArchiveError("entry_path_invalid");
  }
  const isDirectory = name.endsWith("/");
  const parts = name.split("/");
  if (isDirectory) parts.pop();
  if (
    parts.length === 0 ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new SafeArchiveError("entry_path_invalid");
  }
  return `${parts.join("/")}${isDirectory ? "/" : ""}`.normalize("NFC");
}

type PathTrieNode = {
  children: Map<string, PathTrieNode>;
  kind: "file" | "directory" | null;
};

function collisionPathParts(path: string): string[] {
  const compatibilitySafePath = validateEntryPath(path.normalize("NFKC"));
  const withoutTrailingSlash = compatibilitySafePath.endsWith("/")
    ? compatibilitySafePath.slice(0, -1)
    : compatibilitySafePath;
  return withoutTrailingSlash.normalize("NFKC").toLowerCase().split("/");
}

function addPathToTrie(root: PathTrieNode, path: string): void {
  const isDirectory = path.endsWith("/");
  const parts = collisionPathParts(path);
  let node = root;
  for (const part of parts) {
    if (node.kind === "file") {
      throw new SafeArchiveError("entry_path_collision");
    }
    const child = node.children.get(part) ?? {
      children: new Map<string, PathTrieNode>(),
      kind: null,
    };
    node.children.set(part, child);
    node = child;
  }
  if (node.kind !== null) {
    throw new SafeArchiveError("entry_path_collision");
  }
  if (!isDirectory && node.children.size > 0) {
    throw new SafeArchiveError("entry_path_collision");
  }
  node.kind = isDirectory ? "directory" : "file";
}

function isNestedArchiveName(name: string): boolean {
  return /\.(?:zip|zipx|7z|rar|tar|tgz|gz|bz2|xz)$/iu.test(name);
}

function inspectUnixFileType(
  versionMadeBy: number,
  externalAttributes: number,
  pathIsDirectory: boolean,
): void {
  const host = versionMadeBy >>> 8;
  if (host !== 3) return;
  const mode = externalAttributes >>> 16;
  const type = mode & 0o170000;
  if (type === 0) return;
  if (type === 0o100000 && !pathIsDirectory) return;
  if (type === 0o040000 && pathIsDirectory) return;
  if (type === 0o120000) {
    throw new SafeArchiveError("entry_symlink_rejected");
  }
  if (type === 0o100000 || type === 0o040000) {
    throw new SafeArchiveError("entry_type_path_mismatch");
  }
  throw new SafeArchiveError("entry_special_file_rejected");
}

async function inspectArchive(
  handle: FileHandle,
  archiveBytes: number,
  onDeclaredEntryCount: (entryCount: number) => void,
): Promise<InspectedArchive> {
  if (archiveBytes < ZIP_EOCD_MIN_BYTES) {
    throw new SafeArchiveError("archive_not_zip");
  }
  const tailBytes = Math.min(
    archiveBytes,
    ZIP_EOCD_MIN_BYTES + ZIP_MAX_COMMENT_BYTES,
  );
  const tail = await readExactly(handle, archiveBytes - tailBytes, tailBytes);
  let eocdInTail = -1;
  for (let offset = tail.length - ZIP_EOCD_MIN_BYTES; offset >= 0; offset--) {
    if (tail.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      continue;
    }
    const commentBytes = tail.readUInt16LE(offset + 20);
    if (offset + ZIP_EOCD_MIN_BYTES + commentBytes === tail.length) {
      eocdInTail = offset;
      break;
    }
  }
  if (eocdInTail < 0) throw new SafeArchiveError("archive_not_zip");

  const eocdOffset = archiveBytes - tailBytes + eocdInTail;
  const diskNumber = tail.readUInt16LE(eocdInTail + 4);
  const centralDisk = tail.readUInt16LE(eocdInTail + 6);
  const entriesOnDisk = tail.readUInt16LE(eocdInTail + 8);
  const entryCount = tail.readUInt16LE(eocdInTail + 10);
  const centralDirectoryBytes = tail.readUInt32LE(eocdInTail + 12);
  const centralDirectoryOffset = tail.readUInt32LE(eocdInTail + 16);

  if (
    entryCount === 0xffff ||
    entriesOnDisk === 0xffff ||
    centralDirectoryBytes === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new SafeArchiveError("archive_zip64_rejected");
  }
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new SafeArchiveError("archive_multidisk_rejected");
  }
  // Enforce the manifest-wide budget at the EOCD boundary, before allocating
  // or iterating over the central directory.
  onDeclaredEntryCount(entryCount);
  if (entryCount > MIGRATION_ARCHIVE_LIMITS.entries) {
    throw new SafeArchiveError("too_many_entries");
  }
  if (centralDirectoryBytes > MIGRATION_ARCHIVE_LIMITS.centralDirectoryBytes) {
    throw new SafeArchiveError("central_directory_too_large");
  }
  if (centralDirectoryOffset + centralDirectoryBytes !== eocdOffset) {
    throw new SafeArchiveError("central_directory_invalid");
  }

  const firstSignature = (await readExactly(handle, 0, 4)).readUInt32LE(0);
  if (
    (entryCount > 0 && firstSignature !== LOCAL_FILE_HEADER_SIGNATURE) ||
    (entryCount === 0 && firstSignature !== END_OF_CENTRAL_DIRECTORY_SIGNATURE)
  ) {
    throw new SafeArchiveError("archive_sfx_rejected");
  }

  const central = await readExactly(
    handle,
    centralDirectoryOffset,
    centralDirectoryBytes,
  );
  const entries: CentralDirectoryEntry[] = [];
  const pathTrie: PathTrieNode = { children: new Map(), kind: null };
  let offset = 0;
  let directoryEntryCount = 0;
  let unsupportedEntryCount = 0;
  let advertisedCompressedBytes = 0;
  let advertisedUncompressedBytes = 0;

  for (let index = 0; index < entryCount; index++) {
    if (
      offset + 46 > central.length ||
      central.readUInt32LE(offset) !== CENTRAL_FILE_HEADER_SIGNATURE
    ) {
      throw new SafeArchiveError("central_directory_invalid");
    }
    const versionMadeBy = central.readUInt16LE(offset + 4);
    const generalPurposeFlags = central.readUInt16LE(offset + 8);
    const compressionMethod = central.readUInt16LE(offset + 10);
    const expectedCrc32 = central.readUInt32LE(offset + 16);
    const compressedBytes = central.readUInt32LE(offset + 20);
    const uncompressedBytes = central.readUInt32LE(offset + 24);
    const nameLength = central.readUInt16LE(offset + 28);
    const extraLength = central.readUInt16LE(offset + 30);
    const commentLength = central.readUInt16LE(offset + 32);
    const diskStart = central.readUInt16LE(offset + 34);
    const externalAttributes = central.readUInt32LE(offset + 38);
    const localHeaderOffset = central.readUInt32LE(offset + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (offset + recordLength > central.length) {
      throw new SafeArchiveError("central_directory_invalid");
    }
    if (
      compressedBytes === 0xffffffff ||
      uncompressedBytes === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      diskStart === 0xffff
    ) {
      throw new SafeArchiveError("entry_zip64_rejected");
    }
    if (diskStart !== 0) {
      throw new SafeArchiveError("archive_multidisk_rejected");
    }
    if (
      (generalPurposeFlags & 0x1) !== 0 ||
      (generalPurposeFlags & 0x40) !== 0
    ) {
      throw new SafeArchiveError("entry_encrypted_rejected");
    }
    if ((generalPurposeFlags & 0x8) !== 0) {
      throw new SafeArchiveError("entry_data_descriptor_rejected");
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new SafeArchiveError("entry_compression_unsupported");
    }
    const allowedFlags = 0x800 | (compressionMethod === 8 ? 0x6 : 0);
    if ((generalPurposeFlags & (0xffff ^ allowedFlags)) !== 0) {
      throw new SafeArchiveError("entry_flags_unsupported");
    }
    const nameBytes = central.subarray(offset + 46, offset + 46 + nameLength);
    const extra = central.subarray(
      offset + 46 + nameLength,
      offset + 46 + nameLength + extraLength,
    );
    if (hasExtraField(extra, ZIP64_EXTRA_FIELD_ID)) {
      throw new SafeArchiveError("entry_zip64_rejected");
    }
    if (hasExtraField(extra, UNICODE_PATH_EXTRA_FIELD_ID)) {
      throw new SafeArchiveError("entry_unicode_path_override_rejected");
    }
    if (hasExtraField(extra, AES_EXTRA_FIELD_ID)) {
      throw new SafeArchiveError("entry_encrypted_rejected");
    }
    const name = decodeEntryName(
      nameBytes,
      (generalPurposeFlags & 0x800) !== 0,
    );
    const safeName = validateEntryPath(name);
    const pathIsDirectory = safeName.endsWith("/");
    inspectUnixFileType(versionMadeBy, externalAttributes, pathIsDirectory);
    addPathToTrie(pathTrie, safeName);
    if (isNestedArchiveName(safeName)) {
      throw new SafeArchiveError("nested_archive_rejected");
    }

    if (
      pathIsDirectory &&
      (compressionMethod !== 0 ||
        compressedBytes !== 0 ||
        uncompressedBytes !== 0 ||
        expectedCrc32 !== 0)
    ) {
      throw new SafeArchiveError("directory_payload_rejected");
    }
    if (compressionMethod === 0 && compressedBytes !== uncompressedBytes) {
      throw new SafeArchiveError("entry_local_header_mismatch");
    }
    advertisedCompressedBytes += compressedBytes;
    advertisedUncompressedBytes += uncompressedBytes;
    if (
      !Number.isSafeInteger(advertisedCompressedBytes) ||
      !Number.isSafeInteger(advertisedUncompressedBytes)
    ) {
      throw new SafeArchiveError("advertised_output_too_large");
    }
    if (
      advertisedUncompressedBytes >
      MIGRATION_ARCHIVE_LIMITS.advertisedUncompressedBytes
    ) {
      throw new SafeArchiveError("advertised_output_too_large");
    }
    const isCsv = !pathIsDirectory && safeName.toLowerCase().endsWith(".csv");
    if (pathIsDirectory) directoryEntryCount++;
    else if (!isCsv) unsupportedEntryCount++;
    entries.push({
      nameBytes: Buffer.from(nameBytes),
      localHeaderOffset,
      dataOffset: 0,
      spanEnd: 0,
      generalPurposeFlags,
      compressionMethod,
      crc32: expectedCrc32,
      compressedBytes,
      uncompressedBytes,
      isDirectory: pathIsDirectory,
      isCsv,
    });
    offset += recordLength;
  }
  if (offset !== central.length) {
    throw new SafeArchiveError("central_directory_invalid");
  }

  for (const entry of entries) {
    // Data descriptors were rejected while reading the central record. Local
    // sizes are therefore authoritative enough to compare byte-for-byte.
    if (
      entry.localHeaderOffset < 0 ||
      entry.localHeaderOffset + 30 > centralDirectoryOffset
    ) {
      throw new SafeArchiveError("entry_span_invalid");
    }
    const localHeader = await readExactly(handle, entry.localHeaderOffset, 30);
    if (localHeader.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw new SafeArchiveError("entry_local_header_mismatch");
    }
    const localFlags = localHeader.readUInt16LE(6);
    const localCompression = localHeader.readUInt16LE(8);
    const localCrc32 = localHeader.readUInt32LE(14);
    const localCompressedBytes = localHeader.readUInt32LE(18);
    const localUncompressedBytes = localHeader.readUInt32LE(22);
    const localNameLength = localHeader.readUInt16LE(26);
    const localExtraLength = localHeader.readUInt16LE(28);
    const dataOffset =
      entry.localHeaderOffset + 30 + localNameLength + localExtraLength;
    const spanEnd = dataOffset + entry.compressedBytes;
    if (
      !Number.isSafeInteger(dataOffset) ||
      !Number.isSafeInteger(spanEnd) ||
      dataOffset > centralDirectoryOffset ||
      spanEnd > centralDirectoryOffset ||
      spanEnd < dataOffset
    ) {
      throw new SafeArchiveError("entry_span_invalid");
    }
    const localName = await readExactly(
      handle,
      entry.localHeaderOffset + 30,
      localNameLength,
    );
    const localExtra = await readExactly(
      handle,
      entry.localHeaderOffset + 30 + localNameLength,
      localExtraLength,
    );
    if (
      localFlags !== entry.generalPurposeFlags ||
      localCompression !== entry.compressionMethod ||
      localCrc32 !== entry.crc32 ||
      localCompressedBytes !== entry.compressedBytes ||
      localUncompressedBytes !== entry.uncompressedBytes ||
      !localName.equals(entry.nameBytes)
    ) {
      throw new SafeArchiveError("entry_local_header_mismatch");
    }
    if (hasExtraField(localExtra, ZIP64_EXTRA_FIELD_ID)) {
      throw new SafeArchiveError("entry_zip64_rejected");
    }
    if (hasExtraField(localExtra, UNICODE_PATH_EXTRA_FIELD_ID)) {
      throw new SafeArchiveError("entry_unicode_path_override_rejected");
    }
    if (hasExtraField(localExtra, AES_EXTRA_FIELD_ID)) {
      throw new SafeArchiveError("entry_encrypted_rejected");
    }
    entry.dataOffset = dataOffset;
    entry.spanEnd = spanEnd;
  }
  const spans = [...entries].sort(
    (left, right) => left.localHeaderOffset - right.localHeaderOffset,
  );
  let claimedThrough = 0;
  for (const entry of spans) {
    if (entry.localHeaderOffset !== claimedThrough) {
      throw new SafeArchiveError("entry_span_gap");
    }
    claimedThrough = entry.spanEnd;
  }
  if (claimedThrough !== centralDirectoryOffset) {
    throw new SafeArchiveError("entry_span_gap");
  }
  return {
    centralDirectoryOffset,
    entries,
    directoryEntryCount,
    unsupportedEntryCount,
    advertisedCompressedBytes,
    advertisedUncompressedBytes,
  };
}

let crcTable: Uint32Array | undefined;

function crc32(buffer: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
      let value = index;
      for (let bit = 0; bit < 8; bit++) {
        value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[index] = value >>> 0;
    }
  }
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function categorizeCsvError(error: string): SafeCsvErrorCategory {
  const normalized = error.toLowerCase();
  if (
    normalized.includes("unterminated quoted") ||
    normalized === "unterminated_quote"
  ) {
    return "unterminated_quote";
  }
  if (normalized.includes("duplicate columns")) return "duplicate_header";
  if (normalized.includes("header column")) return "invalid_header";
  if (normalized.includes("columns; expected")) return "extra_columns";
  if (normalized.includes("missing a recognized")) return "missing_column";
  if (
    normalized.includes("csv is empty") ||
    normalized.includes("no data rows")
  ) {
    return "empty_csv";
  }
  if (
    normalized.includes("owner reference") ||
    normalized.includes("patient id or owner") ||
    normalized.includes("external client id is required")
  ) {
    return "missing_identity";
  }
  if (normalized.includes("email is not a valid")) return "invalid_email";
  if (normalized.includes("external id is too long")) {
    return "external_id_too_long";
  }
  if (
    normalized.includes("name is required") ||
    normalized.includes("firstname and lastname")
  ) {
    return "missing_name";
  }
  if (normalized.includes("species must be")) return "invalid_species";
  if (
    normalized.includes("must be a date") ||
    normalized.includes("read as a date")
  ) {
    return "invalid_date";
  }
  if (normalized.includes("needs at least one note")) return "missing_content";
  if (normalized.includes("too long")) return "field_too_long";
  return "other";
}

function errorCategoryCounts(
  errors: readonly string[],
): Partial<Record<SafeCsvErrorCategory, number>> {
  const counts: Partial<Record<SafeCsvErrorCategory, number>> = {};
  for (const error of errors) {
    const category = categorizeCsvError(error);
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return counts;
}

function preflightOnlyFailure(errors: readonly string[]): boolean {
  return errors.some((error) => {
    const normalized = error.toLowerCase();
    return (
      normalized.startsWith("csv is missing") ||
      normalized.startsWith("csv is empty") ||
      normalized.includes("no data rows")
    );
  });
}

export function scanBoundedCsvStructure(text: string): {
  logicalRecords: number;
  maximumColumns: number;
  totalCells: number;
  unterminatedQuote: boolean;
  exceedsLimits: boolean;
} {
  let completedCells = 0;
  let currentColumns = 1;
  let logicalRecords = 0;
  let maximumColumns = 1;
  let inQuotes = false;
  let currentRecordHasInput = false;

  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    currentRecordHasInput = true;
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          index++;
        } else {
          inQuotes = false;
        }
      }
      continue;
    }
    if (character === '"') {
      inQuotes = true;
      continue;
    }
    if (character === ",") {
      currentColumns++;
      maximumColumns = Math.max(maximumColumns, currentColumns);
      if (
        currentColumns > MIGRATION_ARCHIVE_LIMITS.csvColumnsPerRecord ||
        completedCells + currentColumns > MIGRATION_ARCHIVE_LIMITS.csvTotalCells
      ) {
        return {
          logicalRecords,
          maximumColumns,
          totalCells: completedCells + currentColumns,
          unterminatedQuote: false,
          exceedsLimits: true,
        };
      }
      continue;
    }
    if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index++;
      logicalRecords++;
      completedCells += currentColumns;
      if (
        logicalRecords > MIGRATION_ARCHIVE_LIMITS.csvLogicalRecords ||
        completedCells > MIGRATION_ARCHIVE_LIMITS.csvTotalCells
      ) {
        return {
          logicalRecords,
          maximumColumns,
          totalCells: completedCells,
          unterminatedQuote: false,
          exceedsLimits: true,
        };
      }
      currentColumns = 1;
      currentRecordHasInput = false;
    }
  }
  if (inQuotes) {
    return {
      logicalRecords,
      maximumColumns,
      totalCells: completedCells,
      unterminatedQuote: true,
      exceedsLimits: false,
    };
  }
  if (currentRecordHasInput) {
    logicalRecords++;
    completedCells += currentColumns;
  }
  return {
    logicalRecords,
    maximumColumns,
    totalCells: completedCells,
    unterminatedQuote: false,
    exceedsLimits:
      logicalRecords > MIGRATION_ARCHIVE_LIMITS.csvLogicalRecords ||
      completedCells > MIGRATION_ARCHIVE_LIMITS.csvTotalCells,
  };
}

function classifyCsv(text: string): {
  sourceRows: number | null;
  validRows: number;
  errors: string[];
  modeCandidates: MigrationImportMode[];
  inferredMode: MigrationImportMode | null;
  blockerCodes: ArchiveBlockerCode[];
} {
  const structuralScan = scanBoundedCsvStructure(text);
  if (structuralScan.exceedsLimits) {
    return {
      sourceRows: null,
      validRows: 0,
      errors: [],
      modeCandidates: [],
      inferredMode: null,
      blockerCodes: ["candidate_csv_structure_limit_exceeded"],
    };
  }
  if (structuralScan.unterminatedQuote) {
    return {
      sourceRows: null,
      validRows: 0,
      errors: ["unterminated_quote"],
      modeCandidates: [],
      inferredMode: null,
      blockerCodes: ["candidate_csv_invalid"],
    };
  }
  const parsed = parseCsv(text);
  if (parsed.errors.length > 0) {
    return {
      sourceRows: null,
      validRows: 0,
      errors: parsed.errors,
      modeCandidates: [],
      inferredMode: null,
      blockerCodes: ["candidate_csv_invalid"],
    };
  }
  if (parsed.rows.length > IMPORT_MAX_ROWS) {
    return {
      sourceRows: parsed.rows.length,
      validRows: 0,
      errors: [],
      modeCandidates: [],
      inferredMode: null,
      blockerCodes: ["candidate_row_limit_exceeded"],
    };
  }
  const attempts = [
    { mode: "clients" as const, result: csvToClientRecords(text) },
    { mode: "patients" as const, result: csvToPatientRecords(text) },
    { mode: "vaccinations" as const, result: csvToVaccinationRecords(text) },
    { mode: "soapNotes" as const, result: csvToSoapNoteRecords(text) },
  ];
  const matches = attempts.filter(
    ({ result }) => !preflightOnlyFailure(result.errors),
  );
  if (matches.length === 0) {
    return {
      sourceRows: parsed.rows.length,
      validRows: 0,
      errors: [],
      modeCandidates: [],
      inferredMode: null,
      blockerCodes: ["candidate_schema_unrecognized"],
    };
  }
  if (matches.length > 1) {
    return {
      sourceRows: parsed.rows.length,
      validRows: 0,
      errors: [],
      modeCandidates: matches.map(({ mode }) => mode),
      inferredMode: null,
      blockerCodes: ["candidate_schema_ambiguous"],
    };
  }
  const match = matches[0]!;
  return {
    sourceRows: parsed.rows.length,
    validRows: match.result.records.length,
    errors: match.result.errors,
    modeCandidates: [match.mode],
    inferredMode: match.mode,
    blockerCodes: [],
  };
}

async function inspectCsvCandidate(
  handle: FileHandle,
  centralDirectoryOffset: number,
  entry: CentralDirectoryEntry,
  opaqueId: string,
): Promise<ArchiveCandidateEvidence> {
  const base: ArchiveCandidateEvidence = {
    opaqueId,
    compressedBytes: entry.compressedBytes,
    uncompressedBytes: entry.uncompressedBytes,
    contentSha256: null,
    crcVerified: false,
    utf8Valid: false,
    sourceRows: null,
    validRows: 0,
    errorCount: 0,
    errorCategories: {},
    modeCandidates: [],
    inferredMode: null,
    status: "blocked",
    blockerCodes: [],
    duplicateContent: false,
  };
  try {
    if (
      entry.compressedBytes > MIGRATION_ARCHIVE_LIMITS.candidateCompressedBytes
    ) {
      throw new SafeArchiveError("candidate_compressed_too_large");
    }
    if (entry.uncompressedBytes > IMPORT_CSV_MAX_BYTES) {
      throw new SafeArchiveError("candidate_output_too_large");
    }
    if (
      candidateCompressionRatioExceedsLimit(
        entry.compressedBytes,
        entry.uncompressedBytes,
      )
    ) {
      throw new SafeArchiveError("candidate_ratio_too_large");
    }

    if (
      entry.dataOffset >= centralDirectoryOffset ||
      entry.spanEnd > centralDirectoryOffset
    ) {
      throw new SafeArchiveError("candidate_data_out_of_bounds");
    }
    const compressed = await readExactly(
      handle,
      entry.dataOffset,
      entry.compressedBytes,
    );
    let output: Buffer;
    if (entry.compressionMethod === 0) {
      output = compressed;
    } else {
      try {
        // Node returns this documented shape for `info: true`, but the current
        // @types/node sync overload still declares Buffer for every option.
        const inflated = inflateRawSync(compressed, {
          maxOutputLength: IMPORT_CSV_MAX_BYTES + 1,
          info: true,
        }) as unknown as {
          buffer: Buffer;
          engine: { bytesWritten: number };
        };
        if (inflated.engine.bytesWritten !== compressed.length) {
          throw new SafeArchiveError("candidate_trailing_data_rejected");
        }
        output = inflated.buffer;
      } catch (error) {
        if (error instanceof SafeArchiveError) throw error;
        const code = (error as { code?: string } | null)?.code;
        if (code === "ERR_BUFFER_TOO_LARGE") {
          throw new SafeArchiveError("candidate_output_too_large");
        }
        throw new SafeArchiveError("candidate_decompression_failed");
      }
    }
    if (output.length > IMPORT_CSV_MAX_BYTES) {
      throw new SafeArchiveError("candidate_output_too_large");
    }
    if (output.length !== entry.uncompressedBytes) {
      throw new SafeArchiveError("candidate_size_mismatch");
    }
    if (
      candidateCompressionRatioExceedsLimit(compressed.length, output.length)
    ) {
      throw new SafeArchiveError("candidate_ratio_too_large");
    }
    if (crc32(output) !== entry.crc32) {
      throw new SafeArchiveError("candidate_crc_mismatch");
    }
    base.crcVerified = true;
    base.contentSha256 = createHash("sha256").update(output).digest("hex");
    if (
      output.length >= 4 &&
      output.readUInt32LE(0) === LOCAL_FILE_HEADER_SIGNATURE
    ) {
      throw new SafeArchiveError("nested_archive_rejected");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(output);
    } catch {
      throw new SafeArchiveError("candidate_utf8_invalid");
    }
    base.utf8Valid = true;
    const classification = classifyCsv(text);
    base.sourceRows = classification.sourceRows;
    base.validRows = classification.validRows;
    base.errorCount = classification.errors.length;
    base.errorCategories = errorCategoryCounts(classification.errors);
    base.modeCandidates = classification.modeCandidates;
    base.inferredMode = classification.inferredMode;
    base.blockerCodes = classification.blockerCodes;
    base.status =
      classification.blockerCodes.length > 0
        ? "blocked"
        : classification.errors.length > 0
          ? "review_required"
          : "valid";
    return base;
  } catch (error) {
    base.blockerCodes = [safeError(error).code];
    return base;
  }
}

async function processArchive(
  path: string,
  alias: string,
  consumedEntryCount: number,
  aggregateEntryLimit: number,
  remainingCandidateBudget: number,
  testHooks?: MigrationArchivePreflightTestHooks,
): Promise<ArchiveEvidence> {
  const evidence: ArchiveEvidence = {
    alias,
    archiveSha256: null,
    archiveBytes: null,
    entryCount: 0,
    directoryEntryCount: 0,
    csvCandidateCount: 0,
    unsupportedEntryCount: 0,
    advertisedCompressedBytes: 0,
    advertisedUncompressedBytes: 0,
    status: "blocked",
    blockerCodes: [],
    candidates: [],
  };
  let handle: FileHandle | undefined;
  try {
    try {
      handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if ((error as { code?: string } | null)?.code === "ELOOP") {
        throw new SafeArchiveError("input_symlink_rejected");
      }
      throw new SafeArchiveError("input_read_failed");
    }
    const pathStat = await handle.stat();
    if (!pathStat.isFile()) {
      throw new SafeArchiveError("input_not_regular_file");
    }
    if (typeof process.getuid !== "function") {
      throw new SafeArchiveError("input_owner_check_unavailable");
    }
    if (pathStat.uid !== process.getuid()) {
      throw new SafeArchiveError("input_owner_mismatch");
    }
    if ((pathStat.mode & 0o077) !== 0) {
      throw new SafeArchiveError("input_permissions_too_open");
    }
    evidence.archiveBytes = pathStat.size;
    if (pathStat.size > MIGRATION_ARCHIVE_LIMITS.archiveBytes) {
      throw new SafeArchiveError("archive_too_large");
    }
    const initialHash = await sha256FileHandle(handle, pathStat.size);
    evidence.archiveSha256 = initialHash;
    await testHooks?.afterArchiveInitialHash?.({ alias });
    const inspected = await inspectArchive(
      handle,
      pathStat.size,
      (declaredEntryCount) => {
        // A blocked overflow declaration remains visible and is consumed by
        // the outer manifest loop, keeping exhaustion monotonic.
        evidence.entryCount = declaredEntryCount;
        if (
          aggregateArchiveEntryBudgetExceeded(
            consumedEntryCount,
            declaredEntryCount,
            aggregateEntryLimit,
          )
        ) {
          throw new SafeArchiveError("aggregate_entry_limit_exceeded");
        }
      },
    );
    evidence.entryCount = inspected.entries.length;
    evidence.directoryEntryCount = inspected.directoryEntryCount;
    evidence.unsupportedEntryCount = inspected.unsupportedEntryCount;
    evidence.advertisedCompressedBytes = inspected.advertisedCompressedBytes;
    evidence.advertisedUncompressedBytes =
      inspected.advertisedUncompressedBytes;
    const candidates = inspected.entries.filter((entry) => entry.isCsv);
    if (
      candidates.length > MIGRATION_ARCHIVE_LIMITS.csvCandidatesPerArchive ||
      candidates.length > remainingCandidateBudget
    ) {
      throw new SafeArchiveError("csv_candidate_limit_exceeded");
    }
    evidence.csvCandidateCount = candidates.length;
    for (let index = 0; index < candidates.length; index++) {
      evidence.candidates.push(
        await inspectCsvCandidate(
          handle,
          inspected.centralDirectoryOffset,
          candidates[index]!,
          `${alias}-entry-${String(index + 1).padStart(6, "0")}`,
        ),
      );
    }
    const finalHash = await sha256FileHandle(handle, pathStat.size);
    const finalStat = await handle.stat();
    if (
      finalHash !== initialHash ||
      finalStat.size !== pathStat.size ||
      finalStat.mtimeMs !== pathStat.mtimeMs ||
      finalStat.ctimeMs !== pathStat.ctimeMs
    ) {
      throw new SafeArchiveError("input_changed_during_read");
    }
    const candidateBlocked = evidence.candidates.flatMap(
      (candidate) => candidate.blockerCodes,
    );
    evidence.blockerCodes = [...new Set(candidateBlocked)].sort();
    evidence.status =
      evidence.blockerCodes.length > 0
        ? "blocked"
        : evidence.candidates.some(
              (candidate) => candidate.status === "review_required",
            )
          ? "review_required"
          : "safe";
    return evidence;
  } catch (error) {
    evidence.blockerCodes = [safeError(error).code];
    evidence.status = "blocked";
    evidence.candidates = [];
    evidence.csvCandidateCount = 0;
    return evidence;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function preflightMigrationArchives(
  archivePaths: readonly string[],
  now: Date = new Date(),
  testHooks?: MigrationArchivePreflightTestHooks,
): Promise<MigrationArchivePreflightEvidence> {
  const archives: ArchiveEvidence[] = [];
  let consumedEntries = 0;
  let consumedCandidates = 0;
  const aggregateEntryLimit =
    testHooks?.aggregateEntryLimitOverride ??
    MIGRATION_ARCHIVE_LIMITS.aggregateEntries;
  for (let index = 0; index < archivePaths.length; index++) {
    const archive = await processArchive(
      archivePaths[index]!,
      `archive-${String(index + 1).padStart(2, "0")}`,
      consumedEntries,
      aggregateEntryLimit,
      MIGRATION_ARCHIVE_LIMITS.aggregateCsvCandidates - consumedCandidates,
      testHooks,
    );
    archives.push(archive);
    consumedEntries += archive.entryCount;
    consumedCandidates += archive.csvCandidateCount;
  }
  const byContentHash = new Map<string, ArchiveCandidateEvidence[]>();
  for (const candidate of archives.flatMap((archive) => archive.candidates)) {
    if (!candidate.contentSha256) continue;
    const matches = byContentHash.get(candidate.contentSha256) ?? [];
    matches.push(candidate);
    byContentHash.set(candidate.contentSha256, matches);
  }
  let exactDuplicateCandidateCount = 0;
  for (const matches of byContentHash.values()) {
    if (matches.length < 2) continue;
    exactDuplicateCandidateCount += matches.length - 1;
    for (const match of matches) match.duplicateContent = true;
  }
  const allCandidates = archives.flatMap((archive) => archive.candidates);
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    tool: "openvpm_migration_archive_preflight",
    source: "shepherd",
    networkUsed: false,
    databaseUsed: false,
    archiveExtractionUsed: false,
    authoritativeImportClaim: false,
    limits: {
      ...MIGRATION_ARCHIVE_LIMITS,
      csvBytes: IMPORT_CSV_MAX_BYTES,
      csvRows: IMPORT_MAX_ROWS,
    },
    archives,
    exactDuplicateCandidateCount,
    safeToContinueOfflineReview: archives.every(
      (archive) => archive.status !== "blocked",
    ),
    readyForAuthoritativeCsvPreview:
      allCandidates.length > 0 &&
      archives.every((archive) => archive.status === "safe") &&
      allCandidates.every(
        (candidate) =>
          candidate.status === "valid" && !candidate.duplicateContent,
      ),
    requiresUnsupportedDataReview: archives.some(
      (archive) => archive.unsupportedEntryCount > 0,
    ),
  };
}

export async function writeMigrationArchiveEvidence(
  evidencePath: string,
  evidence: MigrationArchivePreflightEvidence,
): Promise<void> {
  const handle = await open(evidencePath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}
