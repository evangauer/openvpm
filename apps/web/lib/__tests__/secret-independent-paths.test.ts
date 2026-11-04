import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SECRET_INDEPENDENT_PATH_PREFIXES,
  isSecretIndependentPath,
} from "../secret-independent-paths";

const WEB_ROOT = path.resolve(__dirname, "../..");

// Modules that read the staff session or derive keys from NEXTAUTH_SECRET.
// A route that reaches any of them must stay behind the secret guard.
const SESSION_OR_SECRET_MODULES = [
  "lib/auth.ts",
  "lib/auth-secret.ts",
  "lib/demo-access.ts",
  "lib/billing/invoice-payment-tokens.ts",
  "lib/portal/tokens.ts",
  "server/trpc.ts",
  "lib/trpc.ts",
].map((file) => path.join(WEB_ROOT, file));
const SESSION_PACKAGES = ["next-auth", "next-auth/jwt", "next-auth/react"];

const IMPORT_PATTERN =
  /(?:^|\n)\s*(import|export)\s+(type\s+)?[^'";]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveLocal(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(WEB_ROOT, specifier.slice(2));
  else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Returns the import chain to a session/secret dependency, if any. */
function sessionDependencyChain(entry: string): string[] | null {
  const seen = new Set<string>();
  const stack: { file: string; chain: string[] }[] = [
    { file: entry, chain: [entry] },
  ];
  while (stack.length > 0) {
    const { file, chain } = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      if (match[2]) continue; // type-only imports are erased at build time
      const specifier = match[3] ?? match[4]!;
      if (SESSION_PACKAGES.includes(specifier)) return [...chain, specifier];
      const resolved = resolveLocal(file, specifier);
      if (!resolved) continue;
      if (SESSION_OR_SECRET_MODULES.includes(resolved)) {
        return [...chain, resolved];
      }
      stack.push({ file: resolved, chain: [...chain, resolved] });
    }
  }
  return null;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("secret-independent paths", () => {
  it.each(SECRET_INDEPENDENT_PATH_PREFIXES)(
    "%s never reaches the staff session or NEXTAUTH_SECRET",
    (prefix) => {
      const dir = path.join(WEB_ROOT, "app", prefix);
      expect(existsSync(dir), `${dir} should exist`).toBe(true);
      const files = sourceFiles(dir);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const chain = sessionDependencyChain(file);
        expect(
          chain?.map((step) => path.relative(WEB_ROOT, step)).join(" > ") ??
            null,
        ).toBeNull();
      }
    },
  );

  it("detects a session dependency (booking reaches tRPC)", () => {
    expect(
      sessionDependencyChain(path.join(WEB_ROOT, "app/book/[slug]/page.tsx")),
    ).not.toBeNull();
  });

  it("matches prefixes exactly, not lookalikes", () => {
    expect(isSecretIndependentPath("/api/webhooks/stripe")).toBe(true);
    expect(isSecretIndependentPath("/api/cron")).toBe(true);
    expect(isSecretIndependentPath("/api/v1/patients")).toBe(true);
    expect(isSecretIndependentPath("/email-preferences")).toBe(true);
    expect(isSecretIndependentPath("/api/webhooksx")).toBe(false);
    expect(isSecretIndependentPath("/api/v10/patients")).toBe(false);
    expect(isSecretIndependentPath("/api/trpc/patient.list")).toBe(false);
    expect(isSecretIndependentPath("/api/auth/session")).toBe(false);
    expect(isSecretIndependentPath("/book/clinic")).toBe(false);
    expect(isSecretIndependentPath("/portal")).toBe(false);
  });
});
