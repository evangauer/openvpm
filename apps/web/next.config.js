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
    ];
  },
};

module.exports = nextConfig;
