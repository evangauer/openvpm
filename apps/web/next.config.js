const path = require("node:path");
const { PHASE_DEVELOPMENT_SERVER } = require("next/constants");
// Resolve Next's own dependency so pnpm's strict layout needs no new package.
const { loadEnvConfig, updateInitialEnv } = require(
  require.resolve("@next/env", { paths: [require.resolve("next/package.json")] })
);

const {
  capabilityHeaders,
  securityHeaders,
} = require("./lib/security-headers.js");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  transpilePackages: ["@openpims/api", "@openpims/db", "@openpims/email"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      { source: "/capture/:path*", headers: capabilityHeaders },
      { source: "/sign/:path*", headers: capabilityHeaders },
      { source: "/treatment-plan/:path*", headers: capabilityHeaders },
      { source: "/api/capture/:path*", headers: capabilityHeaders },
      { source: "/api/sign/:path*", headers: capabilityHeaders },
      { source: "/api/treatment-plan/:path*", headers: capabilityHeaders },
      { source: "/offline/:path*", headers: [
        { key: "Cache-Control", value: "no-cache" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
      ] },
    ];
  },
};

module.exports = (phase) => {
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    const repoRoot = path.resolve(__dirname, "../..");
    // Next has already loaded apps/web env files and cached the result. Keep
    // those values (and shell exports), then explicitly reload from the root.
    updateInitialEnv(process.env);
    loadEnvConfig(repoRoot, true, console, true);
    // Preserve root values when Next initializes workers or reloads its env.
    updateInitialEnv(process.env);

    if (!process.env.DATABASE_URL?.trim()) {
      throw new Error(
        `DATABASE_URL is missing. Create the repository root .env at ${path.join(repoRoot, ".env")} ` +
          "with cp .env.example .env, set DATABASE_URL, and restart pnpm dev."
      );
    }
  }

  return nextConfig;
};
