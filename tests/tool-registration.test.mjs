import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serverSource = readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");

function registeredToolNames() {
  return [...serverSource.matchAll(/server\.registerTool\(\s*\r?\n\s*"([^"]+)"/g)].map((match) => match[1]);
}

function toolBlock(toolName) {
  const marker = `server.registerTool(\r\n  "${toolName}"`;
  const normalizedSource = serverSource.replaceAll("\r\n", "\n");
  const normalizedMarker = marker.replaceAll("\r\n", "\n");
  const start = normalizedSource.indexOf(normalizedMarker);
  assert.notEqual(start, -1, `missing tool block for ${toolName}`);
  const next = normalizedSource.indexOf("\nserver.registerTool(", start + normalizedMarker.length);
  return normalizedSource.slice(start, next === -1 ? normalizedSource.length : next);
}

test("Gemini server registers the expected MCP tools", () => {
  assert.deepEqual(registeredToolNames(), [
    "chrome_cdp_status",
    "chrome_cdp_launch",
    "chrome_cdp_list_tabs",
    "gemini_cdp_prepare_session",
    "chrome_cdp_open_tab",
    "gemini_cdp_bind_tab",
    "gemini_cdp_get_bound_tab",
    "gemini_cdp_get_state",
    "gemini_cdp_read",
    "gemini_cdp_list_artifacts",
    "gemini_cdp_save_generated_image",
    "gemini_cdp_generate_image_and_save",
    "gemini_cdp_select_toolbox_mode",
    "gemini_cdp_import_code_repository",
    "gemini_cdp_remove_attachments",
    "gemini_cdp_upload_file",
    "gemini_cdp_send",
    "gemini_cdp_send_and_wait",
  ]);
});

test("Gemini write tools keep key safety and workflow schema fields", () => {
  const bind = toolBlock("gemini_cdp_bind_tab");
  assert.match(bind, /isGeminiUrl\(tab\.url\)/);
  assert.match(bind, /CDP_TAB_NOT_GEMINI/);

  const launch = toolBlock("chrome_cdp_launch");
  for (const key of ["port", "userDataDir", "chromePath", "url", "waitForReadyMs", "pollMs", "bindSessionName"]) {
    assert.match(launch, new RegExp(`\\b${key}:`), `missing ${key}`);
  }

  const prepare = toolBlock("gemini_cdp_prepare_session");
  for (const key of ["launchIfUnavailable", "openIfNoTab", "waitForReadyMs", "pollMs"]) {
    assert.match(prepare, new RegExp(`\\b${key}:`), `missing ${key}`);
  }

  const sendAndWait = toolBlock("gemini_cdp_send_and_wait");
  for (const key of [
    "messageBase64",
    "allowSuspiciousText",
    "replaceDraft",
    "force",
    "timeoutMs",
    "pollMs",
    "stableMs",
    "strictBinding",
  ]) {
    assert.match(sendAndWait, new RegExp(`\\b${key}:`), `missing ${key}`);
  }

  const upload = toolBlock("gemini_cdp_upload_file");
  assert.match(upload, /\bfilePath:/);
  assert.match(upload, /\bwaitForUploadMs:/);
  assert.match(upload, /\bstrictBinding:/);

  const remove = toolBlock("gemini_cdp_remove_attachments");
  assert.match(remove, /\battachmentNameContains:/);
  assert.match(remove, /\bremoveAll:/);
  assert.match(remove, /\bmaxAttachments:/);
  assert.match(remove, /ATTACHMENT_FILTER_REQUIRED/);

  const importRepo = toolBlock("gemini_cdp_import_code_repository");
  assert.match(importRepo, /\brepoUrl:/);
  assert.match(importRepo, /\ballowGithubConnect:/);
  assert.match(importRepo, /\bstrictBinding:/);
});

test("Gemini image workflow tools keep artifact preservation controls", () => {
  const saveImage = toolBlock("gemini_cdp_save_generated_image");
  for (const key of ["outputDir", "fileNamePrefix", "which", "prefer", "maxPixels", "waitForImageMs", "dryRun"]) {
    assert.match(saveImage, new RegExp(`\\b${key}:`), `missing ${key}`);
  }

  const generateImage = toolBlock("gemini_cdp_generate_image_and_save");
  for (const key of [
    "messageBase64",
    "fileNamePrefix",
    "prefer",
    "waitForImageMs",
    "pollMs",
    "selectImageMode",
    "dryRun",
    "strictBinding",
  ]) {
    assert.match(generateImage, new RegExp(`\\b${key}:`), `missing ${key}`);
  }
});
