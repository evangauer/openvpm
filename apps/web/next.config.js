const { securityHeaders } = require("./lib/security-headers.js");
const path = require("node:path");

const capabilityHeaders = [
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
  { key: "Cache-Control", value: "private, no-store, max-age=0" },
];

function configuredDocsOrigin() {
  const value = process.env.DOCS_ORIGIN?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "localhost") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  poweredByHeader: false,
  transpilePackages: [
    "@openpims/api",
    "@openpims/db",
    "@openpims/docs-content",
    "@openpims/email",
  ],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      { source: "/capture/:path*", headers: capabilityHeaders },
      { source: "/sign/:path*", headers: capabilityHeaders },
      { source: "/api/capture/:path*", headers: capabilityHeaders },
      { source: "/api/sign/:path*", headers: capabilityHeaders },
    ];
  },
  async redirects() {
    const docsOrigin = configuredDocsOrigin();
    if (!docsOrigin) return [];
    return [
      {
        source: "/help/training/:slug",
        destination: `${docsOrigin}/training/:slug`,
        permanent: true,
      },
      {
        source: "/help/:slug",
        destination: `${docsOrigin}/guides/:slug`,
        permanent: true,
      },
      {
        source: "/help",
        destination: docsOrigin,
        permanent: true,
      },
    ];
  },
};

module.exports = nextConfig;
