import { describe, expect, it } from "vitest";
import {
  UPLOAD_REQUEST_MAX_BYTES,
  uploadRequestContentLengthTooLarge,
} from "../upload-limits";

describe("upload request limits", () => {
  it("rejects oversized content-length headers", () => {
    expect(
      uploadRequestContentLengthTooLarge(
        new Headers({
          "content-length": String(UPLOAD_REQUEST_MAX_BYTES + 1),
        })
      )
    ).toBe(true);
    expect(
      uploadRequestContentLengthTooLarge(
        new Headers({
          "content-length": String(UPLOAD_REQUEST_MAX_BYTES),
        })
      )
    ).toBe(false);
  });
});
