# Three sample workflows to try

Follow one familiar task through OpenVPM before choosing a clinic pilot. Use
fictional data in an up-to-date test clinic. These exercises require an internet
connection. Keep real patient and client information out of a shared demo.

The public walkthrough is available at
[Sample workflows](https://app.openvpm.com/clinic-fit/workflows).

The shared demo may run an earlier release and may not show these newer
workflows. Use the current OpenVPM version for this walkthrough. If Documents or
Start field visit is absent, check the installation version and feature
availability before trying those steps.

## 1. Keep an outside record with the patient

1. Open **Patients**, choose a fictional patient, then open **Documents**.
2. Under **Add a patient document**, choose **External record**.
3. Upload the [synthetic sample PDF](https://app.openvpm.com/clinic-fit/workflows/synthetic-external-record.pdf).
4. Find the original filename, then view or download the file. Compare it with
   the original.

The sample file contains invented demonstration text and no real clinic,
patient, contacts, lab values, or treatment advice. It exists to test file
attachment and retrieval.

For an external lab attachment, choose **Lab report** and check the **Lab
reports** filter. Uploading a report does not extract results into structured lab
values. Accepted formats are PDF, JPG, PNG, and WebP, up to 4 MB per file.

If an upload cannot be confirmed, keep the page open and use **Retry upload** to
check and finish the same upload. Staff with write access can upload; viewers can
read and download.

[Full document guide](upload-patient-documents.md)

## 2. Follow visit work into the invoice

Use the clinic owner/admin role to evaluate clinical and billing tasks together.

1. Open a scheduled visit for a fictional patient and review its chart.
2. Document the sample visit and review the work performed.
3. Reconcile proposed service/product charges, including descriptions,
   quantities, and totals. If the case has a sample prescription, review its
   dispensing quantity and linked charges too.
4. Review the invoice and payment state, then return to the visit to finish
   closeout.

Check that recorded work and billing agree, and that unfinished documentation
stays visible. A follow-up due date is not a booked appointment; book the actual
visit before linking it in closeout. Keep this a sample billing review: do not
enter real card details or take a real payment in a test clinic.

[Solo-vet workflow guide](solo-vet-workflow.md)

## 3. Review a connected field visit

The optional ambulatory workspace requires both installation availability and a
clinic admin's **Ambulatory workspace** setting. If **Start field visit** is
absent, use a scheduled sample visit or ask the installation operator about
availability.

1. Open an active fictional patient and choose **Start field visit**.
2. Review the patient, location, and visit before entering sample work.
3. Review **Charges and payment** in that same visit.
4. If notes remain unfinished, return through **Unfinished field visits** on
   the dashboard.

**Bill now, finish notes later** keeps payment and clinical completion distinct.
The workflow is connected and patient based. Offline charting and herd/group
treatment are not supported.

[Clinic pilot readiness](../clinic-pilot-readiness.md)

## Make the result useful

Record what worked, where you stopped, and the one change that would make the
workflow useful. Share the steps and device without real patient or client data.
Keep your current PIMS in place while you validate an agreed pilot workflow.
