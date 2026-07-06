import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UPLOAD_FILE_MAX_BYTES } from "../upload-limits";
import {
  IMAGE_UPLOAD_POLICY_MESSAGE,
  isImageUploadFileValid,
} from "../upload-policy";

describe("upload UI states", () => {
  const onboardingBranding = readFileSync(
    "components/onboarding/steps/branding.tsx",
    "utf8"
  );
  const settingsPage = readFileSync(
    "app/(dashboard)/settings/page.tsx",
    "utf8"
  );
  const patientDetail = readFileSync(
    "app/(dashboard)/patients/[id]/page.tsx",
    "utf8"
  );
  const imageUploadSources = [onboardingBranding, settingsPage, patientDetail];

  it("guards browser image uploads before calling the upload API", () => {
    expect(UPLOAD_FILE_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(IMAGE_UPLOAD_POLICY_MESSAGE).toContain("10 MB");
    expect(
      isImageUploadFileValid({
        size: UPLOAD_FILE_MAX_BYTES,
        type: "image/png",
      })
    ).toBe(true);
    expect(
      isImageUploadFileValid({
        size: UPLOAD_FILE_MAX_BYTES + 1,
        type: "image/png",
      })
    ).toBe(false);
    expect(
      isImageUploadFileValid({
        size: 128,
        type: "application/pdf",
      })
    ).toBe(false);

    for (const source of imageUploadSources) {
      expect(source).toContain('from "@/lib/upload-policy"');
      expect(source).toContain("isImageUploadFileValid(file)");
      expect(source).toContain("IMAGE_UPLOAD_POLICY_MESSAGE");
      expect(source).toContain('"/api/upload"');
      expect(source).toContain('accept="image/png,image/jpeg,image/webp"');
    }

    expect(onboardingBranding).toContain('body.append("category", "branding")');
    expect(settingsPage).toContain('body.append("category", "branding")');
    expect(patientDetail).toContain(
      'formData.append("category", "patient-photos")'
    );
    expect(patientDetail).not.toContain('accept="image/*"');
  });
});
