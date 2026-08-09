/**
 * Telnyx provisioning (v2 REST) for self-serve SMS onboarding. This module holds
 * the API integration; the messaging tRPC router orchestrates it and persists
 * results to `location_messaging`.
 *
 * Read-only operations (number and account inventory searches) are safe to call
 * anytime. Mutating operations (buy a number, register A2P brand/campaign)
 * spend money / require an L2-verified account and are added as the self-serve
 * flow is wired up.
 */

import { fetchTelnyx } from "./telnyx-http";
import { envValue } from "./env";

const TELNYX_BASE = "https://api.telnyx.com/v2";

export class TelnyxError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "TelnyxError";
  }
}

export class TelnyxNotConfiguredError extends Error {
  constructor() {
    super("Telnyx is not configured (TELNYX_API_KEY missing).");
    this.name = "TelnyxNotConfiguredError";
  }
}

/**
 * A mutating request may have reached Telnyx even though OpenVPM did not
 * receive a durable response. Callers must reconcile provider state before
 * considering another mutation.
 */
export class TelnyxMutationUncertainError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "TelnyxMutationUncertainError";
  }
}

function apiKey(): string {
  const key = envValue("TELNYX_API_KEY");
  if (!key) throw new TelnyxNotConfiguredError();
  return key;
}

/** Thin authed JSON request to the Telnyx v2 API. Throws TelnyxError on non-2xx. */
export async function telnyxRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetchTelnyx(`${TELNYX_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const json = text ? safeJson(text) : undefined;
  if (!res.ok) {
    throw new TelnyxError(telnyxErrorMessage(json) ?? `Telnyx ${res.status}`, res.status);
  }
  return json as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Telnyx returns `{ errors: [{ detail, title }] }` on failure. */
function telnyxErrorMessage(json: unknown): string | undefined {
  const errors = (json as { errors?: Array<{ detail?: string; title?: string }> })?.errors;
  if (!errors?.length) return undefined;
  return errors
    .map((e) => e.detail || e.title)
    .filter(Boolean)
    .join("; ");
}

export interface AvailableNumber {
  phoneNumber: string;
  upfrontCost: string;
  monthlyCost: string;
  currency: string;
}

/**
 * Search purchasable local numbers that support SMS, optionally by US area code.
 * Read-only.
 */
export async function searchAvailableNumbers(opts: {
  areaCode?: string;
  limit?: number;
}): Promise<AvailableNumber[]> {
  const params = new URLSearchParams();
  params.set("filter[country_code]", "US");
  params.set("filter[features][]", "sms");
  params.set("filter[limit]", String(Math.min(opts.limit ?? 10, 50)));
  if (opts.areaCode) params.set("filter[national_destination_code]", opts.areaCode);
  const json = await telnyxRequest<{ data?: TelnyxAvailableNumber[] }>(
    "GET",
    `/available_phone_numbers?${params.toString()}`
  );
  return parseAvailableNumbers(json);
}

interface TelnyxAvailableNumber {
  phone_number?: string;
  cost_information?: {
    upfront_cost?: string;
    monthly_cost?: string;
    currency?: string;
  };
}

function isProviderPrice(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d+(?:\.\d+)?$/.test(value) &&
    Number.isFinite(Number(value)) &&
    Number(value) >= 0
  );
}

function isCurrency(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

/** Pure: map a Telnyx available-numbers response to our shape. */
export function parseAvailableNumbers(json: {
  data?: TelnyxAvailableNumber[];
}): AvailableNumber[] {
  return (json.data ?? [])
    .filter((n): n is TelnyxAvailableNumber & {
      phone_number: string;
      cost_information: {
        upfront_cost: string;
        monthly_cost: string;
        currency: string;
      };
    } =>
      Boolean(n.phone_number) &&
      isProviderPrice(n.cost_information?.upfront_cost) &&
      isProviderPrice(n.cost_information?.monthly_cost) &&
      isCurrency(n.cost_information?.currency)
    )
    .map((n) => ({
      phoneNumber: n.phone_number,
      upfrontCost: n.cost_information.upfront_cost,
      monthlyCost: n.cost_information.monthly_cost,
      currency: n.cost_information.currency,
    }));
}

/**
 * Re-read the exact selected number immediately before purchase. An incomplete
 * or missing price is intentionally returned as no quote so callers fail
 * closed instead of authorizing an unknown charge.
 */
export async function findAvailableNumberQuotes(
  phoneNumber: string
): Promise<AvailableNumber[]> {
  const nationalNumber = phoneNumber.replace(/^\+1/, "").replace(/\D/g, "");
  const params = new URLSearchParams();
  params.set("filter[country_code]", "US");
  params.set("filter[features][]", "sms");
  params.set("filter[phone_number][starts_with]", nationalNumber);
  params.set("filter[limit]", "10");
  const json = await telnyxRequest<{ data?: TelnyxAvailableNumber[] }>(
    "GET",
    `/available_phone_numbers?${params.toString()}`
  );
  return parseAvailableNumbers(json).filter(
    (number) => number.phoneNumber === phoneNumber
  );
}

export interface HostedEligibility {
  eligible: boolean;
  detail?: string;
}

export interface TelnyxMessagingProfile {
  id: string;
  name: string;
  webhookUrl: string | null;
  enabled: boolean | null;
}

/** Find profiles by an exact, durable operation name. Read-only. */
export async function findMessagingProfilesByName(
  name: string
): Promise<TelnyxMessagingProfile[]> {
  const params = new URLSearchParams();
  params.set("filter[name][eq]", name);
  params.set("page[size]", "10");
  const json = await telnyxRequest<{
    data?: Array<{
      id?: string;
      name?: string;
      webhook_url?: string | null;
      enabled?: boolean;
    }>;
  }>("GET", `/messaging_profiles?${params.toString()}`);

  if (!Array.isArray(json.data)) {
    throw new TelnyxError(
      "The provider returned incomplete messaging-profile reconciliation data.",
      502
    );
  }
  const exactProfiles = json.data.filter((profile) => profile.name === name);
  if (exactProfiles.some((profile) => !profile.id)) {
    throw new TelnyxError(
      "The provider returned a messaging profile without a durable identity.",
      502
    );
  }
  return exactProfiles
    .filter(
      (profile): profile is typeof profile & { id: string; name: string } =>
        Boolean(profile.id)
    )
    .map((profile) => ({
      id: profile.id,
      name: profile.name,
      webhookUrl: profile.webhook_url ?? null,
      enabled: profile.enabled ?? null,
    }));
}

export interface OwnedPhoneNumber {
  id: string;
  phoneNumber: string;
  messagingProfileId: string | null;
  status: string | null;
}

export interface TelnyxNumberOrder {
  id: string;
  status: string;
  customerReference: string;
  messagingProfileId: string;
  phoneNumbers: string[];
}

/** Find exact provider orders for a durable operation reference. Read-only. */
export async function findNumberOrdersByCustomerReference(
  customerReference: string
): Promise<TelnyxNumberOrder[]> {
  const params = new URLSearchParams();
  params.set("filter[customer_reference]", customerReference);
  params.set("page[size]", "10");
  const json = await telnyxRequest<{
    data?: Array<{
      id?: string;
      status?: string;
      customer_reference?: string;
      messaging_profile_id?: string;
      phone_numbers?: Array<{ phone_number?: string }>;
    }>;
  }>("GET", `/number_orders?${params.toString()}`);

  if (!Array.isArray(json.data)) {
    throw new TelnyxError(
      "The provider returned incomplete number-order reconciliation data.",
      502
    );
  }
  if (
    json.data.some((order) => order.customer_reference !== customerReference)
  ) {
    throw new TelnyxError(
      "The provider returned a number order for a different operation reference.",
      502
    );
  }
  if (
    json.data.some(
      (order) =>
        !order.id ||
        !order.status ||
        !order.messaging_profile_id ||
        !Array.isArray(order.phone_numbers)
    )
  ) {
    throw new TelnyxError(
      "The provider returned an incomplete number-order identity.",
      502
    );
  }
  return json.data
    .filter(
      (order): order is typeof order & {
        id: string;
        status: string;
        customer_reference: string;
        messaging_profile_id: string;
      } =>
        Boolean(order.id) &&
        Boolean(order.status) &&
        order.customer_reference === customerReference &&
        Boolean(order.messaging_profile_id)
    )
    .map((order) => ({
      id: order.id,
      status: order.status,
      customerReference: order.customer_reference,
      messagingProfileId: order.messaging_profile_id,
      phoneNumbers: order.phone_numbers!
        .map((number) => number.phone_number)
        .filter((number): number is string => Boolean(number)),
    }));
}

/** Find an account-owned phone number by exact E.164 value. Read-only. */
export async function findOwnedPhoneNumbers(
  phoneNumber: string
): Promise<OwnedPhoneNumber[]> {
  const params = new URLSearchParams();
  params.set("filter[phone_number]", phoneNumber);
  params.set("page[size]", "10");
  const json = await telnyxRequest<{
    data?: Array<{
      id?: string;
      phone_number?: string;
      messaging_profile_id?: string | null;
      status?: string;
    }>;
  }>("GET", `/phone_numbers?${params.toString()}`);

  if (!Array.isArray(json.data)) {
    throw new TelnyxError(
      "The provider returned incomplete phone-number reconciliation data.",
      502
    );
  }
  const exactNumbers = json.data.filter(
    (number) => number.phone_number === phoneNumber
  );
  if (exactNumbers.some((number) => !number.id)) {
    throw new TelnyxError(
      "The provider returned a phone number without a durable identity.",
      502
    );
  }
  return exactNumbers
    .filter(
      (number): number is typeof number & { id: string; phone_number: string } =>
        Boolean(number.id) && number.phone_number === phoneNumber
    )
    .map((number) => ({
      id: number.id,
      phoneNumber: number.phone_number,
      messagingProfileId: number.messaging_profile_id ?? null,
      status: number.status ?? null,
    }));
}

/**
 * Check whether an existing number can be text-enabled (hosted SMS) without a
 * voice port. Read-only. Telnyx returns per-number eligibility; we collapse to a
 * single verdict for the given number.
 */
export async function checkHostedEligibility(
  phoneNumber: string
): Promise<HostedEligibility> {
  const json = await telnyxRequest<{
    phone_numbers?: Array<{
      eligible?: boolean;
      phone_number?: string;
      detail?: string;
    }>;
  }>(
    "POST",
    "/messaging_hosted_number_orders/eligibility_numbers_check",
    { phone_numbers: [phoneNumber] }
  );
  const row = (json.phone_numbers ?? [])[0];
  return {
    eligible: Boolean(row?.eligible),
    detail: row?.detail,
  };
}

// --- Mutating operations (spend money / change account state) ----------------

/** Create a messaging profile (sender pool + inbound webhook + A2P binding). */
export async function createMessagingProfile(opts: {
  name: string;
  webhookUrl: string;
}): Promise<{ id: string }> {
  let json: { data?: { id?: string } };
  try {
    json = await telnyxRequest("POST", "/messaging_profiles", {
      name: opts.name,
      enabled: false,
      webhook_url: opts.webhookUrl,
      webhook_api_version: "2",
      // Telnyx rejects new profiles without an explicit destination allowlist.
      // OpenVPM's supported hosted launch market is the United States.
      whitelisted_destinations: ["US"],
      // Bound pilot blast radius at the provider as well as in OpenVPM. Smart
      // encoding keeps common punctuation from unexpectedly multiplying parts.
      daily_spend_limit_enabled: true,
      daily_spend_limit: "10.00",
      smart_encoding: true,
    });
  } catch (error) {
    if (
      !(error instanceof TelnyxError) ||
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500
    ) {
      throw new TelnyxMutationUncertainError(
        "The messaging-profile outcome is uncertain and must be reconciled before retrying.",
        error
      );
    }
    throw error;
  }
  const id = json?.data?.id;
  if (!id) {
    throw new TelnyxMutationUncertainError(
      "The provider accepted the messaging-profile request without returning a durable identity."
    );
  }
  return { id };
}

/** Delete an unused messaging profile created by an incomplete attempt. */
export async function deleteMessagingProfile(profileId: string): Promise<void> {
  await telnyxRequest("DELETE", `/messaging_profiles/${encodeURIComponent(profileId)}`);
}

/** Purchase a new local number and assign it to a messaging profile. */
export async function buyNumber(opts: {
  phoneNumber: string;
  messagingProfileId: string;
  customerReference: string;
}): Promise<{ orderId: string; status: string | null }> {
  let json: { data?: { id?: string; status?: string } };
  try {
    json = await telnyxRequest("POST", "/number_orders", {
      phone_numbers: [{ phone_number: opts.phoneNumber }],
      messaging_profile_id: opts.messagingProfileId,
      customer_reference: opts.customerReference,
    });
  } catch (error) {
    if (
      !(error instanceof TelnyxError) ||
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500
    ) {
      throw new TelnyxMutationUncertainError(
        "The number order outcome is uncertain and must be reconciled before retrying.",
        error
      );
    }
    throw error;
  }
  if (!json?.data?.id) {
    throw new TelnyxMutationUncertainError(
      "The provider accepted the request without returning a durable order identity."
    );
  }
  return { orderId: json.data.id, status: json.data.status ?? null };
}

/** Release a purchased number that could not be durably attached in OpenVPM. */
export async function deleteOwnedPhoneNumber(phoneNumberId: string): Promise<void> {
  await telnyxRequest("DELETE", `/phone_numbers/${encodeURIComponent(phoneNumberId)}`);
}

// --- A2P 10DLC registration --------------------------------------------------

export type TelnyxBrand = {
  brandId: string;
  identityStatus: string | null;
  status: string | null;
  failureReasons: string | null;
};

type TelnyxBrandPayload = {
  brandId?: string;
  identityStatus?: string;
  status?: string;
  failureReasons?: string;
};

function parseBrand(payload: TelnyxBrandPayload | undefined): TelnyxBrand {
  const brandId = payload?.brandId;
  if (!brandId)
    throw new TelnyxError("Telnyx did not return an A2P brand id", 502);
  return {
    brandId,
    identityStatus: payload.identityStatus ?? null,
    status: payload.status ?? null,
    failureReasons: payload.failureReasons ?? null,
  };
}

/** Create a clinic's TCR brand. This incurs a provider registration charge. */
export async function createA2pBrand(opts: {
  entityType: "PRIVATE_PROFIT" | "NON_PROFIT";
  displayName: string;
  legalName: string;
  ein: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  website: string;
  webhookUrl: string;
}): Promise<TelnyxBrand> {
  const json = await telnyxRequest<
    TelnyxBrandPayload & { data?: TelnyxBrandPayload }
  >("POST", "/10dlc/brand", {
    entityType: opts.entityType,
    displayName: opts.displayName,
    companyName: opts.legalName,
    ein: opts.ein,
    firstName: opts.firstName,
    lastName: opts.lastName,
    email: opts.email,
    phone: opts.phone,
    street: opts.street,
    city: opts.city,
    state: opts.state,
    postalCode: opts.postalCode,
    country: "US",
    website: opts.website,
    vertical: "HEALTHCARE",
    isReseller: false,
    webhookURL: opts.webhookUrl,
  });
  return parseBrand(json.data ?? json);
}

/** Read-only brand reconciliation. */
export async function getA2pBrand(brandId: string): Promise<TelnyxBrand> {
  const json = await telnyxRequest<
    TelnyxBrandPayload & { data?: TelnyxBrandPayload }
  >("GET", `/10dlc/brand/${encodeURIComponent(brandId)}`);
  return parseBrand(json.data ?? json);
}

export type TelnyxCampaign = {
  campaignId: string;
  status: string | null;
  campaignStatus: string | null;
  submissionStatus: string | null;
  referenceId: string | null;
  failureReasons: string | null;
};

type TelnyxCampaignPayload = {
  campaignId?: string;
  status?: string;
  campaignStatus?: string;
  submissionStatus?: string;
  referenceId?: string;
  failureReasons?: string;
};

function parseCampaign(
  payload: TelnyxCampaignPayload | undefined
): TelnyxCampaign {
  const campaignId = payload?.campaignId;
  if (!campaignId) {
    throw new TelnyxError("Telnyx did not return an A2P campaign id", 502);
  }
  return {
    campaignId,
    status: payload.status ?? null,
    campaignStatus: payload.campaignStatus ?? null,
    submissionStatus: payload.submissionStatus ?? null,
    referenceId: payload.referenceId ?? null,
    failureReasons: payload.failureReasons ?? null,
  };
}

export type A2pCampaignInput = {
  brandId: string;
  referenceId: string;
  displayName: string;
  description: string;
  sample1: string;
  sample2: string;
  sample3: string;
  messageFlow: string;
  helpMessage: string;
  optinMessage: string;
  optoutMessage: string;
  privacyPolicyUrl: string;
  termsUrl: string;
  webhookUrl: string;
};

/** Submit a MIXED clinic communications campaign. Incurs provider charges. */
export async function createA2pCampaign(
  opts: A2pCampaignInput
): Promise<TelnyxCampaign> {
  const json = await telnyxRequest<
    TelnyxCampaignPayload & { data?: TelnyxCampaignPayload }
  >("POST", "/10dlc/campaignBuilder", {
    brandId: opts.brandId,
    usecase: "MIXED",
    description: opts.description,
    sample1: opts.sample1,
    sample2: opts.sample2,
    sample3: opts.sample3,
    messageFlow: opts.messageFlow,
    helpMessage: opts.helpMessage,
    optinMessage: opts.optinMessage,
    optoutMessage: opts.optoutMessage,
    optinKeywords: "START,YES,UNSTOP",
    optoutKeywords: "STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT",
    helpKeywords: "HELP,INFO",
    subscriberOptin: true,
    subscriberOptout: true,
    subscriberHelp: true,
    termsAndConditions: true,
    privacyPolicyLink: opts.privacyPolicyUrl,
    termsAndConditionsLink: opts.termsUrl,
    embeddedLink: true,
    embeddedPhone: true,
    numberPool: false,
    ageGated: false,
    directLending: false,
    autoRenewal: true,
    referenceId: opts.referenceId,
    webhookURL: opts.webhookUrl,
  });
  return parseCampaign(json.data ?? json);
}

/** Read-only campaign reconciliation. */
export async function getA2pCampaign(
  campaignId: string
): Promise<TelnyxCampaign> {
  const json = await telnyxRequest<
    TelnyxCampaignPayload & { data?: TelnyxCampaignPayload }
  >("GET", `/10dlc/campaign/${encodeURIComponent(campaignId)}`);
  return parseCampaign(json.data ?? json);
}

/** Locate a previous idempotent campaign submission by its reference id. */
export async function findA2pCampaignByReference(opts: {
  brandId: string;
  referenceId: string;
}): Promise<TelnyxCampaign | null> {
  const params = new URLSearchParams({
    brandId: opts.brandId,
    recordsPerPage: "500",
  });
  const json = await telnyxRequest<{
    records?: TelnyxCampaignPayload[];
    data?: { records?: TelnyxCampaignPayload[] };
  }>("GET", `/10dlc/campaign?${params.toString()}`);
  const records = json.records ?? json.data?.records ?? [];
  const found = records.find(
    (record) => record.referenceId === opts.referenceId
  );
  return found ? parseCampaign(found) : null;
}

export type TelnyxNumberAssignment = {
  phoneNumber: string;
  campaignId: string;
  assignmentStatus: string | null;
  failureReasons: string | null;
};

type TelnyxNumberAssignmentPayload = {
  phoneNumber?: string;
  campaignId?: string;
  assignmentStatus?: string;
  failureReasons?: string;
};

function parseNumberAssignment(
  payload: TelnyxNumberAssignmentPayload | undefined
): TelnyxNumberAssignment {
  if (!payload?.phoneNumber || !payload.campaignId) {
    throw new TelnyxError("Telnyx did not return a number assignment", 502);
  }
  return {
    phoneNumber: payload.phoneNumber,
    campaignId: payload.campaignId,
    assignmentStatus: payload.assignmentStatus ?? null,
    failureReasons: payload.failureReasons ?? null,
  };
}

export async function getA2pNumberAssignment(
  phoneNumber: string
): Promise<TelnyxNumberAssignment | null> {
  try {
    const json = await telnyxRequest<
      TelnyxNumberAssignmentPayload & { data?: TelnyxNumberAssignmentPayload }
    >(
      "GET",
      `/10dlc/phone_number_campaigns/${encodeURIComponent(phoneNumber)}`
    );
    return parseNumberAssignment(json.data ?? json);
  } catch (error) {
    if (error instanceof TelnyxError && error.status === 404) return null;
    throw error;
  }
}

/** Idempotently assign a number: read first, create only when absent. */
export async function ensureA2pNumberAssignment(opts: {
  phoneNumber: string;
  campaignId: string;
}): Promise<TelnyxNumberAssignment> {
  const existing = await getA2pNumberAssignment(opts.phoneNumber);
  if (existing) {
    if (existing.campaignId !== opts.campaignId) {
      throw new TelnyxError(
        "Phone number is already assigned to a different A2P campaign.",
        409
      );
    }
    return existing;
  }
  const json = await telnyxRequest<
    TelnyxNumberAssignmentPayload & { data?: TelnyxNumberAssignmentPayload }
  >("POST", "/10dlc/phone_number_campaigns", opts);
  return parseNumberAssignment(json.data ?? json);
}
