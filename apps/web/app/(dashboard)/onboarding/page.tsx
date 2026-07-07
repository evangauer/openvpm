import { redirect } from "next/navigation";

/**
 * The standalone onboarding page was retired in favor of the auto-opening
 * "Make it yours" setup wizard on the dashboard. Kept as a redirect stub so any
 * bookmarked or emailed links land somewhere sensible instead of 404ing.
 */
export default function OnboardingRedirectPage() {
  redirect("/");
}
