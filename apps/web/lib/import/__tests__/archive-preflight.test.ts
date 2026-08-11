import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  MIGRATION_ARCHIVE_LIMITS,
  aggregateArchiveEntryBudgetExceeded,
  candidateCompressionRatioExceedsLimit,
  preflightMigrationArchives,
  scanBoundedCsvStructure,
  writeMigrationArchiveEvidence,
} from "../archive-preflight";
import {
  MIGRATION_ARCHIVE_MANIFEST_LIMITS,
  validatedMigrationArchiveCliPaths,
} from "../../../scripts/preflight-migration-archives";
import { IMPORT_CSV_MAX_BYTES, IMPORT_MAX_ROWS } from "../policy";

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

type SyntheticEntry = {
  name: string;
  data: Buffer | string;
  method?: 0 | 8 | 12;
  flags?: number;
  versionMadeBy?: number;
  externalAttributes?: number;
  crcOverride?: number;
  advertisedUncompressedBytes?: number;
  localHeaderOffsetOverride?: number;
  extra?: Buffer;
  gapBefore?: Buffer;
  compressedSuffix?: Buffer;
};

type SyntheticZipOptions = {
  prefix?: Buffer;
  diskNumber?: number;
  zip64Eocd?: boolean;
  truncateBytes?: number;
};

const directories: string[] = [];
const execFileAsync = promisify(execFile);

async function runPreflightCli(manifestPath: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  argv: string[];
}> {
  const executable = join(process.cwd(), "node_modules/.bin/tsx");
  const argv = [
    "scripts/preflight-migration-archives.ts",
    "--manifest",
    manifestPath,
  ];
  try {
    const result = await execFileAsync(executable, argv, {
      cwd: process.cwd(),
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr, argv };
  } catch (error) {
    const failure = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      argv,
    };
  }
}

async function privateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "openvpm-archive-test-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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

function makeZip(
  entries: readonly SyntheticEntry[],
  options: SyntheticZipOptions = {},
): Buffer {
  const prefix = options.prefix ?? Buffer.alloc(0);
  const localParts: Buffer[] = [prefix];
  const centralParts: Buffer[] = [];
  let localOffset = prefix.length;

  for (const entry of entries) {
    if (entry.gapBefore) {
      localParts.push(entry.gapBefore);
      localOffset += entry.gapBefore.length;
    }
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data, "utf8");
    const method = entry.method ?? 8;
    const compressedPayload = method === 8 ? deflateRawSync(raw) : raw;
    const compressed = entry.compressedSuffix
      ? Buffer.concat([compressedPayload, entry.compressedSuffix])
      : compressedPayload;
    const flags = (entry.flags ?? 0) | 0x800;
    const checksum = entry.crcOverride ?? crc32(raw);
    const advertisedUncompressedBytes =
      entry.advertisedUncompressedBytes ?? raw.length;
    const extra = entry.extra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum >>> 0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(advertisedUncompressedBytes, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    localParts.push(local, name, extra, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(entry.versionMadeBy ?? 0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum >>> 0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(advertisedUncompressedBytes, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(entry.externalAttributes ?? 0, 38);
    central.writeUInt32LE(entry.localHeaderOffsetOverride ?? localOffset, 42);
    centralParts.push(central, name, extra);
    localOffset +=
      local.length + name.length + extra.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(options.diskNumber ?? 0, 4);
  eocd.writeUInt16LE(options.diskNumber ?? 0, 6);
  eocd.writeUInt16LE(options.zip64Eocd ? 0xffff : entries.length, 8);
  eocd.writeUInt16LE(options.zip64Eocd ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  const complete = Buffer.concat([...localParts, centralDirectory, eocd]);
  return options.truncateBytes
    ? complete.subarray(0, complete.length - options.truncateBytes)
    : complete;
}

function patchEocd(
  archive: Buffer,
  patch: (copy: Buffer, eocdOffset: number) => void,
): Buffer {
  const copy = Buffer.from(archive);
  const eocdOffset = copy.length - 22;
  expect(copy.readUInt32LE(eocdOffset)).toBe(EOCD_SIGNATURE);
  patch(copy, eocdOffset);
  return copy;
}

async function archiveWith(
  entries: readonly SyntheticEntry[],
  options?: SyntheticZipOptions,
): Promise<string> {
  const directory = await privateDirectory();
  const path = join(directory, "archive.zip");
  await writeFile(path, makeZip(entries, options));
  await chmod(path, 0o600);
  return path;
}

async function privateManifest(
  directory: string,
  archives: readonly string[],
  evidence = join(directory, "evidence.json"),
): Promise<string> {
  const manifestPath = join(directory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({ archives, evidence }));
  await chmod(manifestPath, 0o600);
  return manifestPath;
}

function validClientCsv(id = "synthetic-1"): string {
  return `firstName,lastName,clientId\nSynthetic,Owner,${id}\n`;
}

function firstArchiveBlocker(
  evidence: Awaited<ReturnType<typeof preflightMigrationArchives>>,
): string | undefined {
  return evidence.archives[0]?.blockerCodes[0];
}

describe("migration archive preflight", () => {
  it("classifies a safe client CSV without exposing its entry name or values", async () => {
    const privateCanary = "PRIVATE-CANARY-NEVER-EMIT";
    const archive = await archiveWith([
      {
        name: `${privateCanary}.csv`,
        data: validClientCsv(privateCanary),
      },
      { name: "opaque-document.pdf", data: "%PDF synthetic" },
    ]);

    const evidence = await preflightMigrationArchives(
      [archive],
      new Date("2026-08-11T12:00:00.000Z"),
    );
    expect(evidence).toMatchObject({
      networkUsed: false,
      databaseUsed: false,
      archiveExtractionUsed: false,
      authoritativeImportClaim: false,
      safeToContinueOfflineReview: true,
      readyForAuthoritativeCsvPreview: true,
      requiresUnsupportedDataReview: true,
      archives: [
        {
          alias: "archive-01",
          status: "safe",
          entryCount: 2,
          csvCandidateCount: 1,
          unsupportedEntryCount: 1,
          candidates: [
            {
              opaqueId: "archive-01-entry-000001",
              inferredMode: "clients",
              sourceRows: 1,
              validRows: 1,
              status: "valid",
              crcVerified: true,
              utf8Valid: true,
            },
          ],
        },
      ],
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(privateCanary);
    expect(serialized).not.toContain(archive);
    expect(serialized).not.toContain("firstName");
  });

  it.each([
    ["../outside.csv", "entry_path_invalid"],
    ["/absolute.csv", "entry_path_invalid"],
    ["C:/windows.csv", "entry_path_invalid"],
    ["folder\\windows.csv", "entry_path_invalid"],
    ["folder//empty.csv", "entry_path_invalid"],
    ["nested/archive.zip", "nested_archive_rejected"],
  ])("rejects unsafe or nested entry paths", async (name, blocker) => {
    const archive = await archiveWith([{ name, data: validClientCsv() }]);
    const evidence = await preflightMigrationArchives([archive]);
    expect(firstArchiveBlocker(evidence)).toBe(blocker);
    expect(evidence.archives[0]?.candidates).toEqual([]);
  });

  it("rejects normalized case-insensitive entry collisions", async () => {
    const archive = await archiveWith([
      { name: "Folder/CLIENTS.csv", data: validClientCsv("one") },
      { name: "folder/clients.CSV", data: validClientCsv("two") },
    ]);
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([archive])),
    ).toBe("entry_path_collision");
  });

  it("rejects file-prefix and NFKC-introduced path collisions or traversal", async () => {
    const prefixCollision = await archiveWith([
      { name: "folder", data: "opaque", method: 0 },
      { name: "folder/clients.csv", data: validClientCsv(), method: 0 },
    ]);
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([prefixCollision])),
    ).toBe("entry_path_collision");

    const normalizedTraversal = await archiveWith([
      { name: "folder/\uFF0E/clients.csv", data: validClientCsv(), method: 0 },
    ]);
    expect(
      firstArchiveBlocker(
        await preflightMigrationArchives([normalizedTraversal]),
      ),
    ).toBe("entry_path_invalid");

    const normalizedSeparator = await archiveWith([
      {
        name: "folder\uFF0F..\uFF0Fclients.csv",
        data: validClientCsv(),
        method: 0,
      },
    ]);
    expect(
      firstArchiveBlocker(
        await preflightMigrationArchives([normalizedSeparator]),
      ),
    ).toBe("entry_path_invalid");
  });

  it.each([
    [0o120777, "entry_symlink_rejected"],
    [0o020666, "entry_special_file_rejected"],
  ])("rejects Unix symlink and special entries", async (mode, blocker) => {
    const archive = await archiveWith([
      {
        name: "unsafe.csv",
        data: validClientCsv(),
        externalAttributes: (mode << 16) >>> 0,
      },
    ]);
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([archive])),
    ).toBe(blocker);
  });

  it("rejects encrypted and unsupported-compression entries", async () => {
    const encrypted = await archiveWith([
      { name: "encrypted.csv", data: validClientCsv(), flags: 0x1 },
    ]);
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([encrypted])),
    ).toBe("entry_encrypted_rejected");

    const unsupported = await archiveWith([
      { name: "compressed.csv", data: validClientCsv(), method: 12 },
    ]);
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([unsupported])),
    ).toBe("entry_compression_unsupported");
  });

  it("rejects data descriptors and unsupported ZIP flags", async () => {
    const descriptor = await archiveWith([
      { name: "descriptor.csv", data: validClientCsv(), flags: 0x8 },
    ]);
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([descriptor])),
    ).toBe("entry_data_descriptor_rejected");

    const maskedHeader = await archiveWith([
      { name: "masked.csv", data: validClientCsv(), flags: 0x2000 },
    ]);
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([maskedHeader])),
    ).toBe("entry_flags_unsupported");
  });

  it("requires Unix entry type/path agreement and canonical empty directories", async () => {
    const regularWithSlash = await archiveWith([
      {
        name: "regular/",
        data: "",
        method: 0,
        externalAttributes: (0o100644 << 16) >>> 0,
      },
    ]);
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([regularWithSlash])),
    ).toBe("entry_type_path_mismatch");

    const directoryWithoutSlash = await archiveWith([
      {
        name: "directory",
        data: "",
        method: 0,
        externalAttributes: (0o040755 << 16) >>> 0,
      },
    ]);
    expect(
      firstArchiveBlocker(
        await preflightMigrationArchives([directoryWithoutSlash]),
      ),
    ).toBe("entry_type_path_mismatch");

    const payloadDirectory = await archiveWith([
      { name: "payload/", data: "hidden", method: 0 },
    ]);
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([payloadDirectory])),
    ).toBe("directory_payload_rejected");

    const compressedDirectory = await archiveWith([
      { name: "compressed/", data: "" },
    ]);
    expect(
      firstArchiveBlocker(
        await preflightMigrationArchives([compressedDirectory]),
      ),
    ).toBe("directory_payload_rejected");

    const crcDirectory = await archiveWith([
      { name: "crc/", data: "", method: 0, crcOverride: 1 },
    ]);
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([crcDirectory])),
    ).toBe("directory_payload_rejected");
  });

  it.each([
    ["sfx", { prefix: Buffer.from("SFX!") }, "archive_sfx_rejected"],
    ["multidisk", { diskNumber: 1 }, "archive_multidisk_rejected"],
    ["zip64", { zip64Eocd: true }, "archive_zip64_rejected"],
  ] as const)("rejects %s containers", async (_label, options, blocker) => {
    const archive = await archiveWith(
      [{ name: "clients.csv", data: validClientCsv() }],
      options,
    );
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([archive])),
    ).toBe(blocker);
  });

  it("rejects a corrupt CRC without exposing raw CSV data", async () => {
    const privateCanary = "PRIVATE-CRC-CANARY";
    const archive = await archiveWith([
      {
        name: "clients.csv",
        data: validClientCsv(privateCanary),
        crcOverride: 0,
      },
    ]);
    const evidence = await preflightMigrationArchives([archive]);
    expect(firstArchiveBlocker(evidence)).toBe("candidate_crc_mismatch");
    expect(JSON.stringify(evidence)).not.toContain(privateCanary);
  });

  it("rejects trailing bytes after a valid deflate stream", async () => {
    const privateCanary = "PRIVATE-DEFLATE-TRAILER-CANARY";
    const archive = await archiveWith([
      {
        name: "clients.csv",
        data: validClientCsv(),
        compressedSuffix: Buffer.from(privateCanary),
      },
    ]);
    const evidence = await preflightMigrationArchives([archive]);
    expect(firstArchiveBlocker(evidence)).toBe(
      "candidate_trailing_data_rejected",
    );
    expect(JSON.stringify(evidence)).not.toContain(privateCanary);
  });

  it("rejects invalid UTF-8 after integrity validation", async () => {
    const archive = await archiveWith([
      { name: "clients.csv", data: Buffer.from([0xff, 0xfe, 0xfd]), method: 0 },
    ]);
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([archive])),
    ).toBe("candidate_utf8_invalid");
  });

  it("rejects advertised and actual-output compression bombs", async () => {
    const ratioBomb = await archiveWith([
      {
        name: "ratio.csv",
        data: Buffer.alloc(1_000_000, 0x61),
      },
    ]);
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([ratioBomb])),
    ).toBe("candidate_ratio_too_large");

    const actualOutputBomb = await archiveWith([
      {
        name: "output.csv",
        data: randomBytes(IMPORT_CSV_MAX_BYTES + 1),
        advertisedUncompressedBytes: 100,
      },
    ]);
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([actualOutputBomb])),
    ).toBe("candidate_output_too_large");
  });

  it("accepts the exact byte cap and rejects one byte over", async () => {
    const prefix = Buffer.from("firstName,lastName,clientId,payload\nA,B,id,");
    const remainingBytes = IMPORT_CSV_MAX_BYTES - prefix.length;
    const exact = Buffer.concat([
      prefix,
      Buffer.from(
        randomBytes(Math.ceil(remainingBytes / 2))
          .toString("hex")
          .slice(0, remainingBytes),
        "ascii",
      ),
    ]);
    expect(exact.length).toBe(IMPORT_CSV_MAX_BYTES);
    const exactArchive = await archiveWith([
      { name: "exact.csv", data: exact, method: 0 },
    ]);
    const exactEvidence = await preflightMigrationArchives([exactArchive]);
    expect(firstArchiveBlocker(exactEvidence)).toBeUndefined();
    expect(exactEvidence.archives[0]?.candidates[0]).toMatchObject({
      inferredMode: "clients",
      validRows: 1,
    });

    const overArchive = await archiveWith([
      {
        name: "over.csv",
        data: Buffer.concat([exact, Buffer.from("x")]),
        method: 0,
      },
    ]);
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([overArchive])),
    ).toBe("candidate_output_too_large");
  });

  it("accepts the exact source-row cap and rejects one row over", async () => {
    const header = "firstName,lastName,clientId\n";
    const rows = Array.from(
      { length: IMPORT_MAX_ROWS },
      (_, index) => `A,B,synthetic-${index}\n`,
    ).join("");
    const exactArchive = await archiveWith([
      { name: "exact-rows.csv", data: `${header}${rows}`, method: 0 },
    ]);
    const exactEvidence = await preflightMigrationArchives([exactArchive]);
    expect(firstArchiveBlocker(exactEvidence)).toBeUndefined();
    expect(exactEvidence.archives[0]?.candidates[0]).toMatchObject({
      sourceRows: IMPORT_MAX_ROWS,
      validRows: IMPORT_MAX_ROWS,
    });

    const overArchive = await archiveWith([
      {
        name: "over-rows.csv",
        data: `${header}${rows}A,B,one-too-many\n`,
        method: 0,
      },
    ]);
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([overArchive])),
    ).toBe("candidate_csv_structure_limit_exceeded");
  });

  it("marks exact candidate content duplicated across archives", async () => {
    const content = validClientCsv();
    const first = await archiveWith([{ name: "first.csv", data: content }]);
    const second = await archiveWith([{ name: "second.csv", data: content }]);
    const evidence = await preflightMigrationArchives([first, second]);
    expect(evidence.exactDuplicateCandidateCount).toBe(1);
    expect(evidence.archives.flatMap((archive) => archive.candidates)).toEqual([
      expect.objectContaining({ duplicateContent: true }),
      expect.objectContaining({ duplicateContent: true }),
    ]);
    expect(evidence.readyForAuthoritativeCsvPreview).toBe(false);
  });

  it("redacts raw duplicate headers and invalid source values", async () => {
    const privateCanary = "PRIVATE-PARSER-CANARY";
    const archive = await archiveWith([
      {
        name: `${privateCanary}.csv`,
        data: `${privateCanary},${privateCanary}\n${privateCanary},${privateCanary}\n`,
      },
    ]);
    const evidence = await preflightMigrationArchives([archive]);
    expect(firstArchiveBlocker(evidence)).toBe("candidate_csv_invalid");
    expect(evidence.archives[0]?.candidates[0]?.errorCategories).toEqual({
      duplicate_header: 1,
    });
    expect(JSON.stringify(evidence)).not.toContain(privateCanary);
  });

  it("rejects a local header whose data offset enters the central directory", async () => {
    const base = makeZip([{ name: "clients.csv", data: validClientCsv() }]);
    const centralOffset = base.readUInt32LE(base.length - 6);
    const archive = await archiveWith([
      {
        name: "clients.csv",
        data: validClientCsv(),
        localHeaderOffsetOverride: centralOffset,
      },
    ]);
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([archive])),
    ).toBe("entry_span_invalid");
  });

  it("validates every local span and rejects hidden prefixes, gaps, and aliases", async () => {
    const unsupportedOffset = await archiveWith([
      {
        name: "opaque.bin",
        data: "opaque",
        method: 0,
        localHeaderOffsetOverride: 999_999,
      },
    ]);
    expect(
      firstArchiveBlocker(
        await preflightMigrationArchives([unsupportedOffset]),
      ),
    ).toBe("entry_span_invalid");

    const gap = await archiveWith([
      { name: "first.bin", data: "one", method: 0 },
      {
        name: "clients.csv",
        data: validClientCsv(),
        method: 0,
        gapBefore: Buffer.from("hidden-gap"),
      },
    ]);
    expect(firstArchiveBlocker(await preflightMigrationArchives([gap]))).toBe(
      "entry_span_gap",
    );

    const fakeHeaderPrefix = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("unclaimed-prefix"),
    ]);
    const prefixed = await archiveWith(
      [{ name: "clients.csv", data: validClientCsv(), method: 0 }],
      { prefix: fakeHeaderPrefix },
    );
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([prefixed])),
    ).toBe("entry_span_gap");

    const overlapping = await archiveWith([
      { name: "first.bin", data: "one", method: 0 },
      {
        name: "second.bin",
        data: "two",
        method: 0,
        localHeaderOffsetOverride: 0,
      },
    ]);
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([overlapping])),
    ).toBe("entry_local_header_mismatch");
  });

  it("bounds logical records, columns, and cells before the eager CSV parser", async () => {
    for (const bomb of [
      "\n".repeat(MIGRATION_ARCHIVE_LIMITS.csvLogicalRecords + 1),
      "\r".repeat(MIGRATION_ARCHIVE_LIMITS.csvLogicalRecords + 1),
      "\r\n".repeat(MIGRATION_ARCHIVE_LIMITS.csvLogicalRecords + 1),
      `${",".repeat(MIGRATION_ARCHIVE_LIMITS.csvColumnsPerRecord)}\n`,
      `${`${"x,".repeat(499)}x\n`.repeat(2_001)}`,
    ]) {
      const archive = await archiveWith([
        { name: "bounded.csv", data: bomb, method: 0 },
      ]);
      expect(
        firstArchiveBlocker(await preflightMigrationArchives([archive])),
      ).toBe("candidate_csv_structure_limit_exceeded");
    }

    const quotedNewline = await archiveWith([
      {
        name: "quoted.csv",
        data: 'firstName,lastName,clientId,payload\nA,B,synthetic,"line one\nline two"\n',
        method: 0,
      },
    ]);
    const quotedEvidence = await preflightMigrationArchives([quotedNewline]);
    expect(firstArchiveBlocker(quotedEvidence)).toBeUndefined();
    expect(quotedEvidence.archives[0]?.candidates[0]?.sourceRows).toBe(1);

    const scan = scanBoundedCsvStructure('a,b\n"one\nline",two\n');
    expect(scan).toMatchObject({
      logicalRecords: 2,
      maximumColumns: 2,
      unterminatedQuote: false,
      exceedsLimits: false,
    });
    expect(
      scanBoundedCsvStructure(
        `${"x,".repeat(MIGRATION_ARCHIVE_LIMITS.csvColumnsPerRecord - 1)}x\n`,
      ).exceedsLimits,
    ).toBe(false);
    expect(
      scanBoundedCsvStructure(
        `${"x,".repeat(MIGRATION_ARCHIVE_LIMITS.csvColumnsPerRecord)}x\n`,
      ).exceedsLimits,
    ).toBe(true);
    const fiveHundredCells = `${"x,".repeat(499)}x\n`;
    expect(
      scanBoundedCsvStructure(fiveHundredCells.repeat(2_000)).totalCells,
    ).toBe(MIGRATION_ARCHIVE_LIMITS.csvTotalCells);
    expect(
      scanBoundedCsvStructure(fiveHundredCells.repeat(2_000)).exceedsLimits,
    ).toBe(false);
    expect(
      scanBoundedCsvStructure(`${fiveHundredCells.repeat(2_000)}x\n`)
        .exceedsLimits,
    ).toBe(true);
    expect(
      scanBoundedCsvStructure(
        "\n".repeat(MIGRATION_ARCHIVE_LIMITS.csvLogicalRecords),
      ).exceedsLimits,
    ).toBe(false);

    const source = await readFile(
      join(process.cwd(), "lib/import/archive-preflight.ts"),
      "utf8",
    );
    expect(source.indexOf("scanBoundedCsvStructure(text)")).toBeLessThan(
      source.indexOf("parseCsv(text)"),
    );
  });

  it("categorizes unterminated quotes without retaining parser text", async () => {
    const archive = await archiveWith([
      { name: "quotes.csv", data: 'firstName,lastName\n"private', method: 0 },
    ]);
    const evidence = await preflightMigrationArchives([archive]);
    expect(firstArchiveBlocker(evidence)).toBe("candidate_csv_invalid");
    expect(evidence.archives[0]?.candidates[0]?.errorCategories).toEqual({
      unterminated_quote: 1,
    });
  });

  it("bounds candidate evidence per archive and across the manifest", async () => {
    const entries = (count: number, prefix: string): SyntheticEntry[] =>
      Array.from({ length: count }, (_, index) => ({
        name: `${prefix}-${index}.csv`,
        data: "",
        method: 0,
      }));
    const tooMany = await archiveWith([
      ...entries(MIGRATION_ARCHIVE_LIMITS.csvCandidatesPerArchive + 1, "one"),
    ]);
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([tooMany])),
    ).toBe("csv_candidate_limit_exceeded");

    const first = await archiveWith([
      ...entries(MIGRATION_ARCHIVE_LIMITS.csvCandidatesPerArchive, "first"),
    ]);
    const second = await archiveWith([
      ...entries(MIGRATION_ARCHIVE_LIMITS.csvCandidatesPerArchive, "second"),
    ]);
    const third = await archiveWith([
      { name: "last.csv", data: "", method: 0 },
    ]);
    const aggregate = await preflightMigrationArchives([first, second, third]);
    expect(aggregate.archives[2]?.blockerCodes).toEqual([
      "csv_candidate_limit_exceeded",
    ]);
    expect(
      aggregate.archives.reduce(
        (count, archive) => count + archive.candidates.length,
        0,
      ),
    ).toBe(MIGRATION_ARCHIVE_LIMITS.aggregateCsvCandidates);
  });

  it("keeps aggregate entry exhaustion monotonic after an overflow archive", async () => {
    const compactArchive = async (
      count: number,
      prefix: string,
    ): Promise<string> =>
      archiveWith(
        Array.from({ length: count }, (_, index) => ({
          name: `${prefix}-${index}.bin`,
          data: "x",
          method: 0 as const,
        })),
      );
    const archives = await Promise.all([
      compactArchive(5, "first"),
      compactArchive(4, "second"),
      compactArchive(2, "overflow"),
      compactArchive(1, "after-overflow"),
    ]);

    const evidence = await preflightMigrationArchives(
      archives,
      new Date("2026-08-11T12:00:00.000Z"),
      { aggregateEntryLimitOverride: 10 },
    );
    expect(evidence.archives.map((archive) => archive.entryCount)).toEqual([
      5, 4, 2, 1,
    ]);
    expect(
      evidence.archives.map((archive) => archive.unsupportedEntryCount),
    ).toEqual([5, 4, 0, 0]);
    expect(evidence.archives.map((archive) => archive.status)).toEqual([
      "safe",
      "safe",
      "blocked",
      "blocked",
    ]);
    expect(evidence.archives.map((archive) => archive.blockerCodes)).toEqual([
      [],
      [],
      ["aggregate_entry_limit_exceeded"],
      ["aggregate_entry_limit_exceeded"],
    ]);
    expect(evidence.safeToContinueOfflineReview).toBe(false);
  });

  it("keeps reading the opened archive inode when its path is replaced", async () => {
    const directory = await privateDirectory();
    const archive = join(directory, "archive.zip");
    const movedOriginal = join(directory, "opened-original.zip");
    const originalBytes = makeZip([
      { name: "clients.csv", data: validClientCsv("original") },
    ]);
    const replacementBytes = Buffer.from("replacement-path-is-not-a-zip");
    await writeFile(archive, originalBytes);
    await chmod(archive, 0o600);

    const evidence = await preflightMigrationArchives(
      [archive],
      new Date("2026-08-11T12:00:00.000Z"),
      {
        afterArchiveInitialHash: async () => {
          await rename(archive, movedOriginal);
          await writeFile(archive, replacementBytes);
          await chmod(archive, 0o600);
        },
      },
    );
    // Renaming the opened inode changes its ctime, so the conservative final
    // stability check blocks. The blocker and original hash prove the reader
    // stayed on the opened FD instead of parsing the invalid replacement path.
    expect(firstArchiveBlocker(evidence)).toBe("input_changed_during_read");
    expect(evidence.archives[0]?.archiveSha256).toBe(
      createHash("sha256").update(originalBytes).digest("hex"),
    );
  });

  it("detects a same-inode archive mutation after the initial hash", async () => {
    const directory = await privateDirectory();
    const archive = join(directory, "archive.zip");
    const mutatedBytes = makeZip([
      { name: "clients.csv", data: validClientCsv("mutated!"), method: 0 },
    ]);
    const stableOriginal = makeZip([
      { name: "clients.csv", data: validClientCsv("original"), method: 0 },
    ]);
    expect(mutatedBytes.length).toBe(stableOriginal.length);
    await writeFile(archive, stableOriginal);
    await chmod(archive, 0o600);
    const inodeBefore = (await stat(archive)).ino;

    const evidence = await preflightMigrationArchives([archive], new Date(), {
      afterArchiveInitialHash: async () => {
        await writeFile(archive, mutatedBytes);
        expect((await stat(archive)).ino).toBe(inodeBefore);
      },
    });
    expect(firstArchiveBlocker(evidence)).toBe("input_changed_during_read");
    expect(evidence.archives[0]?.archiveSha256).toBe(
      createHash("sha256").update(stableOriginal).digest("hex"),
    );
  });

  it("detects a manifest mutation after the first same-FD read", async () => {
    const directory = await privateDirectory();
    const firstArchive = join(directory, "first.zip");
    const otherArchive = join(directory, "other.zip");
    const evidencePath = join(directory, "evidence.json");
    await writeFile(firstArchive, makeZip([]));
    await writeFile(otherArchive, makeZip([]));
    await chmod(firstArchive, 0o600);
    await chmod(otherArchive, 0o600);
    const manifestPath = await privateManifest(
      directory,
      [firstArchive],
      evidencePath,
    );
    const replacement = JSON.stringify({
      archives: [otherArchive],
      evidence: evidencePath,
    });
    expect(replacement.length).toBe((await readFile(manifestPath)).length);

    await expect(
      validatedMigrationArchiveCliPaths(
        { manifestPath },
        {
          afterManifestFirstRead: async () => {
            await writeFile(manifestPath, replacement);
          },
        },
      ),
    ).rejects.toThrow("manifest_changed");
  });

  it("rejects a symlink input and opens the source once before stat/hash/read", async () => {
    const directory = await privateDirectory();
    const target = join(directory, "target.zip");
    const link = join(directory, "link.zip");
    await writeFile(
      target,
      makeZip([{ name: "clients.csv", data: validClientCsv() }]),
    );
    await chmod(target, 0o600);
    await symlink(target, link);
    const manifestPath = join(directory, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        archives: [link],
        evidence: join(directory, "evidence.json"),
      }),
    );
    await chmod(manifestPath, 0o600);
    const cliPaths = await validatedMigrationArchiveCliPaths({
      manifestPath,
    });
    expect(basename(cliPaths.archivePaths[0]!)).toBe("link.zip");
    expect(cliPaths.archivePaths[0]).not.toBe(await realpath(link));
    expect(
      firstArchiveBlocker(
        await preflightMigrationArchives(cliPaths.archivePaths),
      ),
    ).toBe("input_symlink_rejected");

    const source = await readFile(
      join(process.cwd(), "lib/import/archive-preflight.ts"),
      "utf8",
    );
    const openIndex = source.indexOf("handle = await open(");
    const statIndex = source.indexOf(
      "const pathStat = await handle.stat()",
      openIndex,
    );
    const hashIndex = source.indexOf("sha256FileHandle(handle", statIndex);
    const inspectIndex = source.indexOf(
      "const inspected = await inspectArchive(",
      hashIndex,
    );
    const finalHashIndex = source.indexOf(
      "sha256FileHandle(handle",
      hashIndex + 1,
    );
    expect(openIndex).toBeGreaterThan(0);
    expect(statIndex).toBeGreaterThan(openIndex);
    expect(hashIndex).toBeGreaterThan(statIndex);
    expect(inspectIndex).toBeGreaterThan(hashIndex);
    expect(finalHashIndex).toBeGreaterThan(inspectIndex);
    expect(source).not.toContain("createReadStream(path)");
    expect(source).not.toContain("lstat(path)");
  });

  it("writes exclusive aggregate evidence with mode 0600", async () => {
    const directory = await privateDirectory();
    const archive = join(directory, "archive.zip");
    const evidencePath = join(directory, "evidence.json");
    await writeFile(
      archive,
      makeZip([{ name: "clients.csv", data: validClientCsv() }]),
    );
    await chmod(archive, 0o600);
    const evidence = await preflightMigrationArchives([archive]);
    await writeMigrationArchiveEvidence(evidencePath, evidence);
    expect((await stat(evidencePath)).mode & 0o777).toBe(0o600);
    await expect(
      writeMigrationArchiveEvidence(evidencePath, evidence),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("rejects source archive permissions that are not owner-only", async () => {
    const archive = await archiveWith([
      { name: "clients.csv", data: validClientCsv() },
    ]);
    await chmod(archive, 0o644);
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([archive])),
    ).toBe("input_permissions_too_open");
  });

  it("validates a private exact-shape manifest and canonical duplicates", async () => {
    const directory = await privateDirectory();
    const archiveDirectory = join(directory, "archives");
    const archiveAlias = join(directory, "archive-alias");
    await mkdir(archiveDirectory, { mode: 0o700 });
    await chmod(archiveDirectory, 0o700);
    const archive = join(archiveDirectory, "archive.zip");
    await writeFile(
      archive,
      makeZip([{ name: "clients.csv", data: validClientCsv() }]),
    );
    await chmod(archive, 0o600);
    await symlink(archiveDirectory, archiveAlias);
    const manifestPath = await privateManifest(directory, [
      archive,
      join(archiveAlias, "archive.zip"),
    ]);
    await expect(
      validatedMigrationArchiveCliPaths({ manifestPath }),
    ).rejects.toThrow("manifest_duplicate_archives");

    await writeFile(
      manifestPath,
      JSON.stringify({
        archives: [archive],
        evidence: join(directory, "evidence.json"),
        unexpected: true,
      }),
    );
    await chmod(manifestPath, 0o600);
    await expect(
      validatedMigrationArchiveCliPaths({ manifestPath }),
    ).rejects.toThrow("manifest_invalid");

    await writeFile(manifestPath, Buffer.from([0xff]));
    await chmod(manifestPath, 0o600);
    await expect(
      validatedMigrationArchiveCliPaths({ manifestPath }),
    ).rejects.toThrow("manifest_invalid");

    await writeFile(manifestPath, Buffer.alloc(64_001, 0x78));
    await chmod(manifestPath, 0o600);
    await expect(
      validatedMigrationArchiveCliPaths({ manifestPath }),
    ).rejects.toThrow("manifest_size_invalid");
  });

  it("rejects symlink, open, and non-private-parent manifests", async () => {
    const directory = await privateDirectory();
    const archive = join(directory, "archive.zip");
    await writeFile(
      archive,
      makeZip([{ name: "clients.csv", data: validClientCsv() }]),
    );
    await chmod(archive, 0o600);
    const manifestPath = await privateManifest(directory, [archive]);

    await chmod(manifestPath, 0o644);
    await expect(
      validatedMigrationArchiveCliPaths({ manifestPath }),
    ).rejects.toThrow("manifest_permissions_invalid");
    await chmod(manifestPath, 0o600);

    const manifestLink = join(directory, "manifest-link.json");
    await symlink(manifestPath, manifestLink);
    await expect(
      validatedMigrationArchiveCliPaths({ manifestPath: manifestLink }),
    ).rejects.toThrow("manifest_symlink_rejected");

    await chmod(directory, 0o755);
    await expect(
      validatedMigrationArchiveCliPaths({ manifestPath }),
    ).rejects.toThrow("private_parent_required");
  });

  it("rejects direct and canonical-parent-symlink repository paths", async () => {
    await expect(
      validatedMigrationArchiveCliPaths({
        manifestPath: join(process.cwd(), "package.json"),
      }),
    ).rejects.toThrow("repository_paths_rejected");

    const directory = await privateDirectory();
    const repositoryAlias = join(directory, "repository-alias");
    await symlink(process.cwd(), repositoryAlias);
    await expect(
      validatedMigrationArchiveCliPaths({
        manifestPath: join(repositoryAlias, "package.json"),
      }),
    ).rejects.toThrow("repository_paths_rejected");

    const directReferenceManifest = await privateManifest(directory, [
      join(process.cwd(), "package.json"),
    ]);
    await expect(
      validatedMigrationArchiveCliPaths({
        manifestPath: directReferenceManifest,
      }),
    ).rejects.toThrow("repository_paths_rejected");

    await writeFile(
      directReferenceManifest,
      JSON.stringify({
        archives: [join(repositoryAlias, "package.json")],
        evidence: join(directory, "evidence.json"),
      }),
    );
    await chmod(directReferenceManifest, 0o600);
    await expect(
      validatedMigrationArchiveCliPaths({
        manifestPath: directReferenceManifest,
      }),
    ).rejects.toThrow("repository_paths_rejected");
  });

  it("keeps archive and evidence paths out of argv, output, and evidence", async () => {
    const directory = await privateDirectory();
    const archiveCanary = "PRIVATE-ARCHIVE-PATH-CANARY";
    const evidenceCanary = "PRIVATE-EVIDENCE-PATH-CANARY";
    const valueCanary = "PRIVATE-VALUE-CANARY";
    const archive = join(directory, `${archiveCanary}.zip`);
    const evidencePath = join(directory, `${evidenceCanary}.json`);
    await writeFile(
      archive,
      makeZip([
        {
          name: `${valueCanary}.csv`,
          data: validClientCsv(valueCanary),
        },
      ]),
    );
    await chmod(archive, 0o600);
    const manifestPath = await privateManifest(
      directory,
      [archive],
      evidencePath,
    );
    const result = await runPreflightCli(manifestPath);
    expect(JSON.stringify(result.argv)).not.toContain(archiveCanary);
    expect(JSON.stringify(result.argv)).not.toContain(evidenceCanary);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Migration archive preflight complete.\n");
    expect(result.stderr).toBe("");
    const serializedEvidence = await readFile(evidencePath, "utf8");
    for (const canary of [archiveCanary, evidenceCanary, valueCanary]) {
      expect(result.stdout).not.toContain(canary);
      expect(result.stderr).not.toContain(canary);
      expect(serializedEvidence).not.toContain(canary);
    }
    expect(serializedEvidence).not.toContain(archive);
    expect(serializedEvidence).not.toContain(evidencePath);
    expect((await stat(evidencePath)).mode & 0o777).toBe(0o600);
  });

  it("returns exit 2 with redacted evidence for a blocked archive", async () => {
    const directory = await privateDirectory();
    const canary = "PRIVATE-BLOCKED-ARCHIVE-CANARY";
    const archive = join(directory, `${canary}.zip`);
    const evidencePath = join(directory, "evidence.json");
    await writeFile(archive, `not-a-zip-${canary}`);
    await chmod(archive, 0o600);
    const manifestPath = await privateManifest(
      directory,
      [archive],
      evidencePath,
    );

    const result = await runPreflightCli(manifestPath);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("Migration archive preflight complete.\n");
    expect(result.stderr).toBe("");
    const serializedEvidence = await readFile(evidencePath, "utf8");
    expect(serializedEvidence).toContain('"archive_not_zip"');
    for (const output of [
      result.stdout,
      result.stderr,
      serializedEvidence,
      JSON.stringify(result.argv),
    ]) {
      expect(output).not.toContain(canary);
      expect(output).not.toContain(archive);
    }
  });

  it("returns exit 1 generically for pre-existing evidence and fatal manifests", async () => {
    const directory = await privateDirectory();
    const canary = "PRIVATE-FATAL-CLI-CANARY";
    const archive = join(directory, `${canary}.zip`);
    const evidencePath = join(directory, `${canary}-evidence.json`);
    await writeFile(archive, makeZip([]));
    await chmod(archive, 0o600);
    await writeFile(evidencePath, "existing");
    await chmod(evidencePath, 0o600);
    const manifestPath = await privateManifest(
      directory,
      [archive],
      evidencePath,
    );

    const existingEvidence = await runPreflightCli(manifestPath);
    expect(existingEvidence).toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr:
        "Migration archive preflight could not complete safely. No archive details were printed.\n",
    });
    expect(await readFile(evidencePath, "utf8")).toBe("existing");

    await writeFile(manifestPath, `{"invalid":"${canary}"}`);
    await chmod(manifestPath, 0o600);
    const fatalManifest = await runPreflightCli(manifestPath);
    expect(fatalManifest).toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr:
        "Migration archive preflight could not complete safely. No archive details were printed.\n",
    });
    for (const output of [
      existingEvidence.stdout,
      existingEvidence.stderr,
      fatalManifest.stdout,
      fatalManifest.stderr,
      JSON.stringify(existingEvidence.argv),
      JSON.stringify(fatalManifest.argv),
    ]) {
      expect(output).not.toContain(canary);
      expect(output).not.toContain(archive);
      expect(output).not.toContain(evidencePath);
    }
  });

  it("keeps configured ratio and platform caps in evidence", async () => {
    const archive = await archiveWith([
      { name: "clients.csv", data: validClientCsv() },
    ]);
    const evidence = await preflightMigrationArchives([archive]);
    expect(evidence.limits).toMatchObject({
      candidateCompressionRatio:
        MIGRATION_ARCHIVE_LIMITS.candidateCompressionRatio,
      csvBytes: IMPORT_CSV_MAX_BYTES,
      csvRows: IMPORT_MAX_ROWS,
    });
  });

  it("pins every public archive and manifest resource limit", () => {
    expect(MIGRATION_ARCHIVE_LIMITS).toEqual({
      archiveBytes: 2_000_000_000,
      centralDirectoryBytes: 64_000_000,
      entries: 50_000,
      advertisedUncompressedBytes: 10_000_000_000,
      aggregateEntries: 100_000,
      csvCandidatesPerArchive: 128,
      aggregateCsvCandidates: 256,
      candidateCompressedBytes: 5_065_536,
      candidateCompressionRatio: 200,
      csvLogicalRecords: 10_001,
      csvColumnsPerRecord: 512,
      csvTotalCells: 1_000_000,
    });
    expect(MIGRATION_ARCHIVE_MANIFEST_LIMITS).toEqual({
      bytes: 64_000,
      archives: 32,
      pathCharacters: 4_096,
    });
    expect(IMPORT_CSV_MAX_BYTES).toBe(5_000_000);
    expect(IMPORT_MAX_ROWS).toBe(10_000);
    expect(candidateCompressionRatioExceedsLimit(1, 200)).toBe(false);
    expect(candidateCompressionRatioExceedsLimit(10, 2_000)).toBe(false);
    expect(candidateCompressionRatioExceedsLimit(10, 2_001)).toBe(true);
    expect(aggregateArchiveEntryBudgetExceeded(99_999, 1)).toBe(false);
    expect(aggregateArchiveEntryBudgetExceeded(100_000, 1)).toBe(true);
  });

  it("blocks sparse archive, central-directory, and entry-count limits", async () => {
    const directory = await privateDirectory();
    const sparse = join(directory, "sparse.zip");
    const sparseHandle = await open(sparse, "w", 0o600);
    await sparseHandle.truncate(2_000_000_001);
    await sparseHandle.close();
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([sparse])),
    ).toBe("archive_too_large");

    const centralTooLarge = patchEocd(makeZip([]), (copy, eocdOffset) => {
      copy.writeUInt32LE(64_000_001, eocdOffset + 12);
    });
    const centralPath = join(directory, "central.zip");
    await writeFile(centralPath, centralTooLarge);
    await chmod(centralPath, 0o600);
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([centralPath])),
    ).toBe("central_directory_too_large");

    const entriesTooMany = patchEocd(makeZip([]), (copy, eocdOffset) => {
      copy.writeUInt16LE(50_001, eocdOffset + 8);
      copy.writeUInt16LE(50_001, eocdOffset + 10);
    });
    const entryPath = join(directory, "entries.zip");
    await writeFile(entryPath, entriesTooMany);
    await chmod(entryPath, 0o600);
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([entryPath])),
    ).toBe("too_many_entries");
  });

  it("blocks advertised-output and compressed-candidate limits", async () => {
    const advertised = await archiveWith([
      {
        name: "one.bin",
        data: "one",
        advertisedUncompressedBytes: 4_000_000_000,
      },
      {
        name: "two.bin",
        data: "two",
        advertisedUncompressedBytes: 4_000_000_000,
      },
      {
        name: "three.bin",
        data: "three",
        advertisedUncompressedBytes: 4_000_000_000,
      },
    ]);
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([advertised])),
    ).toBe("advertised_output_too_large");

    const compressed = await archiveWith([
      {
        name: "large.csv",
        data: Buffer.alloc(5_065_537, 0x78),
        method: 0,
      },
    ]);
    expect(
      firstArchiveBlocker(await preflightMigrationArchives([compressed])),
    ).toBe("candidate_compressed_too_large");
  });

  it("blocks manifest archive-count and path-length limits", async () => {
    const directory = await privateDirectory();
    const manifestPath = join(directory, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        archives: Array.from(
          { length: 33 },
          (_, index) => `/private/archive-${index}.zip`,
        ),
        evidence: join(directory, "evidence.json"),
      }),
    );
    await chmod(manifestPath, 0o600);
    await expect(
      validatedMigrationArchiveCliPaths({ manifestPath }),
    ).rejects.toThrow("manifest_invalid");

    await writeFile(
      manifestPath,
      JSON.stringify({
        archives: [`/${"x".repeat(4_096)}`],
        evidence: join(directory, "evidence.json"),
      }),
    );
    await chmod(manifestPath, 0o600);
    await expect(
      validatedMigrationArchiveCliPaths({ manifestPath }),
    ).rejects.toThrow("manifest_invalid");
  });

  it("links the operator preflight without expanding self-serve migration scope", async () => {
    const migrationGuide = await readFile(
      join(process.cwd(), "../../docs/migrating-to-openvpm.md"),
      "utf8",
    );
    expect(migrationGuide).toContain(
      "[Shepherd migration archive preflight](shepherd-migration-archive-preflight.md)",
    );
    expect(migrationGuide).toContain(
      "does not\nexpand the self-serve importer",
    );
    expect(migrationGuide).toContain(
      "reviewed CSV dry run remains authoritative",
    );
  });
});
