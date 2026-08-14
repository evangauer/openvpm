const CHECKOUT_REDIRECT_URL_MAX_LENGTH = 2048;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export function isSafeCheckoutRedirectUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > CHECKOUT_REDIRECT_URL_MAX_LENGTH ||
    value.trim() !== value ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return false;
  }

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const stripeOwnedHost =
      hostname === "stripe.com" || hostname.endsWith(".stripe.com");
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      stripeOwnedHost
    );
  } catch {
    return false;
  }
}
