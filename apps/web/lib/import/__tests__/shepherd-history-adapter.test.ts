import { describe, expect, it } from "vitest";
import { adaptShepherdHistory } from "../shepherd-history-adapter";
import type { ShepherdBundleRows } from "../shepherd-core-adapter";

function bundle(): ShepherdBundleRows {
  return {
    client: [
      { id: "owner-1", firstname: "River", lastname: "Stone" },
      { id: "owner-2", firstname: "Taylor", lastname: "Reed" },
    ],
    patient: [{ id: "patient-1", name: "Maple" }],
    client_patient: [{ clientid: "owner-1", patientid: "patient-1" }],
    client_coowner: [
      {
        clientid: "owner-1",
        firstname: "Morgan",
        lastname: "Stone",
        email: "morgan@example.test",
        smsnotification: "true",
      },
      {
        clientid: "missing-owner",
        firstname: "Casey",
        lastname: "Unknown",
        email: "casey@example.test",
      },
    ],
    client_coowner_phone: [
      {
        clientcoownerid: "owner-1",
        phonenumber: "+15555550100",
        isprimary: "true",
      },
    ],
    appointment: [
      {
        id: "visit-1",
        startdate: "2024-01-10T14:00:00Z",
        enddate: "2024-01-10T14:30:00Z",
        appointmenttypeid: "type-1",
        appointmentstatusid: "status-1",
        visitreason: "Wellness visit",
      },
    ],
    appointment_patient: [
      { appointmentid: "visit-1", patientid: "patient-1" },
    ],
    appointment_type: [{ id: "type-1", name: "Wellness" }],
    appointment_status: [{ id: "status-1", name: "Completed" }],
    product: [{ id: "product-1", name: "Medication Alpha" }],
    prescription: [
      {
        id: "rx-1",
        patientid: "patient-1",
        productid: "product-1",
        quantity: "not-a-number",
        direction: "Give as directed",
        datecreated: "2024-01-10T14:20:00Z",
        iswritten: "true",
      },
    ],
    refill: [
      {
        id: "fill-1",
        prescriptionid: "rx-1",
        datefilled: "2024-02-01T10:00:00Z",
        quantitydispensed: "bad-source-value",
      },
    ],
    lab_order: [
      {
        id: "lab-1",
        patientid: "patient-1",
        datecreated: "2024-01-10T14:15:00Z",
        orderid: "LAB-001",
      },
      { id: "lab-2", datecreated: "2024-01-11T14:15:00Z" },
    ],
    lab_media: [
      {
        id: "media-1",
        labintegrationorderid: "lab-1",
        dateupdated: "2024-01-12T10:00:00Z",
      },
    ],
    invoice: [
      {
        id: "invoice-1",
        clientid: "owner-1",
        dateissued: "2024-01-10T15:00:00Z",
        invoicenumber: "INV-1",
        subtotal: "100",
        tax: "8",
        discount: "0",
        total: "108",
        balance: "20",
        isinvoice: "true",
      },
    ],
    invoice_item: [
      {
        id: "line-1",
        invoiceid: "invoice-1",
        patientid: "patient-1",
        name: "Wellness service",
        productquantity: "1",
        price: "100",
        subtotal: "100",
        tax: "8",
        discount: "0",
        total: "108",
      },
    ],
    payment: [
      {
        id: "payment-1",
        clientid: "owner-1",
        amount: "88",
        paymentdate: "2024-01-10T16:00:00Z",
      },
      {
        id: "payment-2",
        clientid: "missing-owner",
        amount: "10",
        paymentdate: "2024-01-11T16:00:00Z",
      },
    ],
    payment_allocation: [
      {
        id: "allocation-1",
        invoiceid: "invoice-1",
        paymentid: "payment-1",
        closedamount: "88",
        closeddate: "2024-01-10T16:00:00Z",
      },
    ],
  };
}

describe("Shepherd history adapter", () => {
  it("preserves every supported source row and quarantines unresolved links", () => {
    const result = adaptShepherdHistory(bundle(), new Date("2025-01-01T00:00:00Z"));

    expect(result.coverage).toMatchObject({
      clientContacts: { sourceRows: 2, plannedRows: 2, errorRows: 0 },
      historicalAppointments: { sourceRows: 1, plannedRows: 1, errorRows: 0 },
      externalPrescriptions: { sourceRows: 1, plannedRows: 1, errorRows: 0 },
      externalPrescriptionFills: { sourceRows: 1, plannedRows: 1, errorRows: 0 },
      externalLabReports: { sourceRows: 2, plannedRows: 2, errorRows: 0 },
      legacyFinancialDocuments: { sourceRows: 1, plannedRows: 1, errorRows: 0 },
      legacyFinancialLineItems: { sourceRows: 1, plannedRows: 1, errorRows: 0 },
      legacyFinancialPayments: { sourceRows: 2, plannedRows: 2, errorRows: 0 },
      legacyFinancialAllocations: { sourceRows: 1, plannedRows: 1, errorRows: 0 },
    });
    expect(result.clientContacts[1]).toMatchObject({
      attributionStatus: "needs_review",
      externalClientId: undefined,
    });
    expect(result.externalLabReports[1]).toMatchObject({
      attributionStatus: "needs_review",
      externalPatientId: undefined,
    });
    expect(result.legacyFinancialPayments[1]).toMatchObject({
      attributionStatus: "needs_review",
      externalClientId: undefined,
    });
  });

  it("does not invent numeric medication evidence or actionable consent", () => {
    const result = adaptShepherdHistory(bundle());

    expect(result.externalPrescriptions[0]?.quantity).toBeUndefined();
    expect(result.externalPrescriptionFills[0]?.quantityDispensed).toBeUndefined();
    expect(result.clientContacts[0]).not.toHaveProperty("smsConsent");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          domain: "client_contacts",
          code: "source_notification_preferences_ignored",
          severity: "warning",
        }),
        expect.objectContaining({
          domain: "external_prescriptions",
          code: "invalid_source_amount",
          severity: "warning",
        }),
        expect.objectContaining({
          domain: "external_prescription_fills",
          code: "invalid_source_amount",
          severity: "warning",
        }),
      ]),
    );
  });

  it("maps a scalar lab row and keeps a panel in the archive report", () => {
    const source = bundle();
    source.lab_order = [
      {
        id: "lab-scalar",
        patientid: "patient-1",
        datecreated: "2024-01-10T14:15:00Z",
        orderid: "LAB-S",
        testname: "ALT",
        resultvalue: "42",
        resultunit: "U/L",
        referencerange: "10-40",
        resultflag: "H",
      },
      {
        id: "lab-panel",
        patientid: "patient-1",
        datecreated: "2024-01-11T14:15:00Z",
        orderid: "LAB-P",
        testname: "CBC",
        resultvalue: "WBC 5.1; RBC 6.2",
      },
    ];
    const result = adaptShepherdHistory(source, new Date("2025-01-01T00:00:00Z"));

    expect(result.externalLabObservations).toEqual([
      expect.objectContaining({
        externalLabReportId: "lab-scalar",
        name: "ALT",
        value: "42",
        unit: "U/L",
      }),
    ]);
    expect(result.coverage.externalLabObservations).toEqual({
      sourceRows: 2,
      plannedRows: 1,
      deferredRows: 1,
      excludedRows: 0,
      errorRows: 0,
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          domain: "external_lab_reports",
          code: "unstructured_lab_result",
        }),
      ]),
    );
  });

  it("keeps imported records separate from live operational concepts", () => {
    const result = adaptShepherdHistory(bundle());
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("appointmentRemindersEnabled");
    expect(serialized).not.toContain("stockQuantity");
    expect(serialized).not.toContain("invoiceStatus");
    expect(serialized).not.toContain("consentGranted");
  });
});
