import { describe, expect, it } from "vitest";
import type { DemoDataIds } from "../defaults";
import {
  hasLiveDemoData,
  mergeDemoDataProvenance,
} from "../demo-data-lifecycle";

function demoIds(prefix: string): DemoDataIds {
  return {
    clientIds: [`${prefix}-client`],
    patientIds: [`${prefix}-patient`],
    appointmentIds: [`${prefix}-appointment`],
    soapNoteIds: [`${prefix}-soap`],
    vaccinationIds: [`${prefix}-vaccination`],
    problemIds: [`${prefix}-problem`],
    invoiceIds: [`${prefix}-invoice`],
    invoiceItemIds: [`${prefix}-invoice-item`],
    communicationIds: [`${prefix}-communication`],
    productIds: [`${prefix}-product`],
  };
}

describe("demo data provenance", () => {
  it("retains every historical sample id when a clinic reseeds", () => {
    const historical = {
      ...demoIds("old"),
      clientIds: ["shared-client", "old-client"],
      clearedAt: "2026-08-09T12:00:00.000Z",
    };
    const latest = {
      ...demoIds("new"),
      clientIds: ["shared-client", "new-client"],
    };

    expect(mergeDemoDataProvenance(historical, latest)).toEqual({
      clientIds: ["shared-client", "old-client", "new-client"],
      patientIds: ["old-patient", "new-patient"],
      appointmentIds: ["old-appointment", "new-appointment"],
      soapNoteIds: ["old-soap", "new-soap"],
      vaccinationIds: ["old-vaccination", "new-vaccination"],
      problemIds: ["old-problem", "new-problem"],
      invoiceIds: ["old-invoice", "new-invoice"],
      invoiceItemIds: ["old-invoice-item", "new-invoice-item"],
      communicationIds: [
        "old-communication",
        "new-communication",
      ],
      productIds: ["old-product", "new-product"],
      clearedAt: null,
    });
  });

  it("only treats uncleared sample data as live", () => {
    const live = { ...demoIds("live"), clearedAt: null };
    const cleared = {
      ...demoIds("cleared"),
      clearedAt: "2026-08-09T12:00:00.000Z",
    };

    expect(hasLiveDemoData(live)).toBe(true);
    expect(hasLiveDemoData(cleared)).toBe(false);
    expect(hasLiveDemoData(undefined)).toBe(false);
  });
});
