import { spawn, execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile, rm, access, cp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createServer, request as forwardRequest } from "node:http";
import { createServer as createSecureServer } from "node:https";

const root = process.cwd();
const require = createRequire(path.join(root, "packages/db/package.json"));
const webRequire = createRequire(path.join(root, "apps/web/package.json"));
const postgres = require("postgres");
const directory = process.env.OFFLINE_E2E_DIRECTORY;
const adminUrl = process.env.OFFLINE_E2E_ADMIN_DATABASE_URL;
const appPassword = process.env.OPENPIMS_APP_DB_PASSWORD;
const production = process.env.OFFLINE_E2E_SERVER_MODE === "production";
const publicOrigin = production ? "https://127.0.0.1:3457" : "http://127.0.0.1:3457";
if (!directory || !adminUrl || !appPassword) {
  throw new Error("Set OFFLINE_E2E_ADMIN_DATABASE_URL and OPENPIMS_APP_DB_PASSWORD; use playwright.offline.config.ts.");
}
const target = new URL(adminUrl);
if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
    !["postgres:", "postgresql:"].includes(target.protocol)) {
  throw new Error("Offline acceptance requires local PostgreSQL; no supplied database is migrated or seeded.");
}
// Next and dotenv must not load local provider credentials or override isolation.
for (const relative of [".env", ".env.local", ".env.development", ".env.development.local", ".env.production", ".env.production.local"]) {
  for (const base of [root, path.join(root, "apps/web")]) {
    const exists = await access(path.join(base, relative)).then(() => true, () => false);
    if (exists) throw new Error("Run offline acceptance in a clean checkout without local environment files.");
  }
}
const name = `openvpm_offline_e2e_${randomUUID().replaceAll("-", "")}`;
target.pathname = `/${name}`;
target.search = "";
target.hash = "";
const ownerUrl = target.toString();
const appUrl = new URL(target);
appUrl.username = "openpims_app";
appUrl.password = appPassword;
// Inherit only process/toolchain settings, never hosted/provider configuration.
const env = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "CI", "LANG", "LC_ALL", "PNPM_HOME", "NODE_EXTRA_CA_CERTS", "SYSTEMROOT"]
    .flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []),
);
Object.assign(env, {
  DATABASE_URL: ownerUrl,
  OPENPIMS_APP_DB_PASSWORD: appPassword,
  MIGRATION_CONFORMANCE_MODE: "exact",
  NEXTAUTH_SECRET: randomBytes(48).toString("hex"),
  NEXTAUTH_URL: publicOrigin,
  NEXT_PUBLIC_APP_URL: publicOrigin,
  NEXT_PUBLIC_OFFLINE_WORKSPACE_ENABLED: "true",
  NEXT_PUBLIC_OFFLINE_CHART_DRAFTS_ENABLED: "true",
  HOSTED_BILLING_ENABLED: "false",
  NEXT_PUBLIC_DEMO_MODE: "false",
  MESSAGING_PROVISIONING_ENABLED: "false",
  MESSAGING_INBOUND_ENABLED: "false",
  MESSAGING_SENDING_ENABLED: "false",
  NEXT_TELEMETRY_DISABLED: "1",
});
const admin = postgres(adminUrl, { max: 1 });
let created = false;
let child;
let proxy;
let control;
let cleanupPromise;
function cleanup() {
  return cleanupPromise ??= (async () => {
    for (const server of [proxy, control]) {
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(timer);
    }
    if (created) await admin.unsafe(`drop database "${name}" with (force)`);
    await admin.end({ timeout: 5 });
    await rm(path.join(directory, "fixture.json"), { force: true });
    await rm(path.join(directory, "loopback-key.pem"), { force: true });
    await rm(path.join(directory, "loopback-cert.pem"), { force: true });
  })();
}
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => void cleanup().then(() => process.exit(0), () => process.exit(1)));
}
try {
  await admin.unsafe(`create database "${name}"`);
  created = true;
  for (const command of ["db:migrate", "db:rls", "db:migrations:conformance"]) {
    execFileSync("pnpm", ["--filter", "@openpims/db", command], {
      cwd: root, env, stdio: "pipe", timeout: 90_000,
    });
  }
  const app = postgres(appUrl.toString(), { max: 1 });
  try {
    const [role] = await app`select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    if (role.current_user !== "openpims_app" || role.rolsuper || role.rolbypassrls) {
      throw new Error("The browser server must use the restricted application role.");
    }
  } finally {
    await app.end();
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const controlToken = randomBytes(32).toString("hex");
  await writeFile(path.join(directory, "fixture.json"), JSON.stringify({ ownerUrl, controlToken }), { mode: 0o600 });
  env.DATABASE_URL = appUrl.toString();
  if (production) {
    execFileSync("pnpm", ["--filter", "@openpims/web", "build"], {
      cwd: root, env, stdio: "pipe", timeout: 240_000, maxBuffer: 16 * 1024 * 1024,
    });
    const standalone = path.join(root, "apps/web/.next/standalone/apps/web");
    await cp(path.join(root, "apps/web/public"), path.join(standalone, "public"), { recursive: true });
    await cp(path.join(root, "apps/web/.next/static"), path.join(standalone, ".next/static"), { recursive: true });
    env.HOSTNAME = "127.0.0.1";
    env.PORT = "3458";
  } else {
    execFileSync("node", ["scripts/build-offline.mjs"], { cwd: path.join(root, "apps/web"), env, stdio: "pipe" });
  }
  // WebKit's offline emulation rejects even cache-only service-worker responses
  // (microsoft/playwright#42775). A loopback proxy can cut off the real origin
  // without bypassing its service worker. Chromium also tests setOffline(true).
  let available = true;
  let dropNextSave = false;
  let recordSaves = false;
  let saveRequests = [];
  let upgradedWorker = false;
  let proxyFactory = createServer;
  if (production) {
    // Exercise the production HTTPS-upgrade policy with a disposable certificate.
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost", "-keyout", path.join(directory, "loopback-key.pem"), "-out", path.join(directory, "loopback-cert.pem")], { stdio: "pipe" });
    const options = { key: await readFile(path.join(directory, "loopback-key.pem")), cert: await readFile(path.join(directory, "loopback-cert.pem")) };
    proxyFactory = (listener) => createSecureServer(options, listener);
  }
  proxy = proxyFactory((request, response) => {
    if (!available) return request.socket.destroy();
    const isSave = request.url?.split("?")[0] === "/api/trpc/offline.saveSoapDraft";
    const dropResponse = isSave && dropNextSave;
    if (dropResponse) dropNextSave = false;
    if (isSave && recordSaves) {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => saveRequests.push(Buffer.concat(chunks).toString("utf8")));
    }
    const updateWorker = upgradedWorker && request.url === "/offline/sw.js";
    const headers = { ...request.headers };
    if (updateWorker) {
      headers["accept-encoding"] = "identity";
      delete headers["if-none-match"];
      delete headers["if-modified-since"];
    }
    const upstream = forwardRequest({
      hostname: "127.0.0.1", port: 3458,
      path: request.url, method: request.method, headers,
    }, (incoming) => {
      if (updateWorker) {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () => {
          const source = Buffer.concat(chunks).toString("utf8").replace(/openvpm-offline-shell-[a-f0-9]+/, "$&-drill-update");
          response.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" });
          response.end(source);
        });
        return;
      }
      if (dropResponse) {
        // Consume the genuine response after commit, then truncate its body.
        // Sending its headers first prevents transparent transport retries;
        // the application must retain and explicitly retry the pending save.
        let firstByte;
        incoming.on("data", (chunk) => { firstByte ??= chunk.subarray(0, 1); });
        incoming.on("end", () => {
          response.writeHead(incoming.statusCode ?? 502, incoming.headers);
          response.write(firstByte ?? Buffer.from("{"), () => response.destroy());
        });
        return;
      }
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.pipe(response);
    });
    upstream.on("error", () => { response.writeHead(503); response.end(); });
    request.on("aborted", () => upstream.destroy());
    request.pipe(upstream);
  });
  control = createServer((request, response) => {
    if (request.method !== "POST" || request.headers.authorization !== `Bearer ${controlToken}` ||
        !["/disconnect", "/reconnect", "/drop-next-save", "/save-requests", "/worker-update"].includes(request.url)) {
      response.writeHead(403); response.end(); return;
    }
    if (request.url === "/worker-update") {
      upgradedWorker = true;
    } else if (request.url === "/drop-next-save") {
      dropNextSave = true;
      recordSaves = true;
      saveRequests = [];
    } else if (request.url === "/save-requests") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(saveRequests));
      return;
    } else {
      available = request.url === "/reconnect";
      if (!available) proxy.closeAllConnections();
      if (available) { dropNextSave = false; recordSaves = false; upgradedWorker = false; }
    }
    response.end("ok");
  });
  for (const [server, port] of [[proxy, 3457], [control, 3456]]) {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  }
  const serverArguments = production
    ? [path.join(root, "apps/web/.next/standalone/apps/web/server.js")]
    : [webRequire.resolve("next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", "3458"];
  child = spawn(process.execPath, serverArguments, {
    cwd: path.join(root, "apps/web"), env, stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  await cleanup();
  process.exitCode = code ?? 1;
} catch (error) {
  // Subprocess exceptions can embed the database URL in environment/arguments.
  console.error("Offline acceptance setup failed:", error instanceof Error ? error.message.split("\n")[0] : "unknown error");
  await cleanup();
  process.exitCode = 1;
}
