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
import {
  providerHttpErrorDiagnostic,
  sanitizeProviderDiagnostic,
} from "./provider-diagnostics";

const TELNYX_BASE = "https://api.telnyx.com/v2";

export class TelnyxError extends Error {
  constructor(
    message: string,
    readonly status: number,
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
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TelnyxMutationUncertainError";
  }
}

async function telnyxMutation<T>(
  action: () => Promise<T>,
  uncertainMessage: string,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (
      error instanceof TelnyxError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408 &&
      error.status !== 429
    ) {
      throw error;
    }
    throw new TelnyxMutationUncertainError(uncertainMessage, error);
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
  body?: unknown,
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
    throw new TelnyxError(
      providerHttpErrorDiagnostic("Telnyx", res.status, json),
      res.status,
    );
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
  if (opts.areaCode)
    params.set("filter[national_destination_code]", opts.areaCode);
  const json = await telnyxRequest<{ data?: TelnyxAvailableNumber[] }>(
    "GET",
    `/available_phone_numbers?${params.toString()}`,
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
    .filter(
      (
        n,
      ): n is TelnyxAvailableNumber & {
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
        isCurrency(n.cost_information?.currency),
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
  phoneNumber: string,
): Promise<AvailableNumber[]> {
  const nationalNumber = phoneNumber.replace(/^\+1/, "").replace(/\D/g, "");
  const params = new URLSearchParams();
  params.set("filter[country_code]", "US");
  params.set("filter[features][]", "sms");
  params.set("filter[phone_number][starts_with]", nationalNumber);
  params.set("filter[limit]", "10");
  const json = await telnyxRequest<{ data?: TelnyxAvailableNumber[] }>(
    "GET",
    `/available_phone_numbers?${params.toString()}`,
  );
  return parseAvailableNumbers(json).filter(
    (number) => number.phoneNumber === phoneNumber,
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

export interface TelnyxMessagingProfileDetail extends TelnyxMessagingProfile {
  webhookApiVersion: string | null;
  whitelistedDestinations: string[] | null;
  dailySpendLimitEnabled: boolean | null;
  dailySpendLimit: string | null;
  smartEncoding: boolean | null;
}

export const OPENVPM_MESSAGING_PROFILE_DAILY_SPEND_LIMIT = "10.00";

export type TelnyxAutoresponseOperation = "start" | "stop" | "help";

export interface TelnyxMessagingProfileAutoresponse {
  id: string;
  operation: TelnyxAutoresponseOperation;
  keywords: string[];
  responseText: string;
  countryCode: string;
}

/** Runtime carrier behavior must match the clinic's registered program. */
export function messagingProfileAutoresponsesForClinic(input: {
  displayName: string;
  businessPhone: string;
}) {
  const displayName = input.displayName.trim();
  const businessPhone = input.businessPhone.trim();
  if (!displayName || !businessPhone) {
    throw new TelnyxError(
      "Clinic brand and support phone are required for auto-response policy.",
      400,
    );
  }
  return [
    {
      operation: "start",
      keywords: ["START", "UNSTOP", "YES"],
      responseText: `${displayName}: Your request to receive veterinary clinic service texts was received. Message frequency varies. Msg & data rates may apply. Consent is not a condition of purchase. Reply HELP for help or STOP to opt out.`,
      countryCode: "US",
    },
    {
      operation: "stop",
      keywords: [
        "STOP",
        "STOPALL",
        "STOP ALL",
        "UNSUBSCRIBE",
        "CANCEL",
        "END",
        "QUIT",
      ],
      responseText: `${displayName}: You are unsubscribed from veterinary clinic service texts. Reply START to request messages again.`,
      countryCode: "US",
    },
    {
      operation: "help",
      keywords: ["HELP", "INFO"],
      responseText: `${displayName} texting help: call ${businessPhone}. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out.`,
      countryCode: "US",
    },
  ] as const satisfies ReadonlyArray<{
    operation: TelnyxAutoresponseOperation;
    keywords: readonly string[];
    responseText: string;
    countryCode: "US";
  }>;
}

export type MessagingProfileAutoresponsePolicy = ReturnType<
  typeof messagingProfileAutoresponsesForClinic
>;

export const OPENVPM_MESSAGING_PROFILE_AUTORESPONSES =
  messagingProfileAutoresponsesForClinic({
    displayName: "OpenVPM test clinic",
    businessPhone: "+1 202 555 0100",
  });

export function openVpmMessagingProfileName(locationId: string): string {
  return `OpenVPM provision ${locationId}`;
}

function parseMessagingProfileDetail(
  payload:
    | {
        id?: string;
        name?: string;
        webhook_url?: string | null;
        enabled?: boolean;
        webhook_api_version?: string;
        whitelisted_destinations?: unknown;
        daily_spend_limit_enabled?: boolean;
        daily_spend_limit?: string;
        smart_encoding?: boolean;
      }
    | undefined,
  expectedId: string,
): TelnyxMessagingProfileDetail {
  if (!payload?.id || !payload.name || payload.id !== expectedId) {
    throw new TelnyxError(
      "The provider returned an incomplete or mismatched messaging profile.",
      502,
    );
  }
  const destinations = payload.whitelisted_destinations;
  return {
    id: payload.id,
    name: payload.name,
    webhookUrl: payload.webhook_url ?? null,
    enabled: payload.enabled ?? null,
    webhookApiVersion: payload.webhook_api_version ?? null,
    whitelistedDestinations:
      Array.isArray(destinations) &&
      destinations.every(
        (destination): destination is string => typeof destination === "string",
      )
        ? destinations
        : null,
    dailySpendLimitEnabled: payload.daily_spend_limit_enabled ?? null,
    dailySpendLimit: payload.daily_spend_limit ?? null,
    smartEncoding: payload.smart_encoding ?? null,
  };
}

export function messagingProfileSafetyIssues(
  profile: TelnyxMessagingProfileDetail,
  expected: {
    id: string;
    name: string;
    webhookUrl: string;
  },
): string[] {
  const issues: string[] = [];
  if (profile.id !== expected.id) issues.push("profile identity mismatch");
  if (profile.name !== expected.name) issues.push("profile name mismatch");
  if (profile.webhookUrl !== expected.webhookUrl) {
    issues.push("webhook URL mismatch");
  }
  if (profile.webhookApiVersion !== "2") {
    issues.push("webhook API version is not v2");
  }
  if (
    !profile.whitelistedDestinations ||
    profile.whitelistedDestinations.length !== 1 ||
    profile.whitelistedDestinations[0] !== "US"
  ) {
    issues.push("destination allowlist is not US-only");
  }
  if (profile.dailySpendLimitEnabled !== true) {
    issues.push("daily spend limit is not enabled");
  }
  if (
    profile.dailySpendLimit === null ||
    Number(profile.dailySpendLimit) !==
      Number(OPENVPM_MESSAGING_PROFILE_DAILY_SPEND_LIMIT)
  ) {
    issues.push("daily spend limit is not $10.00");
  }
  if (profile.smartEncoding !== true) {
    issues.push("smart encoding is not enabled");
  }
  return issues;
}

/** Retrieve one exact provider profile for launch-readiness checks. Read-only. */
export async function getMessagingProfile(
  profileId: string,
): Promise<TelnyxMessagingProfileDetail> {
  const json = await telnyxRequest<{
    data?: Parameters<typeof parseMessagingProfileDetail>[0];
  }>("GET", `/messaging_profiles/${encodeURIComponent(profileId)}`);
  return parseMessagingProfileDetail(json.data, profileId);
}

function parseMessagingProfileAutoresponses(
  data: unknown,
): TelnyxMessagingProfileAutoresponse[] {
  if (!Array.isArray(data)) {
    throw new TelnyxError(
      "The provider returned incomplete auto-response configuration data.",
      502,
    );
  }
  return data.map((entry) => {
    const row = entry as {
      id?: unknown;
      op?: unknown;
      keywords?: unknown;
      resp_text?: unknown;
      country_code?: unknown;
    };
    if (
      typeof row.id !== "string" ||
      !row.id.trim() ||
      typeof row.op !== "string" ||
      !new Set(["start", "stop", "help"]).has(row.op) ||
      !Array.isArray(row.keywords) ||
      !row.keywords.every(
        (keyword): keyword is string =>
          typeof keyword === "string" && Boolean(keyword.trim()),
      ) ||
      typeof row.resp_text !== "string" ||
      !row.resp_text.trim() ||
      typeof row.country_code !== "string" ||
      !row.country_code.trim()
    ) {
      throw new TelnyxError(
        "The provider returned an incomplete auto-response configuration.",
        502,
      );
    }
    return {
      id: row.id,
      operation: row.op as TelnyxAutoresponseOperation,
      keywords: row.keywords,
      responseText: row.resp_text,
      countryCode: row.country_code,
    };
  });
}

/** Read every configured carrier auto-response for one exact profile. */
export async function getMessagingProfileAutoresponses(
  profileId: string,
): Promise<TelnyxMessagingProfileAutoresponse[]> {
  // The endpoint exposes no documented page controls. Read its unfiltered
  // inventory so wildcard rules cannot hide, then accept only one complete
  // provider page. Extra/paginated state requires operator review.
  const json = await telnyxRequest<{
    data?: unknown;
    meta?: {
      page_number?: unknown;
      page_size?: unknown;
      total_pages?: unknown;
      total_results?: unknown;
    };
  }>(
    "GET",
    `/messaging_profiles/${encodeURIComponent(profileId)}/autoresp_configs`,
  );
  const rows = parseMessagingProfileAutoresponses(json.data);
  if (
    json.meta?.page_number !== 1 ||
    json.meta?.total_pages !== 1 ||
    json.meta?.total_results !== rows.length
  ) {
    throw new TelnyxError(
      "The provider returned an incomplete or paginated auto-response inventory.",
      502,
    );
  }
  return rows;
}

function sameKeywords(actual: string[], expected: readonly string[]): boolean {
  const normalized = actual.map((value) => value.trim().toUpperCase());
  return (
    normalized.length === new Set(normalized).size &&
    normalized.length === expected.length &&
    expected.every((value) => normalized.includes(value))
  );
}

function autoresponsePolicyLabel(operation: TelnyxAutoresponseOperation) {
  return operation;
}

export function messagingProfileAutoresponseSafetyIssues(
  configs: TelnyxMessagingProfileAutoresponse[],
  expectedPolicy: MessagingProfileAutoresponsePolicy,
): string[] {
  const issues: string[] = [];
  for (const expected of expectedPolicy) {
    const matches = configs.filter(
      (config) =>
        config.countryCode === expected.countryCode &&
        config.operation === expected.operation,
    );
    if (matches.length !== 1) {
      issues.push(
        `${autoresponsePolicyLabel(expected.operation)} auto-response is missing or duplicated`,
      );
      continue;
    }
    const [actual] = matches;
    if (
      actual?.responseText !== expected.responseText ||
      !sameKeywords(actual?.keywords ?? [], expected.keywords)
    ) {
      issues.push(
        `${autoresponsePolicyLabel(expected.operation)} auto-response does not match policy`,
      );
    }
  }
  if (
    configs.some(
      (config) =>
        !expectedPolicy.some(
          (expected) =>
            expected.operation === config.operation &&
            expected.countryCode === config.countryCode,
        ),
    )
  ) {
    issues.push("unexpected auto-response rule");
  }
  return issues;
}

async function createMessagingProfileAutoresponse(opts: {
  profileId: string;
  config: MessagingProfileAutoresponsePolicy[number];
}): Promise<void> {
  let json: { data?: unknown };
  try {
    json = await telnyxRequest(
      "POST",
      `/messaging_profiles/${encodeURIComponent(opts.profileId)}/autoresp_configs`,
      {
        op: opts.config.operation,
        keywords: [...opts.config.keywords],
        resp_text: opts.config.responseText,
        country_code: opts.config.countryCode,
      },
    );
  } catch (error) {
    if (
      !(error instanceof TelnyxError) ||
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500
    ) {
      throw new TelnyxMutationUncertainError(
        "The messaging-profile auto-response outcome is uncertain and must be reconciled before retrying.",
        error,
      );
    }
    throw error;
  }
  try {
    const [created] = parseMessagingProfileAutoresponses([json.data]);
    if (
      !created ||
      created.operation !== opts.config.operation ||
      created.countryCode !== opts.config.countryCode
    ) {
      throw new Error("mismatched auto-response identity");
    }
  } catch (error) {
    throw new TelnyxMutationUncertainError(
      "The provider accepted the auto-response request without returning verifiable state.",
      error,
    );
  }
}

/**
 * Idempotently install the exact clinic-specific carrier keyword contract.
 * Existing drift is never overwritten automatically: an operator must inspect
 * it before another provider mutation.
 */
export async function ensureMessagingProfileAutoresponses(
  profileId: string,
  options: {
    assertMutationAllowed?: () => void;
    expectedPolicy: MessagingProfileAutoresponsePolicy;
  },
): Promise<TelnyxMessagingProfileAutoresponse[]> {
  const before = await getMessagingProfileAutoresponses(profileId);
  const expectedPolicy = options.expectedPolicy;
  for (const expected of expectedPolicy) {
    const existing = before.filter(
      (config) =>
        config.countryCode === expected.countryCode &&
        config.operation === expected.operation,
    );
    if (existing.length > 1) {
      throw new TelnyxError(
        `The provider has duplicate ${autoresponsePolicyLabel(expected.operation)} auto-response settings.`,
        409,
      );
    }
    if (existing.length === 1) {
      if (
        existing[0]?.responseText !== expected.responseText ||
        !sameKeywords(existing[0]?.keywords ?? [], expected.keywords)
      ) {
        throw new TelnyxError(
          `The provider ${autoresponsePolicyLabel(expected.operation)} auto-response does not match OpenVPM policy.`,
          409,
        );
      }
      continue;
    }
    options.assertMutationAllowed?.();
    await createMessagingProfileAutoresponse({
      profileId,
      config: expected,
    });
  }

  const verified = await getMessagingProfileAutoresponses(profileId);
  const issues = messagingProfileAutoresponseSafetyIssues(
    verified,
    expectedPolicy,
  );
  if (issues.length > 0) {
    throw new TelnyxMutationUncertainError(
      `The provider auto-response readback is incomplete: ${issues.join("; ")}.`,
    );
  }
  return verified;
}

/** Find profiles by an exact, durable operation name. Read-only. */
export async function findMessagingProfilesByName(
  name: string,
): Promise<TelnyxMessagingProfile[]> {
  const params = new URLSearchParams();
  params.set("filter[name][eq]", name);
  params.set("page[size]", "100");
  const json = await telnyxRequest<{
    data?: Array<{
      id?: string;
      name?: string;
      webhook_url?: string | null;
      enabled?: boolean;
    }>;
    meta?: {
      page_number?: unknown;
      total_pages?: unknown;
      total_results?: unknown;
    };
  }>("GET", `/messaging_profiles?${params.toString()}`);

  if (
    !Array.isArray(json.data) ||
    json.meta?.page_number !== 1 ||
    json.meta?.total_pages !== 1 ||
    json.meta?.total_results !== json.data.length
  ) {
    throw new TelnyxError(
      "The provider returned incomplete or paginated messaging-profile reconciliation data.",
      502,
    );
  }
  const exactProfiles = json.data.filter((profile) => profile.name === name);
  if (exactProfiles.some((profile) => !profile.id)) {
    throw new TelnyxError(
      "The provider returned a messaging profile without a durable identity.",
      502,
    );
  }
  return exactProfiles
    .filter(
      (profile): profile is typeof profile & { id: string; name: string } =>
        Boolean(profile.id),
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
  customerReference: string,
): Promise<TelnyxNumberOrder[]> {
  const params = new URLSearchParams();
  params.set("filter[customer_reference]", customerReference);
  params.set("page[size]", "100");
  const json = await telnyxRequest<{
    data?: Array<{
      id?: string;
      status?: string;
      customer_reference?: string;
      messaging_profile_id?: string;
      phone_numbers?: Array<{ phone_number?: string }>;
    }>;
    meta?: {
      page_number?: unknown;
      total_pages?: unknown;
      total_results?: unknown;
    };
  }>("GET", `/number_orders?${params.toString()}`);

  if (
    !Array.isArray(json.data) ||
    json.meta?.page_number !== 1 ||
    json.meta?.total_pages !== 1 ||
    json.meta?.total_results !== json.data.length
  ) {
    throw new TelnyxError(
      "The provider returned incomplete or paginated number-order reconciliation data.",
      502,
    );
  }
  if (
    json.data.some((order) => order.customer_reference !== customerReference)
  ) {
    throw new TelnyxError(
      "The provider returned a number order for a different operation reference.",
      502,
    );
  }
  if (
    json.data.some(
      (order) =>
        !order.id ||
        !order.status ||
        !order.messaging_profile_id ||
        !Array.isArray(order.phone_numbers),
    )
  ) {
    throw new TelnyxError(
      "The provider returned an incomplete number-order identity.",
      502,
    );
  }
  return json.data
    .filter(
      (
        order,
      ): order is typeof order & {
        id: string;
        status: string;
        customer_reference: string;
        messaging_profile_id: string;
      } =>
        Boolean(order.id) &&
        Boolean(order.status) &&
        order.customer_reference === customerReference &&
        Boolean(order.messaging_profile_id),
    )
    .map((order) => ({
      id: order.id,
      status: order.status,
      customerReference: order.customer_reference,
      messagingProfileId: order.messaging_profile_id,
      phoneNumbers: order
        .phone_numbers!.map((number) => number.phone_number)
        .filter((number): number is string => Boolean(number)),
    }));
}

/** Find an account-owned phone number by exact E.164 value. Read-only. */
export async function findOwnedPhoneNumbers(
  phoneNumber: string,
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
      502,
    );
  }
  const exactNumbers = json.data.filter(
    (number) => number.phone_number === phoneNumber,
  );
  if (exactNumbers.some((number) => !number.id)) {
    throw new TelnyxError(
      "The provider returned a phone number without a durable identity.",
      502,
    );
  }
  return exactNumbers
    .filter(
      (
        number,
      ): number is typeof number & { id: string; phone_number: string } =>
        Boolean(number.id) && number.phone_number === phoneNumber,
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
  phoneNumber: string,
): Promise<HostedEligibility> {
  const json = await telnyxRequest<{
    phone_numbers?: Array<{
      eligible?: boolean;
      phone_number?: string;
      detail?: string;
    }>;
  }>("POST", "/messaging_hosted_number_orders/eligibility_numbers_check", {
    phone_numbers: [phoneNumber],
  });
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
      daily_spend_limit: OPENVPM_MESSAGING_PROFILE_DAILY_SPEND_LIMIT,
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
        error,
      );
    }
    throw error;
  }
  const id = json?.data?.id;
  if (!id) {
    throw new TelnyxMutationUncertainError(
      "The provider accepted the messaging-profile request without returning a durable identity.",
    );
  }
  return { id };
}

/** Explicitly change provider sending state; callers must perform readback. */
export async function updateMessagingProfileEnabled(opts: {
  profileId: string;
  enabled: boolean;
}): Promise<TelnyxMessagingProfileDetail> {
  let json: {
    data?: Parameters<typeof parseMessagingProfileDetail>[0];
  };
  try {
    json = await telnyxRequest(
      "PATCH",
      `/messaging_profiles/${encodeURIComponent(opts.profileId)}`,
      { enabled: opts.enabled },
    );
  } catch (error) {
    if (
      !(error instanceof TelnyxError) ||
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500
    ) {
      throw new TelnyxMutationUncertainError(
        "The messaging-profile activation outcome is uncertain and must be reconciled before retrying.",
        error,
      );
    }
    throw error;
  }
  try {
    return parseMessagingProfileDetail(json.data, opts.profileId);
  } catch (error) {
    throw new TelnyxMutationUncertainError(
      "The provider accepted the messaging-profile activation request without returning verifiable state.",
      error,
    );
  }
}

/** Delete an unused messaging profile created by an incomplete attempt. */
export async function deleteMessagingProfile(profileId: string): Promise<void> {
  await telnyxRequest(
    "DELETE",
    `/messaging_profiles/${encodeURIComponent(profileId)}`,
  );
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
        error,
      );
    }
    throw error;
  }
  if (!json?.data?.id) {
    throw new TelnyxMutationUncertainError(
      "The provider accepted the request without returning a durable order identity.",
    );
  }
  return { orderId: json.data.id, status: json.data.status ?? null };
}

/** Release a purchased number that could not be durably attached in OpenVPM. */
export async function deleteOwnedPhoneNumber(
  phoneNumberId: string,
): Promise<void> {
  await telnyxRequest(
    "DELETE",
    `/phone_numbers/${encodeURIComponent(phoneNumberId)}`,
  );
}

// --- A2P 10DLC registration --------------------------------------------------

export type TelnyxBrand = {
  brandId: string;
  identityStatus: string | null;
  status: string | null;
  failureReasons: string | null;
  displayName: string | null;
  entityType: string | null;
  country: string | null;
  companyName: string | null;
  website: string | null;
};

type TelnyxBrandPayload = {
  brandId?: string;
  identityStatus?: string;
  status?: string;
  failureReasons?: string;
  displayName?: string;
  entityType?: string;
  country?: string;
  companyName?: string;
  website?: string;
};

function parseBrand(payload: TelnyxBrandPayload | undefined): TelnyxBrand {
  const brandId = payload?.brandId;
  if (!brandId)
    throw new TelnyxError("Telnyx did not return an A2P brand id", 502);
  return {
    brandId,
    identityStatus: payload.identityStatus ?? null,
    status: payload.status ?? null,
    failureReasons: sanitizeProviderDiagnostic(payload.failureReasons, 1_000),
    displayName: payload.displayName ?? null,
    entityType: payload.entityType ?? null,
    country: payload.country ?? null,
    companyName: payload.companyName ?? null,
    website: payload.website ?? null,
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
  return telnyxMutation(async () => {
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
  }, "The carrier brand-creation outcome is uncertain. Reconcile provider state before any reviewed retry.");
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
  brandId: string | null;
};

type TelnyxCampaignPayload = {
  campaignId?: string;
  status?: string;
  campaignStatus?: string;
  submissionStatus?: string;
  referenceId?: string;
  failureReasons?: string;
  brandId?: string;
};

function parseCampaign(
  payload: TelnyxCampaignPayload | undefined,
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
    failureReasons: sanitizeProviderDiagnostic(payload.failureReasons, 1_000),
    brandId: payload.brandId ?? null,
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
  opts: A2pCampaignInput,
): Promise<TelnyxCampaign> {
  return telnyxMutation(async () => {
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
  }, "The carrier campaign-creation outcome is uncertain. Reconcile provider state before any reviewed retry.");
}

/** Read-only campaign reconciliation. */
export async function getA2pCampaign(
  campaignId: string,
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
  const matches = records.filter(
    (record) => record.referenceId === opts.referenceId,
  );
  if (matches.length > 1) {
    throw new TelnyxError(
      "The provider returned duplicate campaigns for the exact clinic reference.",
      409,
    );
  }
  const found = matches[0];
  if (!found) return null;
  const campaign = parseCampaign(found);
  if (campaign.brandId !== opts.brandId) {
    throw new TelnyxError(
      "The recovered campaign does not belong to the expected carrier brand.",
      409,
    );
  }
  return campaign;
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
  payload: TelnyxNumberAssignmentPayload | undefined,
): TelnyxNumberAssignment {
  if (!payload?.phoneNumber || !payload.campaignId) {
    throw new TelnyxError("Telnyx did not return a number assignment", 502);
  }
  return {
    phoneNumber: payload.phoneNumber,
    campaignId: payload.campaignId,
    assignmentStatus: payload.assignmentStatus ?? null,
    failureReasons: sanitizeProviderDiagnostic(payload.failureReasons, 1_000),
  };
}

export async function getA2pNumberAssignment(
  phoneNumber: string,
): Promise<TelnyxNumberAssignment | null> {
  try {
    const json = await telnyxRequest<
      TelnyxNumberAssignmentPayload & { data?: TelnyxNumberAssignmentPayload }
    >(
      "GET",
      `/10dlc/phone_number_campaigns/${encodeURIComponent(phoneNumber)}`,
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
        409,
      );
    }
    return existing;
  }
  return telnyxMutation(async () => {
    const json = await telnyxRequest<
      TelnyxNumberAssignmentPayload & { data?: TelnyxNumberAssignmentPayload }
    >("POST", "/10dlc/phone_number_campaigns", opts);
    return parseNumberAssignment(json.data ?? json);
  }, "The carrier number-assignment outcome is uncertain. Reconcile provider state before retrying.");
}
