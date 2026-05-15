import assert from "node:assert/strict";
import test from "node:test";

import { buildAuditRecord, hashAuditValue } from "../src/audit-log.mjs";

test("audit records keep Gemini write metadata without raw prompt or path", () => {
  const record = buildAuditRecord(
    {
      tool: "gemini_cdp_generate_image_and_save",
      requestId: "req-1",
      sessionName: "default",
      tabId: "tab-1",
      baseUrl: "http://127.0.0.1:9222",
      url: "https://gemini.google.com/app/private",
      ok: true,
      durationMs: 123,
      submit: true,
      messageHash: hashAuditValue("secret Thai prompt"),
      message: "secret Thai prompt",
      filePath: "C:/Users/suwit/Desktop/Test/private.png",
      fileSha256: "abc123",
      fileExtension: "png",
      fileLength: 42,
      savedMethod: "canvas_png_fallback",
      imageWidth: 1024,
      imageHeight: 1024,
    },
    new Date("2026-05-15T12:00:00.000Z"),
  );

  assert.equal(record.schemaVersion, 1);
  assert.equal(record.tool, "gemini_cdp_generate_image_and_save");
  assert.equal(record.baseUrlHash, hashAuditValue("http://127.0.0.1:9222"));
  assert.equal(record.urlHash, hashAuditValue("https://gemini.google.com/app/private"));
  assert.equal(record.savedMethod, "canvas_png_fallback");
  assert.equal(record.imageWidth, 1024);
  assert.equal(record.imageHeight, 1024);

  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes("secret Thai prompt"), false);
  assert.equal(serialized.includes("private.png"), false);
  assert.equal(serialized.includes("127.0.0.1:9222"), false);
  assert.equal(serialized.includes("gemini.google.com/app/private"), false);
});

test("audit records hash attachment filters", () => {
  const record = buildAuditRecord({
    tool: "gemini_cdp_remove_attachments",
    attachmentNameContains: "private-report.zip",
    removeAll: false,
    maxAttachments: 3,
    bindingWarningCodes: ["CDP_BINDING_URL_CHANGED"],
  });

  assert.equal(record.attachmentFilterHash, hashAuditValue("private-report.zip"));
  assert.equal(record.removeAll, false);
  assert.equal(record.maxAttachments, 3);
  assert.deepEqual(record.bindingWarningCodes, ["CDP_BINDING_URL_CHANGED"]);
  assert.equal(JSON.stringify(record).includes("private-report.zip"), false);
});
