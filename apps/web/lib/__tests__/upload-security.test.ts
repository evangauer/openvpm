import { describe, expect, it } from "vitest";
import {
  contentDispositionForFile,
  detectUploadMimeType,
  isAllowedImageUploadMimeType,
  safeHeaderFilename,
  uploadBytesMatchMimeType,
} from "../upload-security";

describe("upload security helpers", () => {
  it("detects allowed upload formats from file signatures", () => {
    expect(detectUploadMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0x00]))).toBe(
      "image/jpeg"
    );
    expect(
      detectUploadMimeType(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      )
    ).toBe("image/png");
    expect(
      detectUploadMimeType(
        new Uint8Array([
          0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42,
          0x50,
        ])
      )
    ).toBe("image/webp");
    expect(
      detectUploadMimeType(new TextEncoder().encode("%PDF-1.7\n"))
    ).toBe("application/pdf");
  });

  it("identifies image MIME types allowed by browser upload surfaces", () => {
    expect(isAllowedImageUploadMimeType("image/jpeg")).toBe(true);
    expect(isAllowedImageUploadMimeType("image/png")).toBe(true);
    expect(isAllowedImageUploadMimeType("image/webp")).toBe(true);
    expect(isAllowedImageUploadMimeType("application/pdf")).toBe(false);
    expect(isAllowedImageUploadMimeType("image/gif")).toBe(false);
  });

  it("rejects declared MIME types that do not match the bytes", () => {
    const htmlPayload = new TextEncoder().encode("<html><script></script>");

    expect(uploadBytesMatchMimeType("image/png", htmlPayload)).toBe(false);
    expect(
      uploadBytesMatchMimeType(
        "text/html",
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      )
    ).toBe(false);
  });

  it("sanitizes filenames for response headers", () => {
    expect(safeHeaderFilename('../bad "name".pdf\r\n')).toBe(
      ".._bad__name_.pdf__"
    );
    expect(safeHeaderFilename("")).toBe("download");
  });

  it("uses inline disposition for images and attachment for private documents", () => {
    expect(
      contentDispositionForFile({
        filename: "logo.png",
        contentType: "image/png",
        isPublic: false,
      })
    ).toBe('inline; filename="logo.png"');
    expect(
      contentDispositionForFile({
        filename: "lab.pdf",
        contentType: "application/pdf",
        isPublic: false,
      })
    ).toBe('attachment; filename="lab.pdf"');
  });
});
