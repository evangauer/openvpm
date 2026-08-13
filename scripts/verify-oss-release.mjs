import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

const tracked = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

const forbiddenNames = new Set([
  "production-target.json",
  "production.env",
  "portable-start-local-review.ts",
  "portable-verify-migration.ts",
]);
const forbiddenArchiveExtensions = new Set([
  ".7z",
  ".backup",
  ".dump",
  ".gz",
  ".tgz",
  ".zip",
]);
const sensitiveContentRules = [
  {
    name: "private key material",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    name: "Vercel access token",
    pattern: /\bvercel_[A-Za-z0-9_-]{20,}\b/,
  },
];

const findings = [];
for (const file of tracked) {
  const name = basename(file);
  if (forbiddenNames.has(name)) {
    findings.push({ file, rule: "private migration handoff artifact" });
  }
  if (name.startsWith(".env") && name !== ".env.example") {
    findings.push({ file, rule: "tracked environment file" });
  }
  if (forbiddenArchiveExtensions.has(extname(name).toLowerCase())) {
    findings.push({ file, rule: "tracked archive or database export" });
  }

  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const rule of sensitiveContentRules) {
    if (rule.pattern.test(content)) findings.push({ file, rule: rule.name });
  }
}

const requiredPublicFiles = [
  ".env.example",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "docker/docker-compose.yml",
  "docs/clinic-pilot-readiness.md",
  "docs/security.md",
];
const trackedSet = new Set(tracked);
for (const file of requiredPublicFiles) {
  if (!trackedSet.has(file)) findings.push({ file, rule: "required release file missing" });
}

if (findings.length > 0) {
  console.error("Open-source release verification failed:");
  for (const finding of findings) {
    console.error(`- ${finding.file}: ${finding.rule}`);
  }
  process.exit(1);
}

console.log(
  `Open-source release verification passed (${tracked.length} tracked files checked).`,
);
