import { describe, expect, it } from "vitest";
import {
  OPENVPM_VERCEL_PROJECT,
  verifyVercelProjectIdentity,
} from "./verify-vercel-project";

describe("OpenVPM Vercel project identity", () => {
  it("accepts only the production OpenVPM project link", () => {
    expect(verifyVercelProjectIdentity(OPENVPM_VERCEL_PROJECT)).toEqual({
      ok: true,
    });
    expect(
      verifyVercelProjectIdentity({
        ...OPENVPM_VERCEL_PROJECT,
        projectId: "prj_wrong",
      }),
    ).toEqual({
      ok: false,
      issue: "Vercel project link does not match OpenVPM (projectId)",
    });
    expect(
      verifyVercelProjectIdentity({
        ...OPENVPM_VERCEL_PROJECT,
        projectName: "openvpm",
      }),
    ).toEqual({
      ok: false,
      issue: "Vercel project link does not match OpenVPM (projectName)",
    });
  });
});
