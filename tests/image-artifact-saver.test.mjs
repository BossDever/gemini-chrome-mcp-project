import assert from "node:assert/strict";
import test from "node:test";

import {
  extensionForMime,
  geminiGeneratedImageScript,
  sanitizeOutputFileName,
} from "../src/image-artifact-saver.mjs";

test("sanitizeOutputFileName removes path and shell special characters", () => {
  assert.equal(sanitizeOutputFileName("../bad:name?.png"), "..-bad-name-.png");
  assert.equal(sanitizeOutputFileName(""), "generated-image");
});

test("extensionForMime maps common image MIME types", () => {
  assert.equal(extensionForMime("image/png"), "png");
  assert.equal(extensionForMime("image/jpeg; charset=binary"), "jpg");
  assert.equal(extensionForMime("image/webp"), "webp");
});

test("Gemini generated image script includes blob scoring and canvas fallback", () => {
  const script = geminiGeneratedImageScript({ prefer: "auto" });
  assert.match(script, /gemini_blob/);
  assert.match(script, /download-generated-image-button/);
  assert.match(script, /canvas_png_fallback/);
});
