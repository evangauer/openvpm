# Downstream adoption evidence

This register distinguishes public project interest, downstream engineering use,
and verified clinic operation. Those are different claims. Stars, clones, forks,
or a deployment record must never be described as an active clinic.

## Evidence snapshot: 2026-08-29

The snapshot below was collected from the public GitHub repository and its
administrator-visible, aggregate GitHub traffic endpoint. It contains no clinic,
patient, client, staff, credential, domain, or application-log data.

| Signal                    | Observed evidence                                                                                                                                                                                                                                        | What it proves                                                            | What it does not prove                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Public interest           | 26 stars and 14 public forks                                                                                                                                                                                                                             | Multiple external accounts found the project worth saving or copying      | Installation, evaluation, or clinic use                                                                               |
| External contribution     | `Dariogarofalo` authored two merged pull requests: [#33](https://github.com/evangauer/openvpm/pull/33) and [#91](https://github.com/evangauer/openvpm/pull/91)                                                                                           | At least one non-owner person contributed accepted work                   | Maintainer availability or clinical use                                                                               |
| Aggregate traffic         | GitHub reported 586 views from 111 unique viewers and 14,306 clones from 791 unique cloners in its rolling traffic window                                                                                                                                | Material discovery and automated or human repository retrieval            | A count of people, installations, clinics, or retained users; the clone pattern is automation-heavy                   |
| Downstream implementation | [`resonancevet/vetflow-emr`](https://github.com/resonancevet/vetflow-emr) was 70 commits ahead of upstream `main`, with work through 2026-08-17 across field workflow, SOAP records, backups, audit logging, inventory, estimates, and the client portal | A downstream account materially adapted the code for veterinary workflows | Safety, regulatory compliance, current upstream compatibility, or real-patient use                                    |
| Downstream deployment     | The same fork recorded repeated successful GitHub/Vercel `Production` deployments, most recently for commit `8b797bc9` on 2026-08-17                                                                                                                     | A downstream production-labeled deployment pipeline completed             | Public reachability or daily clinical operation; the recorded deployment URL currently requires Vercel authentication |
| Smaller adaptations       | [`dr-mark26/openvpm`](https://github.com/dr-mark26/openvpm) was one commit ahead with an AED currency change; other renamed forks existed without unique commits                                                                                         | Some downstream localization and product exploration                      | Sustained use or clinic operation                                                                                     |
| Releases                  | The repository had no GitHub Releases or release-asset downloads                                                                                                                                                                                         | No release-channel adoption can yet be measured                           | That source checkouts or hosted use do not exist                                                                      |

Counts are point-in-time observations and will drift. GitHub traffic is aggregate,
short-lived, and susceptible to CI, bots, mirrors, security scanners, and repeated
fetches. Never add traffic counts to obtain a lifetime user count.

## Current classification

- **Confirmed:** real external people are watching, forking, contributing to, and
  materially adapting OpenVPM.
- **Confirmed:** at least one downstream derivative has a successful
  production-labeled deployment history.
- **Not confirmed:** any veterinary clinic is using OpenVPM with real patient
  records or depending on it for daily operations.
- **Not confirmed:** any downstream deployment satisfies OpenVPM's current
  clinic-readiness, security, backup, tenancy, or recovery controls.

Until an authorized operator supplies an opt-in report, public language should
say "downstream implementations exist," not "clinics are live."

## Evidence standard for an active clinic

An active-clinic claim requires an authorized clinic or deployment operator to
provide all of the following without disclosing sensitive data:

1. the exact OpenVPM commit or release and deployment model;
2. a self-attested stage: evaluation, synthetic pilot, real-data pilot, or live
   operation;
3. the veterinary workflows actually exercised;
4. coarse, optional operating ranges such as one location or a staff-count band;
5. a date when the report was verified; and
6. explicit permission for the project to publish the chosen level of detail.

The report must not include patient or client information, staff identities,
medical records, credentials, private URLs, database identifiers, raw logs, or
screenshots containing application data. A maintainer records only the minimum
public claim authorized by the reporter.

Use the repository's **Downstream adoption report** issue template for opt-in
reports. Maintainers should close or redact reports that contain sensitive data
and must not copy sensitive content into another issue or audit artifact.

## Refresh procedure

Refresh this evidence before public adoption claims, fundraising diligence, or
a clinic-readiness review:

1. record the UTC observation time;
2. read repository stars, forks, contributors, pull requests, releases, and
   aggregate traffic through the GitHub API;
3. compare active public forks to upstream `main` and inspect only public commit
   metadata and deployment records;
4. classify each signal using the table above;
5. count opt-in adoption reports separately by evaluation, pilot, and live
   operation; and
6. do not contact downstream operators or publish their clinic identity without
   explicit authorization.
