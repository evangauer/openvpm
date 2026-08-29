import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertNextManifestInvariants,
  classifyArtifactFinding,
} from "./verify-secret-artifacts.mjs";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "openvpm-artifact-test-"));
  const build = path.join(root, "apps/web/.next");
  const server = path.join(build, "server");
  mkdirSync(path.join(server, "chunks"), { recursive: true });
  const environment = {
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: "generated-action-key",
    __NEXT_BUILD_ID: "build-id",
    __NEXT_PREVIEW_MODE_ENCRYPTION_KEY: "generated-encryption-key",
    __NEXT_PREVIEW_MODE_ID: "generated-preview-id",
    __NEXT_PREVIEW_MODE_SIGNING_KEY: "generated-signing-key",
  };
  writeFileSync(
    path.join(server, "middleware-manifest.json"),
    JSON.stringify({ middleware: { "/": { env: environment } } }),
  );
  writeFileSync(
    path.join(server, "server-reference-manifest.json"),
    JSON.stringify({
      encryptionKey: environment.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY,
    }),
  );
  writeFileSync(
    path.join(build, "prerender-manifest.json"),
    JSON.stringify({
      preview: {
        previewModeEncryptionKey:
          environment.__NEXT_PREVIEW_MODE_ENCRYPTION_KEY,
        previewModeId: environment.__NEXT_PREVIEW_MODE_ID,
        previewModeSigningKey: environment.__NEXT_PREVIEW_MODE_SIGNING_KEY,
      },
    }),
  );
  writeFileSync(path.join(build, "BUILD_ID"), "build-id\n");
  return { root, build, server, environment };
}

test("accepts only exact Next-generated manifest fields", () => {
  const value = fixture();
  try {
    const manifests = assertNextManifestInvariants(value.build);
    assert.equal(
      classifyArtifactFinding({
        finding: {
          RuleID: "generic-api-key",
          File: path.join(value.server, "middleware-manifest.json"),
          Secret: value.environment.__NEXT_PREVIEW_MODE_SIGNING_KEY,
        },
        manifests,
        artifactRoot: value.build,
        sourceRoot: value.root,
      }),
      "next-generated-manifest-value",
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects an unexpected middleware environment key", () => {
  const value = fixture();
  try {
    const file = path.join(value.server, "middleware-manifest.json");
    writeFileSync(
      file,
      JSON.stringify({
        middleware: {
          "/": { env: { ...value.environment, DATABASE_URL: "unexpected" } },
        },
      }),
    );
    assert.throws(
      () => assertNextManifestInvariants(value.build),
      /unexpected or missing build environment key/,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects prerender preview values that diverge from middleware", () => {
  const value = fixture();
  try {
    writeFileSync(
      path.join(value.build, "prerender-manifest.json"),
      JSON.stringify({
        preview: {
          previewModeEncryptionKey: "unexpected",
          previewModeId: value.environment.__NEXT_PREVIEW_MODE_ID,
          previewModeSigningKey:
            value.environment.__NEXT_PREVIEW_MODE_SIGNING_KEY,
        },
      }),
    );
    assert.throws(
      () => assertNextManifestInvariants(value.build),
      /do not exactly match/,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("distinguishes a parser marker from a complete private key", () => {
  const value = fixture();
  try {
    const file = path.join(value.server, "middleware.js");
    const begin = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
    const end = ["-----END ", "PRIVATE KEY-----"].join("");
    writeFileSync(file, `pkcs8 importKey PUBLIC KEY ${begin} parser`);
    const manifests = assertNextManifestInvariants(value.build);
    const finding = { RuleID: "private-key", File: file, Secret: "parser" };
    assert.equal(
      classifyArtifactFinding({
        finding,
        manifests,
        artifactRoot: value.build,
        sourceRoot: value.root,
      }),
      "next-private-key-parser-marker",
    );
    writeFileSync(
      file,
      `pkcs8 importKey PUBLIC KEY ${begin}\nQUJDREVGR0hJSktMTU5PUA==\n${end}`,
    );
    assert.equal(
      classifyArtifactFinding({
        finding,
        manifests,
        artifactRoot: value.build,
        sourceRoot: value.root,
      }),
      null,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("accepts only the generated Twilio export assignment", () => {
  const value = fixture();
  try {
    const file = path.join(value.server, "chunks/fixture.js");
    const source = path.join(
      value.root,
      "apps/web/node_modules/twilio/lib/rest/iam/v1",
    );
    mkdirSync(source, { recursive: true });
    writeFileSync(
      path.join(source, "getApiKeys.js"),
      "exports.GetApiKeysInstance = void 0; exports.GetApiKeysPage = void 0;",
    );
    writeFileSync(
      file,
      "a.GetApiKeysPage=void 0,a.GetApiKeysInstance=void 0; class GetApiKeysPage {} class GetApiKeysInstance {}",
    );
    const manifests = assertNextManifestInvariants(value.build);
    const base = {
      RuleID: "generic-api-key",
      File: file,
      Secret: ["a.", "Get", "Api", "Keys", "Instance", "=", "void"].join(""),
    };
    assert.equal(
      classifyArtifactFinding({
        finding: base,
        manifests,
        artifactRoot: value.build,
        sourceRoot: value.root,
      }),
      "pinned-twilio-route-constant",
    );
    assert.equal(
      classifyArtifactFinding({
        finding: { ...base, Secret: "a.GetApiKeysInstance=token" },
        manifests,
        artifactRoot: value.build,
        sourceRoot: value.root,
      }),
      null,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});
