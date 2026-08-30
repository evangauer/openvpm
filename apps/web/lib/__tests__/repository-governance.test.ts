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
    expect(
      workflow.match(/branches: \[development, staging, main\]/g),
    ).toHaveLength(1);
    expect(workflow).toContain("pull_request: {}");
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
    expect(workflow).toContain("reject-invalid-production-dispatch:");
    expect(workflow).toContain("validate-production-request:");
    expect(workflow).toContain("needs: validate-production-request");
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
    expect(workflow).toContain(
      'development) expected_ref="refs/heads/development"',
    );
    expect(workflow).toContain('staging) expected_ref="refs/heads/staging"');
    expect(workflow).toContain('demo) expected_ref="refs/heads/main"');
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"');
    expect(workflow.match(/environment: Development/g)).toHaveLength(1);
    expect(workflow.match(/environment: Staging/g)).toHaveLength(1);
    expect(workflow.match(/environment: Demo/g)).toHaveLength(1);
    expect(workflow.match(/secrets\.DATABASE_URL/g)).toHaveLength(27);
    expect(
      workflow.match(/group: apply-migrations-(development|staging|demo)/g),
    ).toHaveLength(3);
    expect(workflow.match(/MIGRATION_CONFORMANCE_MODE: prefix/g)).toHaveLength(
      3,
    );
    expect(workflow.match(/MIGRATION_CONFORMANCE_MODE: exact/g)).toHaveLength(
      3,
    );
    expect(workflow).toContain("DATABASE_TARGET_FINGERPRINT");
    expect(workflow).toContain("FORBIDDEN_DATABASE_TARGET_FINGERPRINTS");
    expect(workflow.match(/FORBIDDEN_FINGERPRINTS:/g)).toHaveLength(3);
    expect(workflow.match(/code contract \(synthetic\)/g)).toHaveLength(3);
  });

  it("checks staging identity and conformance around every migration", () => {
    const workflow = repoFile(".github/workflows/migrate.yml");
    const staging = workflow.split("  staging:")[1]?.split("  demo:")[0];

    expect(staging).toBeDefined();
    expect(staging).toContain("needs: validate-nonproduction-request");
    expect(staging).toContain("if: inputs.target == 'staging'");
    expect(staging).toContain("environment: Staging");
    expect(staging).toContain("DATABASE_TARGET_FINGERPRINT");
    expect(staging).toContain("FORBIDDEN_DATABASE_TARGET_FINGERPRINTS");
    expect(staging).toContain("run: pnpm db:target:check");
    expect(staging).toContain("run: pnpm db:rls:preflight");
    expect(staging).toContain("run: pnpm db:migrate");
    expect(staging).toContain("run: pnpm db:rls");
    expect(staging.indexOf("MIGRATION_CONFORMANCE_MODE: prefix")).toBeLessThan(
      staging.indexOf("run: pnpm db:migrate"),
    );
    expect(
      staging.indexOf("MIGRATION_CONFORMANCE_MODE: exact"),
    ).toBeGreaterThan(staging.indexOf("run: pnpm db:migrate"));
  });

  it("keeps backlog cleanup evidence-gated and migration collisions on hold", () => {
    const policy = repoFile("docs/repository-governance.md");
    const ledger = repoFile("docs/repository-recovery-ledger.md");
    const currentCheckpoint = policy
      .split("## Current transition checkpoint — 2026-08-26")[1]
      ?.split("## Transition note — 2026-08-25")[0];
    const authorityCheckpoint = ledger
      .split("## Authority checkpoint — 2026-08-26")[1]
      ?.split("## Decision vocabulary")[0];
    const normalizedCurrentCheckpoint = currentCheckpoint?.replace(/\s+/g, " ");
    const normalizedAuthorityCheckpoint = authorityCheckpoint?.replace(
      /\s+/g,
      " ",
    );

    expect(policy).toContain("repository-recovery-ledger.md");
    expect(ledger).toContain("Only `close-approved` permits closing");
    expect(ledger).toContain("cc6fd16cc8d414f181d278546e2a1213300732a0");
    expect(ledger).toContain("#205");
    expect(ledger).toContain("#222");
    expect(ledger).toContain("feat/lifecycle-emails");
    expect(ledger).toContain("The local `0094` and `0095` names collide");
    expect(ledger).toContain("No migration or snapshot from these worktrees");
    expect(ledger).toContain("Authority checkpoint — 2026-08-26");
    expect(ledger).toContain("`46a7c0636e91e6f1d1ce58362daa3a4a9487c613`");
    expect(ledger).toContain("tree `f98d82ee4ec57387dfa487e9d615bbf8d18ba2e0`");
    expect(ledger).toContain("`cb22872741db3b9d6a30784ec0b70e41dde03ce1`");
    expect(ledger).toContain("tree `30e498c3192c9bdc2a83c7c204e3c5dda73e2420`");
    expect(ledger).toContain("zero open pull requests");
    expect(ledger).toContain("source code remains `evidence-only`");
    expect(ledger).toContain("issues are #257 through #268");
    expect(ledger).toContain("#256 subsumes its near-expiry");
    expect(ledger).toContain(
      "[#268](https://github.com/evangauer/openvpm/issues/268)",
    );
    expect(ledger).toContain("`0098_shallow_jackpot`");
    expect(authorityCheckpoint).toBeDefined();
    expect(normalizedAuthorityCheckpoint).toContain(
      "recorded 157 local branches, 151 `origin` remote heads excluding `origin/HEAD`, and 104 registered worktrees",
    );
    expect(normalizedAuthorityCheckpoint).toContain(
      "Exactly 22 are PIMS worktrees registered below the frozen Orca workspace",
    );
    expect(normalizedAuthorityCheckpoint).toContain(
      "zero open pull requests, 255 closed-state pull requests (233 merged and 22 closed without merge), and twelve open issues",
    );
    expect(normalizedAuthorityCheckpoint).toContain(
      "The Vercel production aliases `app.openvpm.com` and `demo.openvpm.com` resolve to READY `openvpm-app` and `openvpm` deployments sourced from exact Main commit `b2d07cd970dcb4b0fef276bcdeb0dbb105e6f6ca`",
    );
    expect(normalizedAuthorityCheckpoint).toContain(
      "Development and pull-request candidates remain deliberately CANCELED by the preview quarantine",
    );
    expect(normalizedAuthorityCheckpoint).toContain(
      "placeholder `openvpm-docs` Main deployment remains ERROR at old commit `676f0b09d30a0a6f8804736fc7475cbd1f408d1a`",
    );
    expect(normalizedAuthorityCheckpoint).toContain(
      "GitHub Production deployment `6088849562` records exact Main `b2d07cd`",
    );
    expect(normalizedAuthorityCheckpoint).toContain(
      "GitHub has no Development or Staging environment deployment record",
    );
    expect(policy).toContain("the protected `staging` ref and");
    expect(policy).toContain(
      "This does not imply that Staging has a deployed artifact",
    );
    expect(policy).toContain("No pull request remained");
    expect(policy).toContain("`past_due` versus");
    expect(policy).toContain("Current transition checkpoint — 2026-08-26");
    expect(currentCheckpoint).toBeDefined();
    expect(normalizedCurrentCheckpoint).toContain(
      "Promotion remains **NO-GO**",
    );
    expect(normalizedCurrentCheckpoint).toContain(
      "protected refs were `development` at `46a7c0636e91e6f1d1ce58362daa3a4a9487c613`; the protected `staging` ref and deployed `main` remain at `b2d07cd970dcb4b0fef276bcdeb0dbb105e6f6ca`",
    );
    expect(normalizedCurrentCheckpoint).toContain(
      "PR #270 was the last completed Development merge at audit time",
    );
    expect(normalizedCurrentCheckpoint).toContain(
      "PR #256 remains the latest product integration",
    );
    expect(normalizedCurrentCheckpoint).toContain(
      "immutable audit observation",
    );
    expect(normalizedCurrentCheckpoint).toContain(
      "must read the live protected refs",
    );
    expect(normalizedCurrentCheckpoint).toContain(
      "The retirement grace clock has not started",
    );
    expect(normalizedCurrentCheckpoint).toContain(
      "Repository ruleset `20625373` covers exactly `development`, `staging`, and `main`, has no bypass actors",
    );
    expect(normalizedCurrentCheckpoint).toContain("both CodeQL analyses");
    expect(normalizedCurrentCheckpoint).toContain(
      "All three environments allow administrator bypass",
    );
    expect(normalizedCurrentCheckpoint).toContain(
      "Development candidates remain CANCELED by quarantine",
    );
    expect(normalizedCurrentCheckpoint).toContain(
      "placeholder docs deployment remains ERROR on old Main `676f0b09d30a0a6f8804736fc7475cbd1f408d1a`",
    );
    expect(normalizedCurrentCheckpoint).toContain(
      "GitHub Production deployment `6088849562` records Main `b2d07cd`",
    );
    expect(normalizedCurrentCheckpoint).toContain(
      "no Development or Staging environment deployment record",
    );
    expect(normalizedCurrentCheckpoint).toContain(
      "not evidence that an immutable artifact passed Staging and was promoted unchanged",
    );
  });

  it("keeps repository retirement fail-closed behind preservation and grace", () => {
    const register = repoFile("docs/repository-retirement-register.md");
    const policy = repoFile("docs/repository-governance.md");
    const orcaRows = register
      .split("The independent persisted-state audit produced")[1]
      ?.split("Execution order after the clock expires")[0]
      ?.match(/^\| `/gm);

    expect(register).toContain(
      "The retirement grace clock has **not started**",
    );
    expect(register).toContain("fourteen full calendar days");
    expect(register).toContain("No actual earliest deletion date exists");
    expect(register).toContain("codex/activation-event-coverage");
    expect(register).toContain("codex/activation-recovery");
    expect(register).toContain("fix/lockfile-tiptap");
    expect(register).toContain("chore/remove-apps-www");
    expect(register).toContain(
      "Every PIMS worktree registered under Orca remains on hold",
    );
    expect(orcaRows).toHaveLength(22);
    expect(register).toContain("codex/openvpm-89-treatment-composer");
    expect(register).toContain("fe5c91c2b64c772feb87c340318b026fc81d2e43");
    expect(register).toContain("explicit WIP disposition");
    expect(register).toContain("owner confirmation still required");
    expect(register).toContain(
      "the owner-confirmation item only after\nconfirmation",
    );
    expect(register).toContain("outside this repository's cleanup scope");
    expect(register).toContain("No entry has been executed");
    expect(register).not.toContain("/Users/");
    expect(policy).toContain("repository-retirement-register.md");
    expect(policy).toContain("a proposal, not deletion authorization");
  });

  it("requires non-production credential isolation before lifting preview quarantine", () => {
    const policy = repoFile("docs/repository-governance.md");

    expect(policy).toContain("Preview and non-production credential isolation");
    expect(policy).toContain(
      "must never receive a credential that can mutate Production",
    );
    expect(policy).toContain("rotate any");
    expect(policy).toContain(
      "Production credential that was previously available",
    );
    expect(policy).toContain("test ! -f .vercel-deploy-enabled");
    expect(policy).toContain("Do not protect `development` or `staging`");
  });

  it("keeps live clinic launch explicitly gated by authoritative recovery evidence", () => {
    const readiness = repoFile("docs/clinic-pilot-readiness.md");

    expect(readiness).toContain("NO_GO for a new live clinic cutover");
    expect(readiness).toContain("authoritative exact-SHA release");
    expect(readiness).toContain("provider-backed restore drill");
    expect(readiness).toContain("patient-linked object exception");
    expect(readiness).toContain("existing PIMS authoritative");
  });
});
