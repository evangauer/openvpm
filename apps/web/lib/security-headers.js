const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  [
    "script-src 'self' 'unsafe-inline'",
    process.env.NODE_ENV === "development" ? "'unsafe-eval'" : null,
    "https://va.vercel-scripts.com",
  ]
    .filter(Boolean)
    .join(" "),
  "connect-src 'self' https://app.openvpm.com https://vitals.vercel-insights.com https://va.vercel-scripts.com",
  "worker-src 'self' blob:",
  process.env.NODE_ENV === "production" ? "upgrade-insecure-requests" : null,
]
  .filter(Boolean)
  .join("; ");

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: contentSecurityPolicy,
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "X-XSS-Protection",
    value: "1; mode=block",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
];

function applySecurityHeaders(response) {
  for (const { key, value } of securityHeaders) {
    response.headers.set(key, value);
  }
  return response;
}

module.exports = {
  contentSecurityPolicy,
  securityHeaders,
  applySecurityHeaders,
};
