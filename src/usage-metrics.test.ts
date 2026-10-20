import assert from "node:assert/strict";
import test from "node:test";
import {
  measureRequestPayload,
  measureResponsePayload,
} from "./usage-metrics.js";

test("request measurement canonicalizes object keys and counts UTF-8 bytes and Unicode scalars", () => {
  const measured = measureRequestPayload({ z: 1, emoji: "😀", a: "中" });

  assert.equal(measured.canonical, '{"a":"中","emoji":"😀","z":1}');
  assert.equal(measured.bytes, 32);
  assert.equal(measured.characters, 27);
  assert.equal(measured.tokenStatus, "FULL");
  assert.equal(measured.tokenText, measured.canonical);
});
test("response measurement includes only model-visible content and structuredContent", () => {
  const measured = measureResponsePayload({
    content: [{ type: "text", text: "ok" }],
    structuredContent: { result: "done" },
    _meta: { secret: "must-not-be-measured" },
    isError: false,
  });

  assert.equal(
    measured.canonical,
    '{"content":[{"text":"ok","type":"text"}],"structuredContent":{"result":"done"}}',
  );
  assert.doesNotMatch(measured.canonical, /secret|must-not-be-measured|isError/);
  assert.equal(measured.tokenStatus, "FULL");
  assert.equal(measured.tokenText, measured.canonical);
});

test("response measurement recursively excludes model-hidden _meta fields", () => {
  const measured = measureResponsePayload({
    content: [{
      type: "resource",
      resource: { uri: "memo://one", text: "visible", _meta: { secret: "RESOURCE-SECRET" } },
      _meta: { secret: "CONTENT-SECRET" },
    }],
    structuredContent: {
      visible: "ok",
      nested: { _meta: { secret: "STRUCTURED-SECRET" } },
    },
  });

  assert.doesNotMatch(
    `${measured.canonical}\n${measured.tokenText}`,
    /RESOURCE-SECRET|CONTENT-SECRET|STRUCTURED-SECRET|_meta/,
  );
  assert.match(measured.canonical, /visible/);
});

test("response measurement marks non-text content partial without tokenizing the unsupported block", () => {
  const measured = measureResponsePayload({
    content: [
      { type: "text", text: "caption" },
      { type: "image", data: "sensitive-base64", mimeType: "image/png" },
    ],
    structuredContent: { count: 1 },
  });

  assert.equal(measured.tokenStatus, "PARTIAL_UNSUPPORTED_MEDIA");
  assert.match(measured.canonical, /sensitive-base64/);
  assert.doesNotMatch(measured.tokenText, /sensitive-base64/);
  assert.equal(
    measured.tokenText,
    '{"content":[{"text":"caption","type":"text"},{"mimeType":"image/png","type":"image"}],"structuredContent":{"count":1}}',
  );
});

test("response measurement detects nested media in structured content without tokenizing its body", () => {
  const measured = measureResponsePayload({
    structuredContent: {
      caption: "visible",
      attachment: {
        type: "image",
        mimeType: "image/png",
        data: "PRIVATE-NESTED-BASE64",
      },
    },
  });

  assert.equal(measured.tokenStatus, "PARTIAL_UNSUPPORTED_MEDIA");
  assert.match(measured.canonical, /PRIVATE-NESTED-BASE64/);
  assert.doesNotMatch(measured.tokenText, /PRIVATE-NESTED-BASE64/);
  assert.match(measured.tokenText, /image\/png/);
  assert.match(measured.tokenText, /visible/);
});

test("response measurement tokenizes embedded text resources and excludes embedded blobs", () => {
  const measured = measureResponsePayload({
    content: [
      { type: "resource", resource: { uri: "memo://one", text: "resource text" } },
      { type: "resource", resource: { uri: "memo://two", blob: "PRIVATE-BLOB", mimeType: "application/octet-stream" } },
    ],
  });

  assert.equal(measured.tokenStatus, "PARTIAL_UNSUPPORTED_MEDIA");
  assert.match(measured.tokenText, /resource text/);
  assert.match(measured.tokenText, /application\/octet-stream/);
  assert.doesNotMatch(measured.tokenText, /PRIVATE-BLOB/);
});

test("measurement rejects non-JSON objects instead of traversing application instances", () => {
  assert.throws(
    () => measureRequestPayload({ createdAt: new Date("2026-10-18T00:00:00Z") }),
    (error) => (error as { code?: string }).code === "MEASUREMENT_UNSUPPORTED",
  );
});
