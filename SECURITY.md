# Security Policy

## Supported Versions

OpenVPM is currently in early development. Security fixes are applied to the latest version on `main`.

| Version       | Supported |
| ------------- | --------- |
| latest (main) | ✅        |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability, please report it by emailing **security@openvpm.com** with `[SECURITY]` in the subject line. We will acknowledge your report within 48 hours and provide a resolution timeline.

When reporting, please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce the issue
- Any proof-of-concept code (if applicable)

We follow a 90-day disclosure timeline: we ask that you give us 90 days to address the vulnerability before public disclosure. We will credit you in the fix unless you prefer to remain anonymous.

## Operational Incidents

If you operate OpenVPM and suspect an active compromise, data-integrity event, or provider outage, stop releases and follow the [security incident response runbook](docs/security-incident-response.md). Do not place patient data, credentials, raw provider payloads, or private evidence locations in a public issue.

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
- Hosted privileged procedures require a separately signed, five-minute proof bound to the exact action, user, tenant, and current database session generation; PostgreSQL consumes the proof once in the same transaction as the operation
- WebAuthn passkeys require user verification, bind challenges to an exact relying-party ID and origin allowlist, persist only public credential material, and consume hashed five-minute challenges once; enrolled passkeys replace TOTP for login and privileged-action confirmation
- Security headers are set on all responses (X-Frame-Options, X-Content-Type-Options, etc.)
- Controlled substance logs are append-only with witness requirements

## Authentication Release Gate

OpenVPM supports TOTP, single-use recovery codes, and WebAuthn passkeys. TOTP remains the bootstrap path during migration, but it is a shared-secret factor and is not phishing-resistant. Once an account has an active passkey, login and privileged-action confirmation fail closed to passkey verification instead of silently falling back to TOTP. Hosted readiness also requires exact relying-party configuration, the `required` administrator/operator policy, and at least two active passkeys for every required identity.

Clinic launch remains blocked until the owner approves and tests a lost-authenticator recovery policy tracked in [issue #266](https://github.com/evangauer/openvpm/issues/266). There is intentionally no operator bypass or automatic downgrade to TOTP for an enrolled account. Required users should enroll at least two independent authenticators before enforcement; database-owner intervention is an emergency operational procedure, not a normal product recovery flow.
