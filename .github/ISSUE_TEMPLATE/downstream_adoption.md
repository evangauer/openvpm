---
name: Downstream adoption report
about: Privacy-safe, opt-in evidence that you are evaluating or operating OpenVPM
title: "[Adoption] "
labels: adoption
assignees: ""
---

## Public disclosure warning

This issue is public. Do not include patient or client information, staff names,
medical records, screenshots containing application data, credentials, secrets,
private URLs or domains, database or object identifiers, or raw logs.

If even the existence of your evaluation or deployment is private, do not submit
this issue.

## Usage stage

Select one. A production-labeled deployment is not automatically live clinic use.

- [ ] Evaluating the source or demo
- [ ] Running locally with synthetic data
- [ ] Operating a controlled pilot with real clinic data
- [ ] Depending on OpenVPM for live clinic operations
- [ ] Building a downstream product or integration

## Version and deployment

- Exact OpenVPM commit or release:
- Deployment model: Docker / Vercel / other / prefer not to say
- First used (month and year is enough):

Do not provide a deployment URL.

## Veterinary workflows exercised

Check only workflows you have actually exercised.

- [ ] Scheduling and check-in
- [ ] Client and patient records
- [ ] SOAP or other clinical records
- [ ] Prescriptions or controlled substances
- [ ] Estimates, invoices, or payments
- [ ] Inventory
- [ ] Client portal or communications
- [ ] Backup and restore
- [ ] Migration from another PIMS
- [ ] Other, described below without sensitive data

## Coarse scale (optional)

Use ranges only. Do not name the practice or individual staff unless you are
explicitly authorized to publish that information.

- Locations: 1 / 2-5 / 6+ / prefer not to say
- Staff accounts: 1-5 / 6-20 / 21+ / prefer not to say
- Country or regulatory region (optional):

## What is working and what blocks adoption?

Describe product, workflow, integration, reliability, or documentation feedback.
Use synthetic examples and remove identifiers.

## Follow-up

- [ ] Maintainers may follow up with this GitHub account in this public issue.
- [ ] Maintainers may quote this report publicly with my GitHub handle.
- [ ] I prefer that this report be counted only in aggregate.

## Safety attestation

- [ ] I reviewed this issue and it contains no patient, client, staff, medical,
      credential, secret, private-domain, database, object, or raw-log data.
- [ ] I am authorized to make the usage claims above.
