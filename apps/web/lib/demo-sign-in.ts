import { AUTH_EMAIL_MAX_LENGTH } from "./auth-input-policy";
import { DEMO_ROLE_OPTIONS, type DemoSwitcherRole } from "./demo-role-switcher";

type Input = { email: string; role: DemoSwitcherRole; anonymousId?: string };
type Dependencies = {
  fetch: typeof fetch;
  signIn: (
    provider: "demo",
    options: { role: DemoSwitcherRole; redirect: false },
  ) => Promise<{ ok?: boolean; error?: string | null } | undefined>;
};

/** The signed, server-issued gate must succeed before role authentication. */
export async function signInToDemo(input: Input, dependencies: Dependencies) {
  const email = input.email.trim().toLowerCase();
  if (
    !email ||
    email.length > AUTH_EMAIL_MAX_LENGTH ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new Error("Add a valid email address.");
  }
  if (!DEMO_ROLE_OPTIONS.some(({ value }) => value === input.role)) {
    throw new Error("Choose a demo role.");
  }
  const unavailable = "The demo is temporarily unavailable. Please try again.";
  // Call native browser fetch without binding the dependency bag as its receiver.
  const request = dependencies.fetch;
  let response: Response;
  try {
    response = await request("/api/demo-access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, anonymousId: input.anonymousId }),
    });
  } catch {
    throw new Error(unavailable);
  }
  const gate = (await response.json().catch(() => null)) as {
    ok?: boolean;
  } | null;
  if (!response.ok || !gate?.ok) {
    throw new Error(
      response.status === 429
        ? "Please wait a little before trying again."
        : unavailable,
    );
  }
  try {
    const result = await dependencies.signIn("demo", {
      role: input.role,
      redirect: false,
    });
    if (!result?.ok || result.error) throw new Error(unavailable);
  } catch {
    throw new Error(unavailable);
  }
}
