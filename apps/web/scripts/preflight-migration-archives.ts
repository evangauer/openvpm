import { constants as fsConstants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  preflightMigrationArchives,
  writeMigrationArchiveEvidence,
} from "../lib/import/archive-preflight";

export const MIGRATION_ARCHIVE_MANIFEST_LIMITS = {
  bytes: 64_000,
  archives: 32,
  pathCharacters: 4_096,
} as const;

export type MigrationArchiveManifestTestHooks = {
  /** Test-only synchronization point. Production callers must leave this unset. */
  afterManifestFirstRead?: () => void | Promise<void>;
};

type MigrationArchiveCliArgs = {
  manifestPath: string;
};

export type ValidatedMigrationArchiveCliPaths = {
  archivePaths: string[];
  evidencePath: string;
};

function usage(): string {
  return [
    "Usage:",
    "  pnpm migration:preflight-archives --manifest /private/archive-manifest.json",
    "",
    "The private manifest contains archive paths so source paths never appear in process arguments.",
    "Manifest, archive, and evidence paths must be outside the repository.",
  ].join("\n");
}

function parseArgs(argv: readonly string[]): MigrationArchiveCliArgs {
  let manifestPath: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (argument === "--manifest") {
      const value = argv[++index];
      if (!value || manifestPath) throw new Error("invalid_arguments");
      manifestPath = value;
      continue;
    }
    throw new Error("invalid_arguments");
  }
  if (!manifestPath) throw new Error("invalid_arguments");
  if (!isAbsolute(manifestPath)) throw new Error("absolute_paths_required");
  return { manifestPath };
}

function isWithin(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..")
  );
}

async function canonicalPathWithoutFollowingFinalComponent(
  path: string,
  repositoryRoot: string,
): Promise<string> {
  if (path.endsWith(sep)) throw new Error("file_path_required");
  const name = basename(path);
  if (!name || name === "." || name === "..") {
    throw new Error("file_path_required");
  }
  const canonicalParent = await realpath(dirname(path));
  const canonicalPath = resolve(canonicalParent, name);
  if (isWithin(repositoryRoot, canonicalPath)) {
    throw new Error("repository_paths_rejected");
  }
  const parentStat = await stat(canonicalParent);
  if (
    typeof process.getuid !== "function" ||
    parentStat.uid !== process.getuid() ||
    (parentStat.mode & 0o077) !== 0
  ) {
    throw new Error("private_parent_required");
  }
  return canonicalPath;
}

async function readPrivateManifest(
  manifestPath: string,
  testHooks?: MigrationArchiveManifestTestHooks,
): Promise<{
  archives: string[];
  evidence: string;
}> {
  let handle: FileHandle | undefined;
  try {
    try {
      handle = await open(
        manifestPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as { code?: string } | null)?.code === "ELOOP") {
        throw new Error("manifest_symlink_rejected");
      }
      throw error;
    }
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("manifest_not_regular");
    if (
      typeof process.getuid !== "function" ||
      before.uid !== process.getuid()
    ) {
      throw new Error("manifest_owner_invalid");
    }
    if ((before.mode & 0o077) !== 0) {
      throw new Error("manifest_permissions_invalid");
    }
    if (
      before.size < 1 ||
      before.size > MIGRATION_ARCHIVE_MANIFEST_LIMITS.bytes
    ) {
      throw new Error("manifest_size_invalid");
    }
    const first = Buffer.alloc(before.size);
    const firstRead = await handle.read(first, 0, first.length, 0);
    if (firstRead.bytesRead !== first.length)
      throw new Error("manifest_changed");
    await testHooks?.afterManifestFirstRead?.();
    const second = Buffer.alloc(before.size);
    const secondRead = await handle.read(second, 0, second.length, 0);
    if (secondRead.bytesRead !== second.length || !second.equals(first)) {
      throw new Error("manifest_changed");
    }
    const after = await handle.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("manifest_changed");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(first),
      );
    } catch {
      throw new Error("manifest_invalid");
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(parsed, "archives") ||
      !Object.prototype.hasOwnProperty.call(parsed, "evidence")
    ) {
      throw new Error("manifest_invalid");
    }
    const manifest = parsed as { archives?: unknown; evidence?: unknown };
    const archives = manifest.archives;
    if (
      !Array.isArray(archives) ||
      archives.length < 1 ||
      archives.length > MIGRATION_ARCHIVE_MANIFEST_LIMITS.archives ||
      archives.some(
        (path) =>
          typeof path !== "string" ||
          path.length < 1 ||
          path.length > MIGRATION_ARCHIVE_MANIFEST_LIMITS.pathCharacters ||
          path.includes("\0") ||
          !isAbsolute(path),
      ) ||
      new Set(archives).size !== archives.length
    ) {
      throw new Error("manifest_invalid");
    }
    if (
      typeof manifest.evidence !== "string" ||
      manifest.evidence.length < 1 ||
      manifest.evidence.length >
        MIGRATION_ARCHIVE_MANIFEST_LIMITS.pathCharacters ||
      manifest.evidence.includes("\0") ||
      !isAbsolute(manifest.evidence)
    ) {
      throw new Error("manifest_invalid");
    }
    return { archives: archives as string[], evidence: manifest.evidence };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function validatedMigrationArchiveCliPaths(
  input: MigrationArchiveCliArgs,
  testHooks?: MigrationArchiveManifestTestHooks,
): Promise<ValidatedMigrationArchiveCliPaths> {
  const repositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const manifestPath = await canonicalPathWithoutFollowingFinalComponent(
    input.manifestPath,
    repositoryRoot,
  );
  const manifest = await readPrivateManifest(manifestPath, testHooks);
  const archivePaths = await Promise.all(
    manifest.archives.map((archivePath) =>
      canonicalPathWithoutFollowingFinalComponent(archivePath, repositoryRoot),
    ),
  );
  if (new Set(archivePaths).size !== archivePaths.length) {
    throw new Error("manifest_duplicate_archives");
  }
  const evidencePath = await canonicalPathWithoutFollowingFinalComponent(
    manifest.evidence,
    repositoryRoot,
  );
  if (archivePaths.includes(evidencePath)) {
    throw new Error("evidence_archive_collision");
  }
  return { archivePaths, evidencePath };
}

async function main(): Promise<void> {
  process.umask(0o077);
  const input = await validatedMigrationArchiveCliPaths(
    parseArgs(process.argv.slice(2)),
  );
  const evidence = await preflightMigrationArchives(input.archivePaths);
  await writeMigrationArchiveEvidence(input.evidencePath, evidence);
  process.stdout.write("Migration archive preflight complete.\n");
  if (!evidence.safeToContinueOfflineReview) process.exitCode = 2;
}

if (
  process.argv[1] &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])
) {
  main().catch(() => {
    process.stderr.write(
      "Migration archive preflight could not complete safely. No archive details were printed.\n",
    );
    process.exitCode = 1;
  });
}
