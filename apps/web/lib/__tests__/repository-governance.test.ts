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
});
