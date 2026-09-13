# A solo veterinarian's workflow

A clinic owner who performs both clinical and financial work should use their own **admin** account. Admins can document care and handle billing; the veterinarian role is intentionally clinical and does not automatically grant collection or refund permissions. Keep individual accounts for audit attribution, even in a small practice.

## Start from one patient

Open the patient chart, review prior notes, and attach outside PDFs or images in **Documents**. A lab PDF can be retained as a patient document without entering every result manually. An attachment is a source record; it does not automatically create structured lab values or perform clinical interpretation.

For a scheduled appointment, open its visit workspace. Use the same visit for notes, orders, charges, and closeout so its history stays connected.

## Optional field and ambulatory workflow

The installation operator must set `AMBULATORY_WORKSPACE_ENABLED=true` before this option appears. A clinic admin can then open Settings, enable **Ambulatory workspace**, choose measurement units/body-condition scale, and optionally enable **Compact closeout**. Save the settings.

An active patient chart then offers **Start field visit**, which opens a visit without requiring a separately booked appointment. The workspace brings clinical entry and **Charges and payment** together. Use **Bill now, finish notes later** when appropriate; the dashboard's **Unfinished field visits** list helps you return to incomplete documentation. Taking payment does not mean a clinical note has been completed or signed.

This is an optional field workflow, not an automatic permission change or a replacement for every scheduled-clinic workflow. If the setting is absent, check the deployment flag with the installation operator.

## Review weight history and correct a measurement

The patient's weight history combines standalone measurements with active weights recorded in visit vitals. Enter **Measured at** when recording an older weight; dates use the clinic timezone. Leave it blank for now. Future measurement times are rejected.

For a standalone measurement, an admin or veterinarian can choose **Correct**, enter the replacement in kilograms, its measurement time, and a reason. The original value remains preserved with the correction's author and reason in the audit history. For a weight originating in vitals, choose **Review vitals** and use that clinical record's correction workflow. A vital sign marked entered in error is excluded from the combined weight history; its original clinical record is retained.

## Complete a consultation

Record the examination and care, review the proposed charges, and reconcile them before presenting the invoice. As the owner/admin, you can perform these steps yourself without handing the visit to another staff member. A permission or reconciliation gate still applies even when one person performs all the work.

Take the configured card payment, record money received through another tender, or document an approved outstanding balance. Confirm the invoice's actual remaining balance. Then finish discharge instructions and follow-up, and complete/sign the clinical documentation as required by the visit.

A follow-up due date describes a care plan; it is not itself a booked appointment. Use **Schedule follow-up (opens new tab)**, book the appointment, then return and choose **Refresh appointments**. Select the actual appointment in closeout so the patient, client, and schedule remain linked. Keep the scheduling and visit records consistent before completing the visit.

## Check the clinic's setup before the first day

Run a synthetic patient through one complete consultation: document, add/reconcile charges, invoice, payment, discharge, and a booked follow-up. Confirm the resulting record and financial history. Test historical records and outside-document access using the staff roles you actually plan to use.

- [Upload patient documents and lab reports](upload-patient-documents.md)
- [Set up self-hosted Stripe payments](self-hosted-payments.md)
- [Set up self-hosted SMS](self-hosted-sms.md)
- [Your data: export, backup, and import](your-data.md)
