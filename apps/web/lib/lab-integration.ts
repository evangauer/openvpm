export interface LabOrder {
  orderId: string;
  patientId: string;
  practiceId: string;
  provider: "idexx" | "antech" | "zoetis" | "in_house";
  testCodes: string[];
  status: "pending" | "submitted" | "in_progress" | "completed" | "cancelled";
  orderedAt: string;
  results?: LabResultItem[];
}

export interface LabResultItem {
  testName: string;
  resultValue: string;
  unit: string;
  referenceRangeLow?: string;
  referenceRangeHigh?: string;
  isAbnormal: boolean;
  flag?: "high" | "low" | "critical";
}

export interface LabProvider {
  name: string;
  id: "idexx" | "antech" | "zoetis" | "in_house";
  submitOrder(order: LabOrder): Promise<{ success: boolean; externalOrderId?: string }>;
  checkStatus(externalOrderId: string): Promise<LabOrder>;
  getResults(externalOrderId: string): Promise<LabResultItem[]>;
}

export class LabProviderNotConfiguredError extends Error {
  constructor(providerName: string) {
    super(
      `${providerName} lab integration is not configured. Use in-house/manual lab results or connect a real provider adapter before submitting external lab orders.`
    );
    this.name = "LabProviderNotConfiguredError";
  }
}

// In-house lab provider (for manual result entry)
export const inHouseProvider: LabProvider = {
  name: "In-House Lab",
  id: "in_house",
  async submitOrder(order) {
    return { success: true, externalOrderId: order.orderId };
  },
  async checkStatus(externalOrderId) {
    return {
      orderId: externalOrderId,
      patientId: "",
      practiceId: "",
      provider: "in_house",
      testCodes: [],
      status: "pending",
      orderedAt: new Date().toISOString(),
    };
  },
  async getResults() {
    return [];
  },
};

// External reference-lab providers are deliberately fail-closed until a real
// adapter and credentials are wired. Returning fake success here would create
// silent lab-order data loss in production.
function createUnconfiguredProvider(
  name: string,
  id: "idexx" | "antech" | "zoetis"
): LabProvider {
  return {
    name,
    id,
    async submitOrder(order) {
      void order;
      throw new LabProviderNotConfiguredError(name);
    },
    async checkStatus(externalOrderId) {
      void externalOrderId;
      throw new LabProviderNotConfiguredError(name);
    },
    async getResults(externalOrderId) {
      void externalOrderId;
      throw new LabProviderNotConfiguredError(name);
    },
  };
}

export const labProviders: Record<string, LabProvider> = {
  idexx: createUnconfiguredProvider("IDEXX VetConnect", "idexx"),
  antech: createUnconfiguredProvider("Antech Diagnostics", "antech"),
  zoetis: createUnconfiguredProvider("Zoetis Reference Labs", "zoetis"),
  in_house: inHouseProvider,
};

export function getProvider(id: string): LabProvider | undefined {
  return labProviders[id];
}
