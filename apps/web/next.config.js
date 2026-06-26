/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  transpilePackages: ["@openpims/api", "@openpims/db", "@openpims/email"],
};

module.exports = nextConfig;
