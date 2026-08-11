const { securityHeaders } = require("./lib/security-headers.js");

const capabilityHeaders = [
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
  { key: "Cache-Control", value: "private, no-store, max-age=0" },
];

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
      { source: "/api/capture/:path*", headers: capabilityHeaders },
      { source: "/api/sign/:path*", headers: capabilityHeaders },
    ];
  },
};

module.exports = nextConfig;
