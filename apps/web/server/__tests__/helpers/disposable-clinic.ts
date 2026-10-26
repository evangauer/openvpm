import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../../../packages/db/schema/index";

/** Never migrate, seed, or reset the database supplied by the caller. */
export async function disposableClinic() {
  const adminUrl = process.env.DATABASE_URL;
  const password = process.env.OPENPIMS_APP_DB_PASSWORD;
  if (!adminUrl || !password) {
    throw new Error("DATABASE_URL and OPENPIMS_APP_DB_PASSWORD are required");
  }
  const url = new URL(adminUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Clinic drills require disposable local PostgreSQL");
  }
  const name = `openpims_clinic_drill_${randomUUID().replaceAll("-", "")}`;
  if (!/^openpims_clinic_drill_[a-f0-9]{32}$/.test(name)) {
    throw new Error("Unsafe disposable database name");
  }
  url.pathname = `/${name}`;
  url.search = "";
  url.hash = "";
  const admin = postgres(adminUrl, { max: 1 });
  let owner: ReturnType<typeof postgres> | undefined;
  let app: ReturnType<typeof postgres> | undefined;
  let created = false;
  const close = async () => {
    await app?.end({ timeout: 5 });
    await owner?.end({ timeout: 5 });
    if (created) await admin.unsafe(`drop database "${name}" with (force)`);
    await admin.end({ timeout: 5 });
  };
  try {
    await admin.unsafe(`create database "${name}"`);
    created = true;
    for (const command of [
      "db:migrate",
      "db:rls",
      "db:migrations:conformance",
    ]) {
      execFileSync("pnpm", ["--filter", "@openpims/db", command], {
        cwd: resolve(process.cwd(), "../.."),
        env: {
          ...process.env,
          DATABASE_URL: url.toString(),
          MIGRATION_CONFORMANCE_MODE: "exact",
        },
        stdio: "pipe",
        timeout: 90_000,
      });
    }
    owner = postgres(url.toString(), { max: 1 });
    const appUrl = new URL(url);
    appUrl.username = "openpims_app";
    appUrl.password = password;
    app = postgres(appUrl.toString(), { max: 4 });
    const [role] = await app`
      select current_user, rolsuper, rolbypassrls from pg_roles
      where rolname = current_user
    `;
    if (
      role?.current_user !== "openpims_app" ||
      role.rolsuper ||
      role.rolbypassrls
    ) {
      throw new Error("The drill must use the restricted application role");
    }
    return {
      owner,
      ownerDb: drizzle(owner, { schema }),
      db: drizzle(app, { schema }),
      appUrl: appUrl.toString(),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export type DisposableClinic = Awaited<ReturnType<typeof disposableClinic>>;
