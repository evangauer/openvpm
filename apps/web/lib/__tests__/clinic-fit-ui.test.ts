import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync("app/clinic-fit/page.tsx", "utf8");
const register = readFileSync("app/(auth)/register/page.tsx", "utf8");
const middleware = readFileSync("middleware.ts", "utf8");

describe("public clinic fit guidance", () => {
  it("states the connected pilot boundary without overclaiming", () => {
    expect(page).toContain("Ready now");
    expect(page).toContain("Setup or supported pilot");
    expect(page).toContain("Not available yet");
    expect(page).toContain("Offline charting");
    expect(page).toContain("Herd, group-treatment");
    expect(page).toContain("Production multi-location rollout");
    expect(page).toContain("Hosted texting");
    expect(page).toContain("Do not attach clinic exports");
    expect(page).toContain("buildClinicFitSignupUrl");
    expect(page).toContain("buildClinicFitDemoUrl");
    expect(page).toContain("await searchParams");
    expect(page.match(/href={clinicFitSignupUrl}/g)).toHaveLength(3);
    expect(page.match(/href={clinicFitDemoUrl}/g)).toHaveLength(2);
  });

  it("keeps the fit check optional and reachable before signup", () => {
    expect(register).toContain('href="/clinic-fit"');
    expect(register).toContain("Check clinic fit and rollout limits");
    expect(middleware).toContain('"/clinic-fit"');
  });
});
