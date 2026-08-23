import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import postgres from "postgres";
import {
  assertRlsDeploymentCapability,
  inspectRlsDeploymentCapability,
  rlsDeploymentCapabilityIsReady,
} from "./rls-preflight";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const adminUrl = requiredEnv("DATABASE_URL");
const suffix = randomUUID().replaceAll("-", "");
const databaseName = `openpims_rls_preflight_${suffix}`;
const runnerRole = `openpims_preflight_runner_${suffix}`;
const foreignRole = `openpims_preflight_foreign_${suffix}`;
const runnerPassword = randomUUID();
const safeIdentifier = /^[a-z][a-z0-9_]+$/;

for (const identifier of [databaseName, runnerRole, foreignRole]) {
  if (!safeIdentifier.test(identifier) || identifier.length > 63) {
    throw new Error("unsafe disposable PostgreSQL identifier");
  }
}

const targetAdminUrl = new URL(adminUrl);
targetAdminUrl.pathname = `/${databaseName}`;
targetAdminUrl.search = "";
targetAdminUrl.hash = "";

const runnerUrl = new URL(targetAdminUrl);
runnerUrl.username = runnerRole;
runnerUrl.password = runnerPassword;

const repoRoot = resolve(process.cwd(), "../..");
const admin = postgres(adminUrl, { max: 1 });
let targetAdmin: ReturnType<typeof postgres> | undefined;
let runner: ReturnType<typeof postgres> | undefined;

try {
  await admin.unsafe(
    `create role "${runnerRole}" login password '${runnerPassword}'`,
  );
  await admin.unsafe(`create role "${foreignRole}" nologin`);
  await admin.unsafe(`create database "${databaseName}" owner "${runnerRole}"`);

  execFileSync("pnpm", ["--filter", "@openpims/db", "db:migrate"], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: runnerUrl.toString() },
    encoding: "utf8",
  });

  targetAdmin = postgres(targetAdminUrl.toString(), { max: 1 });
  await targetAdmin.unsafe(
    "create table public.preflight_foreign_probe(id integer)",
  );
  await targetAdmin.unsafe(
    `alter table public.preflight_foreign_probe owner to "${foreignRole}"`,
  );
  await targetAdmin.unsafe(
    `create table public.preflight_acl_probe(id integer); alter table public.preflight_acl_probe owner to "${runnerRole}"`,
  );

  runner = postgres(runnerUrl.toString(), { max: 1 });
  const [aclBefore] = await runner<
    Array<{ acl: string | null }>
  >`select relacl::text as acl from pg_class where oid = 'public.preflight_acl_probe'::regclass`;

  const blocked = await inspectRlsDeploymentCapability(runner);
  if (
    blocked.currentRole !== runnerRole ||
    blocked.unmanageableObjects.join(",") !== "table preflight_foreign_probe" ||
    rlsDeploymentCapabilityIsReady(blocked)
  ) {
    throw new Error(
      `unexpected blocked preflight result: ${JSON.stringify(blocked)}`,
    );
  }

  let rejected = false;
  try {
    await assertRlsDeploymentCapability(runner);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("ownership mismatch did not fail closed");

  const [aclAfter] = await runner<
    Array<{ acl: string | null }>
  >`select relacl::text as acl from pg_class where oid = 'public.preflight_acl_probe'::regclass`;
  if (aclAfter?.acl !== aclBefore?.acl) {
    throw new Error("RLS ownership preflight mutated table privileges");
  }

  await targetAdmin.unsafe("drop table public.preflight_foreign_probe");
  const ready = await inspectRlsDeploymentCapability(runner);
  if (!rlsDeploymentCapabilityIsReady(ready)) {
    throw new Error(`compliant owner did not pass: ${JSON.stringify(ready)}`);
  }

  console.log(
    "RLS ownership preflight PostgreSQL contract passed: mismatch refused without ACL mutation; compliant owner accepted.",
  );
} finally {
  if (runner) await runner.end();
  if (targetAdmin) await targetAdmin.end();
  await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
  await admin.unsafe(`drop role if exists "${foreignRole}"`);
  await admin.unsafe(`drop role if exists "${runnerRole}"`);
  await admin.end();
}
