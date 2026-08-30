# Downstream adoption evidence

This register distinguishes public project interest, downstream engineering use,
and verified clinic operation. Those are different claims. Stars, clones, forks,
or a deployment record must never be described as an active clinic.

## Evidence snapshot: 2026-08-30

The snapshot below was collected from the public GitHub repository and its
administrator-visible, aggregate GitHub traffic endpoint. It contains no clinic,
patient, client, staff, credential, domain, or application-log data.

Observation time: `2026-08-30T04:21:26Z`. GitHub's traffic window covered the
14 reported days from 2026-08-14 through 2026-08-27.

| Signal                    | Observed evidence                                                                                                                                                                                                                                        | What it proves                                                                          | What it does not prove                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Public interest           | 26 stars and 14 public forks                                                                                                                                                                                                                             | Multiple external accounts found the project worth saving or copying                    | Installation, evaluation, or clinic use                                                                               |
| External contribution     | `Dariogarofalo` authored two merged pull requests: [#33](https://github.com/evangauer/openvpm/pull/33) and [#91](https://github.com/evangauer/openvpm/pull/91)                                                                                           | At least one non-owner GitHub user account contributed accepted work                    | Identity verification, maintainer availability, or clinical use                                                       |
| Aggregate traffic         | GitHub reported 586 views from 111 unique viewers and 14,306 clones from 791 unique cloners in its rolling traffic window                                                                                                                                | Material discovery and automated or human repository retrieval                          | A count of people, installations, clinics, or retained users; the clone pattern is automation-heavy                   |
| Fork landscape            | Fourteen public forks existed. Two contained commits not in upstream `main`: the 70-commit `resonancevet/vetflow-emr` derivative and the one-commit `dr-mark26/openvpm` localization                                                                     | At least two downstream accounts changed the product rather than only copying it        | Whether either operator deployed it, used real data, retained users, or runs a clinic                                 |
| Downstream implementation | [`resonancevet/vetflow-emr`](https://github.com/resonancevet/vetflow-emr) was 70 commits ahead of upstream `main`, with work through 2026-08-17 across field workflow, SOAP records, backups, audit logging, inventory, estimates, and the client portal | A downstream account materially adapted the code for veterinary workflows               | Safety, regulatory compliance, current upstream compatibility, or real-patient use                                    |
| Downstream deployment     | The same fork recorded repeated successful GitHub/Vercel `Production` deployments, most recently for commit `8b797bc9` on 2026-08-17                                                                                                                     | A downstream production-labeled deployment pipeline completed                           | Public reachability or daily clinical operation; the recorded deployment URL currently requires Vercel authentication |
| Reachable derivative lead | An aggregate referrer led to a publicly reachable login endpoint whose page used OpenVPM's exact distinctive metadata description under a different product name. The domain is intentionally not published because the operator has not opted in        | Strong evidence that a rebranded OpenVPM derivative is reachable on the public internet | Operator identity, authorization, active accounts, real records, clinic use, security, or operational dependence      |
| Smaller adaptations       | [`dr-mark26/openvpm`](https://github.com/dr-mark26/openvpm) was one commit ahead with an AED currency change; other renamed forks existed without unique commits                                                                                         | Some downstream localization and product exploration                                    | Sustained use or clinic operation                                                                                     |
| Opt-in reports            | No issues using the `adoption` label had been submitted                                                                                                                                                                                                  | No operator had supplied the repository's privacy-safe adoption attestation             | That no private evaluation or deployment exists                                                                       |
| Releases                  | The repository had no GitHub Releases or release-asset downloads                                                                                                                                                                                         | No release-channel adoption can yet be measured                                         | That source checkouts or hosted use do not exist                                                                      |

Counts are point-in-time observations and will drift. GitHub traffic is aggregate,
short-lived, and susceptible to CI, bots, mirrors, security scanners, and repeated
fetches. Never add traffic counts to obtain a lifetime user count.

## Current classification

- **Confirmed:** at least one non-owner GitHub user account contributed accepted
  work, and two downstream accounts authored changes not present upstream.
- **Confirmed:** at least one downstream derivative has a successful
  production-labeled deployment history, and a separate rebranded derivative
  appears publicly reachable behind a login page.
- **Probable but not identity-verified:** these contribution and implementation
  patterns represent real people doing substantive work. GitHub account type and
  activity do not establish a person's identity, employer, or clinic role.
- **Not confirmed:** any veterinary clinic is using OpenVPM with real patient
  records or depending on it for daily operations.
- **Not confirmed:** any retained staff or client user, even on the reachable
  derivative. A login page is deployment evidence, not usage evidence.
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

## Adoption evidence ladder

Use the highest level supported by evidence; never infer the next level.

| Level | Classification       | Minimum evidence                                                          | Current status                        |
| ----- | -------------------- | ------------------------------------------------------------------------- | ------------------------------------- |
| 0     | Interest             | Star, view, clone, unchanged fork, or discussion visit                    | Confirmed                             |
| 1     | Evaluation           | Operator opt-in report of source/demo or synthetic evaluation             | Not confirmed                         |
| 2     | Downstream build     | Public unique commits or an authorized private implementation report      | Confirmed                             |
| 3     | Reachable deployment | Read-only reachability plus a product-specific provenance signal          | Confirmed lead; operator not attested |
| 4     | Real-data pilot      | Authorized operator attestation and the clinic-readiness pilot gates      | Not confirmed                         |
| 5     | Live clinic use      | Authorized attestation of daily operational dependence, recently verified | Not confirmed                         |

The project's current adoption claim is therefore **Level 3 evidence with no
operator attestation**, not an active-clinic claim. The next legitimate step is
an opt-in Level 1, 4, or 5 report from an authorized operator. Maintainers must
not probe accounts, attempt registration, inspect protected routes, or solicit
sensitive proof to advance the classification.

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
6. treat referrer domains and public login pages as leads only, and avoid
   publishing an unconsented deployment domain; and
7. do not contact downstream operators or publish their clinic identity without
   explicit authorization.
