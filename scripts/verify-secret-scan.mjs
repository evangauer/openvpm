import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const MAX_EXCEPTION_AGE_MS = 120 * 24 * 60 * 60 * 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FINGERPRINT_PATTERN = /^(.+):([^:]+):(\d+)$/;

function dateMs(value, label) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD.`);
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return parsed;
}

function normalizedIgnoreLines(ignoreText) {
  return ignoreText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export function validateExceptionRegistry({ ignoreText, manifest, nowMs }) {
  if (!manifest || manifest.schemaVersion !== 1) {
    throw new Error("Secret-scan exception schema version must be 1.");
  }
  if (!Array.isArray(manifest.exceptions)) {
    throw new Error("Secret-scan exceptions must be an array.");
  }

  const fingerprints = new Set();
  for (const [index, exception] of manifest.exceptions.entries()) {
    const label = `Secret-scan exception ${index + 1}`;
    if (
      !exception ||
      typeof exception !== "object" ||
      typeof exception.fingerprint !== "string" ||
      !FINGERPRINT_PATTERN.test(exception.fingerprint)
    ) {
      throw new Error(`${label} has an invalid fingerprint.`);
    }
    if (fingerprints.has(exception.fingerprint)) {
      throw new Error(`${label} duplicates ${exception.fingerprint}.`);
    }
    fingerprints.add(exception.fingerprint);
    if (
      typeof exception.owner !== "string" ||
      !/^@[A-Za-z0-9-]+$/.test(exception.owner)
    ) {
      throw new Error(`${label} must name one GitHub owner.`);
    }
    if (
      typeof exception.reason !== "string" ||
      exception.reason.trim().length < 24
    ) {
      throw new Error(`${label} must explain the synthetic fixture.`);
    }
    const addedAt = dateMs(exception.addedOn, `${label} addedOn`);
    const expiresAt = dateMs(exception.expiresOn, `${label} expiresOn`);
    if (expiresAt <= addedAt || expiresAt - addedAt > MAX_EXCEPTION_AGE_MS) {
      throw new Error(`${label} must expire within 120 days of review.`);
    }
    if (nowMs > expiresAt + 24 * 60 * 60 * 1000 - 1) {
      throw new Error(`${label} expired on ${exception.expiresOn}.`);
    }
  }

  const ignored = normalizedIgnoreLines(ignoreText);
  if (ignored.length !== new Set(ignored).size) {
    throw new Error(".gitleaksignore contains duplicate fingerprints.");
  }
  const sortedIgnored = [...ignored].sort();
  const sortedRegistered = [...fingerprints].sort();
  if (JSON.stringify(sortedIgnored) !== JSON.stringify(sortedRegistered)) {
    throw new Error(
      ".gitleaksignore must exactly match the reviewed exception registry.",
    );
  }
  return fingerprints;
}

export function compareFindingFingerprints(actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    unknown: [...actualSet].filter((item) => !expectedSet.has(item)).sort(),
    stale: [...expectedSet].filter((item) => !actualSet.has(item)).sort(),
  };
}

function verifyFingerprintLocations(fingerprints) {
  for (const fingerprint of fingerprints) {
    const match = FINGERPRINT_PATTERN.exec(fingerprint);
    const file = path.join(repositoryRoot, match[1]);
    const line = Number(match[3]);
    if (!existsSync(file) || !statSync(file).isFile()) {
      throw new Error(`Secret-scan exception file is missing: ${match[1]}.`);
    }
    const lineCount = readFileSync(file, "utf8").split(/\r?\n/).length;
    if (line > lineCount) {
      throw new Error(`Secret-scan exception line is missing: ${fingerprint}.`);
    }
  }
}

function run() {
  const ignoreText = readFileSync(
    path.join(repositoryRoot, ".gitleaksignore"),
    "utf8",
  );
  const manifest = JSON.parse(
    readFileSync(
      path.join(repositoryRoot, ".gitleaks-exceptions.json"),
      "utf8",
    ),
  );
  const expected = validateExceptionRegistry({
    ignoreText,
    manifest,
    nowMs: Date.now(),
  });
  verifyFingerprintLocations(expected);

  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "openvpm-secret-scan-"),
  );
  const sourceDirectory = path.join(temporaryDirectory, "source");
  const reportPath = path.join(temporaryDirectory, "report.json");
  mkdirSync(sourceDirectory, { mode: 0o700 });
  try {
    const candidateFiles = execFileSync(
      "git",
      ["ls-files", "-co", "--exclude-standard", "-z"],
      { cwd: repositoryRoot, encoding: "utf8" },
    )
      .split("\0")
      .filter((file) => file && file !== ".gitleaksignore");
    for (const file of candidateFiles) {
      const source = path.join(repositoryRoot, file);
      const destination = path.join(sourceDirectory, file);
      const relativeDestination = path.relative(sourceDirectory, destination);
      if (
        relativeDestination.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeDestination)
      ) {
        throw new Error(
          `Secret-scan candidate escapes the repository: ${file}.`,
        );
      }
      mkdirSync(path.dirname(destination), { recursive: true });
      const candidateStat = lstatSync(source);
      if (candidateStat.isSymbolicLink()) {
        writeFileSync(destination, readlinkSync(source), { mode: 0o600 });
      } else if (candidateStat.isFile()) {
        copyFileSync(source, destination);
      }
    }

    const result = spawnSync(
      process.env.GITLEAKS_BIN || "gitleaks",
      [
        "dir",
        "--config",
        path.join(repositoryRoot, ".gitleaks.toml"),
        "--redact=100",
        "--no-banner",
        "--report-format",
        "json",
        "--report-path",
        reportPath,
        sourceDirectory,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(
        `Gitleaks failed with exit code ${String(result.status)}: ${result.stderr.trim()}`,
      );
    }
    const findings = existsSync(reportPath)
      ? JSON.parse(readFileSync(reportPath, "utf8"))
      : [];
    const normalizedFindings = findings.map((finding) => {
      const relativeFile = path.relative(
        sourceDirectory,
        path.resolve(finding.File),
      );
      if (
        relativeFile.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeFile)
      ) {
        throw new Error("Gitleaks reported a finding outside the scan root.");
      }
      return {
        ...finding,
        normalizedFingerprint: `${relativeFile}:${finding.RuleID}:${finding.StartLine}`,
      };
    });
    const { unknown, stale } = compareFindingFingerprints(
      normalizedFindings.map((finding) => finding.normalizedFingerprint),
      expected,
    );
    if (unknown.length || stale.length) {
      const lines = ["Secret scan did not match the reviewed exception set."];
      for (const fingerprint of unknown) {
        lines.push(`- unreviewed finding: ${fingerprint}`);
      }
      for (const fingerprint of stale) {
        lines.push(`- stale exception: ${fingerprint}`);
      }
      throw new Error(lines.join("\n"));
    }
    console.log(
      `Secret scan passed (${findings.length} reviewed synthetic fixture exceptions).`,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
