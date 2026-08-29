# Secret scanning and exception review

OpenVPM uses overlapping controls because no single detector proves that a
repository or release is free of credentials.

## Live controls

As of 2026-08-29, the public GitHub repository has secret scanning, push
protection, Dependabot security updates, CodeQL, restricted Actions, required
action SHA pinning, read-only default workflow tokens, and disabled workflow PR
approval enabled. The live audit found zero open Dependabot, code-scanning, or
secret-scanning alerts.

GitHub's generic/non-provider and validity-check options are not available to
this user-owned public repository under the current product eligibility rules.
Validity checks also send a detected credential to its issuer to determine
whether it remains active. Do not treat those disabled fields as a scanning
failure or attempt to work around the repository eligibility boundary.

## CI source scan

The required `build` check downloads Gitleaks `8.30.1`, verifies the published
Linux x64 SHA-256 checksum, and then runs:

```bash
pnpm verify:secrets
```

The command copies Git-tracked and unignored candidate files into a mode-`0700`
temporary directory, omits the ignore file from that copy, and scans it with the
default Gitleaks rules and a 60-second bound. `.gitleaks.toml` excludes only
installed dependencies, VCS internals, generated build/cache output, coverage,
and browser-test output. CI therefore evaluates the exact source candidate
without local dependency or build noise.

The isolated scan copy contains no `.gitleaksignore`. The wrapper then compares
every redacted finding fingerprint with `.gitleaks-exceptions.json`.
This makes both new findings and stale suppressions fail CI. It never prints a
matched value, and its temporary report is deleted before the command exits.

After `pnpm build`, CI also runs:

```bash
pnpm verify:secret-artifacts
```

The artifact scan applies the default rules to `.next` while excluding only
cache, diagnostics, types, trace data, and the standalone directory that
duplicates the primary server bundle. It structurally classifies framework and
dependency false positives instead of ignoring their files:

- Next-generated action and preview values must occupy only the exact internal
  manifest fields; action-key copies, preview-key copies, and the build ID must
  agree, and no extra middleware or prerender preview key may exist.
- A private-key finding in middleware is accepted only as the key-parser marker
  with no PEM body or end marker.
- A generated Twilio API-route constant is accepted only when the exact value is
  also present in the installed, lockfile-pinned Twilio source.

Any other artifact finding fails with only its path, rule, and line. The raw
temporary report is mode-`0700`-contained and deleted before exit.

## Exception policy

`.gitleaksignore` must exactly mirror the machine-readable exception registry.
Each exception must:

- identify one exact `file:rule:line` fingerprint;
- name a GitHub owner;
- explain why the value is synthetic and non-deployable;
- record the review date; and
- expire no more than 120 days later.

The verifier rejects expired, duplicate, malformed, unregistered, and stale
exceptions. Never suppress a directory, file class, rule, or copied historical
fingerprint set to make CI green. Prefer changing a fixture so it no longer
resembles a credential when that does not weaken the test.

The initial nine exceptions cover only deterministic test fixtures: portal
rate-limit bucket hashes, a deliberately well-shaped fake API key, TOTP test
vectors, and an MFA secret paired with a stubbed test encryption key. Their
matched values are intentionally not reproduced in this document.

## Finding response

When the scan finds anything outside the reviewed set:

1. stop the release and keep the finding out of issues, chat, logs, screenshots,
   and pull-request comments;
2. determine whether it is synthetic without copying the matched value;
3. if exposure is possible, rotate or revoke first and preserve only redacted,
   PHI-free incident evidence;
4. remove the value from the current tree and assess reachable Git history;
5. add a narrow, expiring exception only for a proven synthetic fixture; and
6. rerun native GitHub scanning, Gitleaks, the build, and the clinic-readiness
   gate before release.

Issue [#267](https://github.com/evangauer/openvpm/issues/267) remains open for
the named incident commander, privacy/legal reviewer, notification authority,
and provider-specific tabletop drills.
