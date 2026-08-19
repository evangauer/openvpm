# OpenVPM production launch control plane

Date: 2026-08-18
Status: Preview hardening in progress; unrestricted Production launch blocked

This is the short operational source of truth for the first real-clinic
launch. It contains no credentials, clinic contacts, or patient information.

## Approved architecture

### Database recovery

- Keep Supabase daily physical backups.
- Enable **7-day PITR on the Production project only** immediately before
  clinics are permitted to depend on OpenVPM for unrestricted daily work.
- Do not buy PITR for Preview.
- Current Supabase list price is approximately **$100/month per project** for
  7 days, billed hourly and outside the spend cap.
- PITR requires at least Small compute. If Production is still on Micro, the
  compute line rises from about $10 to $15/month (roughly $5/month incremental)
  and the resize must be scheduled because it incurs downtime.
- Review 14- or 28-day retention only after utilization, insurance, contracts,
  or recovery evidence justifies the added cost.

PITR protects Postgres rows and metadata. It does not restore attachment bytes
stored through object storage.

### Attachment and backup-object recovery

- Production's primary object store uses AWS S3.
- Use a **direct Cloudflare R2 Standard bucket in the Get Talky/OpenVPM-owned
  Cloudflare account** as the independent replica target.
- Do not rely on a second Vercel-managed store as the final independence
  control.
- R2's current Standard price is $0.015/GB-month after a 10 GB free allowance,
  with no egress fee. Initial OpenVPM replica cost should therefore be near
  zero; cost scales with stored bytes and operations rather than clinic count.
- The replica account must require MFA, block public access, enable object
  versioning/retention where supported, deny runtime deletion, and keep
  break-glass recovery credentials outside Vercel.
- Stage credentials with replication disabled, backfill one synthetic/pilot
  practice, reach 100% checksum-verified coverage, run the isolated loss drill,
  then widen the cohort.

### Transactional email

- Continue using Resend and the isolated `mail.openvpm.com` sending subdomain.
- SPF and DKIM records exist publicly. DMARC does not.
- Replace the revoked shared Resend key with separate Preview and Production
  sending keys restricted to the verified sending domain.
- Register separate signed webhook endpoints for Preview and Production.
- Subscribe to sent, delivered, delayed, bounced, complained, failed, and
  suppressed events. Keep open/click tracking disabled for clinic mail unless a
  documented privacy need changes that decision.
- A webhook signing secret is stored only in the matching Vercel environment.

### DMARC

- Create a monitored `dmarc@openvpm.com` Google Group or mailbox that routes to
  the responsible operator. A Group is preferred so responsibility is not tied
  to one person's mailbox.
- Initial Namecheap record:

  - Type: `TXT`
  - Host: `_dmarc`
  - Value: `v=DMARC1; p=none; rua=mailto:dmarc@openvpm.com; adkim=r; aspf=r; pct=100`
  - TTL: 30 minutes or automatic

- Do not add forensic `ruf` reporting.
- Collect and review reports before moving to `quarantine`, then `reject`.
- Require Gmail, Microsoft-hosted Outlook/Microsoft 365, and a consenting pilot
  clinic-domain message to show SPF, DKIM, and DMARC pass in raw headers.

### Release control and monitoring

- GitHub `main` already requires build, RLS, and CodeQL checks, but has no
  approval requirement and administrators can bypass protection.
- Add one independent collaborator, require one fresh approval, dismiss stale
  approvals, require approval of the last push, enforce protection for admins,
  and make that person the GitHub `Production` environment reviewer.
- Keep the exact-SHA Production release lock and typed migration confirmation.
- Existing `ntfy.sh` alert and heartbeat endpoints accept the application
  payload, but `ntfy.sh` is a notification sink rather than proof that a missed
  cron job will be detected.
- Use Healthchecks.io for the 15 scheduled-job dead-man checks. Its current free
  plan supports 20 checks; the Business plan supports 100 for $20/month when
  needed. Use the single Ping Key URL template documented in the hosted runbook
  and alert the operating mailbox/team.
- Retain PHI-free immediate operations alerts, but replace the public hosted
  notification topic with an authenticated team-owned destination before broad
  launch.

## Legal and operating scope requiring confirmation

Working launch scope:

- United States veterinary practices only.
- Online client payments only; no Stripe Terminal/card-present claim.
- OpenVPM is the clinical/operational record; connected calculation tools do
  not become autonomous medical decision makers.
- No unrestricted SMS until clinic consent, A2P registration, and delivery
  drills pass.
- No international clinic, currency, or privacy-law scope in the first launch.

Before launch, record each pilot clinic's state and have qualified counsel or a
privacy reviewer confirm at minimum:

- veterinary medical-record ownership, retention, amendment, and access rules;
- state breach-notification and consumer/privacy requirements;
- clinic terms, privacy notice, data-processing terms, and offboarding/export;
- Stripe Connect/PCI responsibility and refund/dispute wording;
- email/SMS consent and suppression behavior;
- incident contacts and notification decision authority;
- controlled-substance, prescribing, and audit-log boundaries; and
- AI/integration representations and human-review requirements.

This is a review intake, not legal advice.

## Promotion gate

Production remains closed until all of the following have evidence:

1. 7-day Production PITR is enabled and read back.
2. Independent R2 replication is at 100% for the approved cohort and the
   destructive synthetic recovery drill passes.
3. Resend Preview delivery and signed callbacks pass, followed by separately
   authorized Production configuration.
4. DMARC is published and real Gmail, Microsoft-hosted, and clinic-domain raw
   headers pass.
5. Independent GitHub review and protected-branch enforcement are active.
6. Every scheduled job has a dead-man heartbeat and the incident route is
   exercised.
7. Clinic state(s), legal/privacy reviewer, and incident contacts are recorded.
8. The Preview clinic walkthrough, billing close, security suite, and incident
   tabletop pass on the exact release candidate.
9. A named operator approves the migration-only release, then the exact
   application SHA, with rollback and post-deploy monitoring ready.
