# Security Policy

## Supported Versions

OpenVPM is currently in early development. Security fixes are applied to the latest version on `main`.

| Version | Supported |
|---------|-----------|
| latest (main) | ✅ |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability, please report it by emailing **security@openvpm.com** with `[SECURITY]` in the subject line. We will acknowledge your report within 48 hours and provide a resolution timeline.

When reporting, please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce the issue
- Any proof-of-concept code (if applicable)

We follow a 90-day disclosure timeline: we ask that you give us 90 days to address the vulnerability before public disclosure. We will credit you in the fix unless you prefer to remain anonymous.

## Security Considerations for Self-Hosters

If you deploy OpenVPM on your own infrastructure:

- Generate a strong `NEXTAUTH_SECRET` using `openssl rand -base64 32`
- Never expose your PostgreSQL database publicly — keep it in a private network
- Use HTTPS in production — do not serve patient data over HTTP
- Rotate API keys and database credentials regularly
- Review the audit log (`audit_log` table) for unexpected activity
- Keep dependencies up to date (`pnpm update`)

## Known Security Properties

- Passwords are hashed with bcrypt using the repository's centrally configured cost
- All dashboard routes require an authenticated session
- Multi-tenant isolation combines tenant-scoped application queries with PostgreSQL row-level security
- Role-based access control includes Admin, Veterinarian, Technician, Front Desk, and read-only Viewer roles
- Security headers are set on all responses (X-Frame-Options, X-Content-Type-Options, etc.)
- Controlled substance logs are append-only with witness requirements
