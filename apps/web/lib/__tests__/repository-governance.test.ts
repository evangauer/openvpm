import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const repoFile = (path: string) =>
  readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");

describe("repository promotion controls", () => {
  it("runs CI for each controlled branch", () => {
    const workflow = repoFile(".github/workflows/ci.yml");

    expect(workflow).toContain("branches: [development, staging, main]");
    expect(workflow.match(/branches: \[development, staging, main\]/g)).toHaveLength(
      2,
    );
  });

  it("targets scheduled dependency version updates at development", () => {
    const dependabot = repoFile(".github/dependabot.yml");
    const updateBlocks = dependabot
      .split(/^  - package-ecosystem: /m)
      .slice(1)
      .map((block) => {
        const [ecosystem] = block.split("\n", 1);
        return [ecosystem.trim(), block] as const;
      });
    const updates = new Map(updateBlocks);

    expect(updates.get("npm")).toMatch(/^    target-branch: development$/m);
    expect(updates.get("github-actions")).toMatch(
      /^    target-branch: development$/m,
    );
    expect([...updates.values()].join("\n")).not.toMatch(
      /^    target-branch: main$/m,
    );
  });

  it("excludes local Supabase project linkage from repository state", () => {
    const ignoredPath = execFileSync(
      "git",
      ["check-ignore", "--no-index", "supabase/.temp/linked-project.json"],
      { cwd: repoRoot, encoding: "utf8" },
    ).trim();

    expect(ignoredPath).toBe("supabase/.temp/linked-project.json");
  });

  it("keeps production migrations manual, main-only, and exact-revision bound", () => {
    const workflow = repoFile(".github/workflows/migrate.yml");
    const production = workflow
      .split("  production:")[1]
      ?.split("  development:")[0];

    expect(production).toBeDefined();
    expect(production).toContain("github.event_name == 'workflow_dispatch'");
    expect(production).toContain("github.ref == 'refs/heads/main'");
    expect(production).toContain("inputs.target == 'production'");
    expect(production).toContain("environment: Production");
    expect(workflow).toContain("MIGRATE_PRODUCTION");
    expect(workflow).toContain("^[0-9a-f]{40}$");
    expect(workflow).toContain('[ "$REQUESTED_RELEASE_SHA" != "$GITHUB_SHA" ]');
    expect(workflow).toContain("validate-production-request:");
    expect(workflow).toContain("needs: validate-production-request");
    expect(workflow).toContain("reject-invalid-production-dispatch:");
    expect(workflow).toContain(
      "inputs.target == 'production' && github.ref != 'refs/heads/main'",
    );
    expect(production).toContain("group: apply-migrations-production");
    expect(workflow).toContain("queue: max");
    expect(production).toContain("PRODUCTION_DATABASE_URL is not configured");
    expect(production).toContain("OPENPIMS_APP_DB_PASSWORD is not configured");
    expect(production).toContain("^[[:space:]]*$");
    expect(production).not.toContain("skipping production");
    expect(production).not.toContain("db:migrations:conformance");
  });

  it("keeps nonproduction migrations manual, explicit, isolated, and target-bound", () => {
    const workflow = repoFile(".github/workflows/migrate.yml");

    expect(workflow).not.toMatch(/^  push:/m);
    expect(workflow).not.toContain("matrix:");
    expect(workflow).not.toContain("secrets: inherit");
    expect(workflow).toContain("validate-nonproduction-request:");
    expect(workflow).toContain('development) expected_ref="refs/heads/development"');
    expect(workflow).toContain('staging) expected_ref="refs/heads/staging"');
    expect(workflow).toContain('demo) expected_ref="refs/heads/main"');
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"');
    expect(workflow.match(/environment: Development/g)).toHaveLength(1);
    expect(workflow.match(/environment: Staging/g)).toHaveLength(1);
    expect(workflow.match(/environment: Demo/g)).toHaveLength(1);
    expect(workflow.match(/secrets\.DATABASE_URL/g)).toHaveLength(27);
    expect(workflow.match(/group: apply-migrations-(development|staging|demo)/g)).toHaveLength(3);
    expect(workflow.match(/MIGRATION_CONFORMANCE_MODE: prefix/g)).toHaveLength(3);
    expect(workflow.match(/MIGRATION_CONFORMANCE_MODE: exact/g)).toHaveLength(3);
    expect(workflow).toContain("DATABASE_TARGET_FINGERPRINT");
    expect(workflow).toContain("FORBIDDEN_DATABASE_TARGET_FINGERPRINTS");
    expect(workflow.match(/FORBIDDEN_FINGERPRINTS:/g)).toHaveLength(3);
  });

  it("keeps backlog cleanup evidence-gated and migration collisions on hold", () => {
    const policy = repoFile("docs/repository-governance.md");
    const ledger = repoFile("docs/repository-recovery-ledger.md");

    expect(policy).toContain("repository-recovery-ledger.md");
    expect(ledger).toContain("Only `close-approved` permits closing");
    expect(ledger).toContain("cc6fd16cc8d414f181d278546e2a1213300732a0");
    expect(ledger).toContain("#205");
    expect(ledger).toContain("#222");
    expect(ledger).toContain("feat/lifecycle-emails");
    expect(ledger).toContain("The local `0094` and `0095` names collide");
    expect(ledger).toContain("No migration or snapshot from these worktrees");
  });

  it("requires non-production credential isolation before lifting preview quarantine", () => {
    const policy = repoFile("docs/repository-governance.md");

    expect(policy).toContain("Preview and non-production credential isolation");
    expect(policy).toContain("must never receive a credential that can mutate Production");
    expect(policy).toContain("rotate any");
    expect(policy).toContain("Production credential that was previously available");
    expect(policy).toContain("test ! -f .vercel-deploy-enabled");
    expect(policy).toContain("Do not protect `development` or `staging`");
  });
});
