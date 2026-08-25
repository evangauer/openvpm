import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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

  it("keeps production migrations manual, main-only, and exact-revision bound", () => {
    const workflow = repoFile(".github/workflows/migrate.yml");
    const [production, demo] = workflow.split("  demo:");

    expect(demo).toBeDefined();
    expect(production).toContain("github.event_name == 'workflow_dispatch'");
    expect(production).toContain("github.ref == 'refs/heads/main'");
    expect(production).toContain("inputs.target == 'production'");
    expect(production).toContain("environment: Production");
    expect(production).toContain("MIGRATE_PRODUCTION");
    expect(production).toContain("^[0-9a-f]{40}$");
    expect(production).toContain('[ "$REQUESTED_RELEASE_SHA" != "$GITHUB_SHA" ]');
    expect(workflow).toContain("reject-non-main-dispatch:");
    expect(workflow).toContain("validate-production-request:");
    expect(workflow).toContain("needs: validate-production-request");
    expect(workflow).toContain("group: apply-migrations-${{ inputs.target || 'demo' }}");
    expect(workflow).toContain("queue: max");
    expect(production).toContain("PRODUCTION_DATABASE_URL is not configured");
    expect(production).toContain("OPENPIMS_APP_DB_PASSWORD is not configured");
    expect(production).toContain("^[[:space:]]*$");
    expect(production).not.toContain("skipping production");
    expect(demo).toContain("github.event_name == 'push'");
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
