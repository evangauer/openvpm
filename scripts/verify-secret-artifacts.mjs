import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const buildRoot = path.join(repositoryRoot, "apps/web/.next");
const serverRoot = path.join(buildRoot, "server");
const EXPECTED_MIDDLEWARE_ENV = [
  "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
  "__NEXT_BUILD_ID",
  "__NEXT_PREVIEW_MODE_ENCRYPTION_KEY",
  "__NEXT_PREVIEW_MODE_ID",
  "__NEXT_PREVIEW_MODE_SIGNING_KEY",
];

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function jsonPathsForSecret(value, secret, current = [], matches = []) {
  if (typeof value === "string") {
    if (value === secret) matches.push(current.join("."));
  } else if (Array.isArray(value)) {
    value.forEach((item, index) =>
      jsonPathsForSecret(item, secret, [...current, String(index)], matches),
    );
  } else if (record(value)) {
    for (const [key, item] of Object.entries(value)) {
      jsonPathsForSecret(item, secret, [...current, key], matches);
    }
  }
  return matches;
}

export function assertNextManifestInvariants(root = buildRoot) {
  const middleware = readJson(
    path.join(root, "server/middleware-manifest.json"),
  );
  const references = readJson(
    path.join(root, "server/server-reference-manifest.json"),
  );
  const prerender = readJson(path.join(root, "prerender-manifest.json"));
  const middlewareRoot = record(record(middleware.middleware)?.["/"]);
  const environment = record(middlewareRoot?.env);
  if (!environment) {
    throw new Error("Next middleware build environment is missing.");
  }
  const actualKeys = Object.keys(environment).sort();
  if (
    JSON.stringify(actualKeys) !==
    JSON.stringify([...EXPECTED_MIDDLEWARE_ENV].sort())
  ) {
    throw new Error(
      "Next middleware contains an unexpected or missing build environment key.",
    );
  }
  if (!Object.values(environment).every((value) => typeof value === "string")) {
    throw new Error("Next middleware build environment is malformed.");
  }
  if (
    references.encryptionKey !== environment.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
  ) {
    throw new Error("Next server-action encryption keys do not match.");
  }
  if (
    readFileSync(path.join(root, "BUILD_ID"), "utf8").trim() !==
    environment.__NEXT_BUILD_ID
  ) {
    throw new Error("Next middleware build ID does not match the artifact.");
  }
  const preview = record(prerender.preview);
  const expectedPreview = {
    previewModeEncryptionKey: environment.__NEXT_PREVIEW_MODE_ENCRYPTION_KEY,
    previewModeId: environment.__NEXT_PREVIEW_MODE_ID,
    previewModeSigningKey: environment.__NEXT_PREVIEW_MODE_SIGNING_KEY,
  };
  if (
    !preview ||
    JSON.stringify(Object.keys(preview).sort()) !==
      JSON.stringify(Object.keys(expectedPreview).sort()) ||
    !Object.entries(expectedPreview).every(
      ([key, value]) => preview[key] === value,
    )
  ) {
    throw new Error(
      "Next prerender preview values do not exactly match the middleware artifact.",
    );
  }
  return { middleware, prerender, references };
}

function isNextGeneratedManifestFinding(finding, manifests, root) {
  if (finding.RuleID !== "generic-api-key") return false;
  const relativeFile = path.relative(root, path.resolve(finding.File));
  if (relativeFile === "server/middleware-manifest.json") {
    const paths = jsonPathsForSecret(manifests.middleware, finding.Secret);
    return (
      paths.length === 1 &&
      [
        "middleware./.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
        "middleware./.env.__NEXT_PREVIEW_MODE_ENCRYPTION_KEY",
        "middleware./.env.__NEXT_PREVIEW_MODE_SIGNING_KEY",
      ].includes(paths[0])
    );
  }
  if (relativeFile === "server/server-reference-manifest.json") {
    return (
      finding.Secret === manifests.references.encryptionKey &&
      jsonPathsForSecret(manifests.references, finding.Secret).includes(
        "encryptionKey",
      )
    );
  }
  if (relativeFile === "prerender-manifest.json") {
    const paths = jsonPathsForSecret(manifests.prerender, finding.Secret);
    return (
      paths.length === 1 &&
      [
        "preview.previewModeEncryptionKey",
        "preview.previewModeSigningKey",
      ].includes(paths[0])
    );
  }
  return false;
}

function isPrivateKeyParserFinding(finding, root) {
  if (
    finding.RuleID !== "private-key" ||
    path.relative(root, path.resolve(finding.File)) !== "server/middleware.js"
  ) {
    return false;
  }
  const source = readFileSync(finding.File, "utf8");
  const marker = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
  const endMarker = ["-----END ", "PRIVATE KEY-----"].join("");
  const markerIndex = source.indexOf(marker);
  if (
    markerIndex < 0 ||
    source.indexOf(marker, markerIndex + marker.length) >= 0 ||
    source.includes(endMarker)
  ) {
    return false;
  }
  const after = source.slice(markerIndex + marker.length, markerIndex + 256);
  const context = source.slice(
    Math.max(0, markerIndex - 1_000),
    markerIndex + 3_000,
  );
  return (
    !/^(?:\\[rn]|[\r\n])+[A-Za-z0-9+/=]{16,}/.test(after) &&
    /pkcs8/i.test(context) &&
    /importKey/.test(context) &&
    context.includes("PUBLIC KEY")
  );
}

function isPinnedTwilioRouteFinding(finding, root, sourceRoot) {
  if (finding.RuleID !== "generic-api-key") return false;
  const relativeFile = path.relative(root, path.resolve(finding.File));
  if (!/^server\/chunks\/[^/]+\.js$/.test(relativeFile)) return false;
  const compiled = readFileSync(finding.File, "utf8");
  const index = compiled.indexOf(finding.Secret);
  if (index < 0) return false;
  const context = compiled.slice(Math.max(0, index - 1_500), index + 1_500);
  if (
    !/^[A-Za-z_$]\.GetApiKeysInstance=void$/.test(finding.Secret) ||
    !context.includes("GetApiKeysPage") ||
    !context.includes("GetApiKeysInstance")
  ) {
    return false;
  }
  const twilioSource = path.join(
    sourceRoot,
    "apps/web/node_modules/twilio/lib/rest/iam/v1/getApiKeys.js",
  );
  return (
    existsSync(twilioSource) &&
    readFileSync(twilioSource, "utf8").includes(
      "exports.GetApiKeysInstance = void 0",
    )
  );
}

export function classifyArtifactFinding({
  finding,
  manifests,
  artifactRoot,
  sourceRoot,
}) {
  if (isNextGeneratedManifestFinding(finding, manifests, artifactRoot)) {
    return "next-generated-manifest-value";
  }
  if (isPrivateKeyParserFinding(finding, artifactRoot)) {
    return "next-private-key-parser-marker";
  }
  if (isPinnedTwilioRouteFinding(finding, artifactRoot, sourceRoot)) {
    return "pinned-twilio-route-constant";
  }
  return null;
}

function run() {
  if (!existsSync(buildRoot) || !statSync(buildRoot).isDirectory()) {
    throw new Error("Build artifact directory apps/web/.next is missing.");
  }
  const manifests = assertNextManifestInvariants(buildRoot);
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "openvpm-artifact-secret-scan-"),
  );
  const reportPath = path.join(temporaryDirectory, "report.json");
  try {
    const result = spawnSync(
      process.env.GITLEAKS_BIN || "gitleaks",
      [
        "dir",
        "--config",
        path.join(repositoryRoot, ".gitleaks-artifacts.toml"),
        "--no-banner",
        "--report-format",
        "json",
        "--report-path",
        reportPath,
        buildRoot,
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
        `Artifact Gitleaks failed with exit code ${String(result.status)}: ${result.stderr.trim()}`,
      );
    }
    const findings = existsSync(reportPath)
      ? JSON.parse(readFileSync(reportPath, "utf8"))
      : [];
    const unknown = [];
    const classifications = new Map();
    for (const finding of findings) {
      const classification = classifyArtifactFinding({
        finding,
        manifests,
        artifactRoot: buildRoot,
        sourceRoot: repositoryRoot,
      });
      if (!classification) {
        unknown.push(
          `${path.relative(repositoryRoot, path.resolve(finding.File))}:${finding.RuleID}:${finding.StartLine}`,
        );
      } else {
        classifications.set(
          classification,
          (classifications.get(classification) ?? 0) + 1,
        );
      }
    }
    if (unknown.length) {
      throw new Error(
        [
          "Deployable artifact secret scan found unclassified candidates.",
          ...unknown.sort().map((item) => `- ${item}`),
        ].join("\n"),
      );
    }
    console.log(
      `Deployable artifact secret scan passed (${findings.length} structurally classified framework/dependency findings).`,
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
