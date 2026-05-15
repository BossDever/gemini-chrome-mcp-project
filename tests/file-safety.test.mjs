import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyLocalUploadFile } from "../src/file-safety.mjs";

async function writeTempFile(name, content) {
  const dir = await mkdir(path.join(os.tmpdir(), `gemini-file-safety-${process.pid}-${Date.now()}`), { recursive: true });
  const filePath = path.join(dir, name);
  await writeFile(filePath, content);
  return filePath;
}

test("verifyLocalUploadFile accepts normal small files and returns metadata", async () => {
  const filePath = await writeTempFile("note.txt", "hello Gemini");
  const result = await verifyLocalUploadFile(filePath);
  assert.equal(result.ok, true);
  assert.equal(result.safeForUpload, true);
  assert.equal(result.extension, ".txt");
  assert.equal(result.sizeBytes, 12);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});

test("verifyLocalUploadFile blocks executable-style extensions", async () => {
  const filePath = await writeTempFile("run.ps1", "Write-Host nope");
  const result = await verifyLocalUploadFile(filePath);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "UPLOAD_EXTENSION_BLOCKED");
  assert.equal(result.extension, ".ps1");
});

test("verifyLocalUploadFile blocks oversized files unless unsafe uploads are allowed", async () => {
  const filePath = await writeTempFile("large.txt", "123456");
  const blocked = await verifyLocalUploadFile(filePath, { maxBytes: 3 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.errorCode, "UPLOAD_FILE_TOO_LARGE");

  const allowed = await verifyLocalUploadFile(filePath, { maxBytes: 3, allowUnsafe: true });
  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.warnings, ["UPLOAD_FILE_TOO_LARGE"]);
});
