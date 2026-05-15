#!/usr/bin/env node
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { evaluateCdp, findCdpTab, withCdpTab } from "../src/cdp-client.mjs";

const args = new Set(process.argv.slice(2));
const rawArgs = process.argv.slice(2);
const requireCdp = args.has("--require-cdp");
const requireBinding = args.has("--require-binding");
const dryRunSend = args.has("--dry-run-send");
const uploadRemoveFile = valueAfterFlag(rawArgs, "--upload-remove-file");

const transport = new StdioClientTransport({
  command: "node",
  args: ["src/server.mjs"],
  cwd: process.cwd(),
});
const client = new Client({ name: "gemini-chrome-mcp-smoke", version: "0.0.0" });
await client.connect(transport);

function valueAfterFlag(values, flag) {
  const index = values.indexOf(flag);
  if (index === -1) return null;
  const value = values[index + 1];
  assert(value && !value.startsWith("--"), `${flag} requires a file path value`);
  return value;
}

async function clearComposerDraft(tabId) {
  if (!tabId) return { ok: false, errorCode: "BOUND_TAB_MISSING" };
  const tab = await findCdpTab({ tabId });
  return withCdpTab(tab, (session) => evaluateCdp(session, `(() => {
    const editor = document.querySelector('.ql-editor[contenteditable="true"][role="textbox"]');
    if (!editor) return { ok: false, errorCode: "COMPOSER_NOT_FOUND" };
    editor.focus();
    editor.textContent = "";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));
    const text = (editor.innerText || editor.textContent || "").trim();
    return { ok: text.length === 0, text };
  })()`));
}

try {
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.equal(names.length, 14, "unexpected MCP tool count");
  assert(names.includes("gemini_cdp_get_state"), "missing gemini_cdp_get_state");
  assert(names.includes("gemini_cdp_list_artifacts"), "missing gemini_cdp_list_artifacts");
  assert(names.includes("gemini_cdp_select_toolbox_mode"), "missing gemini_cdp_select_toolbox_mode");
  assert(names.includes("gemini_cdp_import_code_repository"), "missing gemini_cdp_import_code_repository");
  assert(names.includes("gemini_cdp_read"), "missing gemini_cdp_read");
  assert(names.includes("gemini_cdp_send_and_wait"), "missing gemini_cdp_send_and_wait");
  assert(names.includes("gemini_cdp_upload_file"), "missing gemini_cdp_upload_file");
  assert(names.includes("gemini_cdp_remove_attachments"), "missing gemini_cdp_remove_attachments");

  const status = await client.callTool({ name: "chrome_cdp_status", arguments: {} });
  const cdpAvailable = status.structuredContent?.ok === true;
  if (requireCdp) assert.equal(cdpAvailable, true, "CDP is required but unavailable");

  let bound = null;
  let state = null;
  let structured = null;
  let dryRun = null;
  let uploadRemove = null;
  if (cdpAvailable) {
    bound = await client.callTool({ name: "gemini_cdp_get_bound_tab", arguments: { sessionName: "default" } });
    const hasBoundTab = bound.structuredContent?.ok === true && Boolean(bound.structuredContent?.bound?.tabId);
    if (requireBinding) assert.equal(hasBoundTab, true, "default CDP binding is required but missing");
    if (hasBoundTab) {
      state = await client.callTool({
        name: "gemini_cdp_get_state",
        arguments: { sessionName: "default", strictBinding: true, maxChars: 1000 },
      });
      assert.equal(state.structuredContent?.ok, true, "strict bound Gemini state failed");
      structured = await client.callTool({
        name: "gemini_cdp_read",
        arguments: { sessionName: "default", strictBinding: true, mode: "structured", maxTurns: 3, maxCharsPerTurn: 500 },
      });
      assert.equal(structured.structuredContent?.ok, true, "structured Gemini read failed");
      if (dryRunSend) {
        const before = await client.callTool({
          name: "gemini_cdp_get_state",
          arguments: { sessionName: "default", strictBinding: true, maxChars: 1000 },
        });
        assert.equal(before.structuredContent?.state?.composerText || "", "", "dry-run send requires an empty composer");
        const message = "Gemini MCP dry-run smoke";
        let after = null;
        try {
          const sent = await client.callTool({
            name: "gemini_cdp_send",
            arguments: {
              sessionName: "default",
              strictBinding: true,
              messageBase64: Buffer.from(message, "utf8").toString("base64"),
              submit: false,
              replaceDraft: true,
            },
          });
          after = await client.callTool({
            name: "gemini_cdp_get_state",
            arguments: { sessionName: "default", strictBinding: true, maxChars: 1000 },
          });
          assert.equal(sent.structuredContent?.ok, true, "dry-run send failed");
          assert.equal(after.structuredContent?.state?.composerText, message, "dry-run send did not write expected draft");
        } finally {
          const cleanup = await clearComposerDraft(bound.structuredContent.bound.tabId);
          assert.equal(cleanup.ok, true, `dry-run cleanup failed: ${cleanup.errorCode ?? cleanup.text ?? "unknown"}`);
        }
        dryRun = { ok: true, composerText: after.structuredContent?.state?.composerText, cleanupOk: true };
      }
      if (uploadRemoveFile) {
        const before = await client.callTool({
          name: "gemini_cdp_get_state",
          arguments: { sessionName: "default", strictBinding: true, maxChars: 1000 },
        });
        assert.equal(before.structuredContent?.state?.attachmentCount ?? 0, 0, "upload/remove smoke requires no pending attachments");
        const upload = await client.callTool({
          name: "gemini_cdp_upload_file",
          arguments: { sessionName: "default", strictBinding: true, filePath: uploadRemoveFile, waitForUploadMs: 20000 },
        });
        assert.equal(upload.structuredContent?.ok, true, "upload smoke failed");
        const remove = await client.callTool({
          name: "gemini_cdp_remove_attachments",
          arguments: { sessionName: "default", strictBinding: true, removeAll: true },
        });
        assert.equal(remove.structuredContent?.ok, true, "remove attachment smoke failed");
        const after = await client.callTool({
          name: "gemini_cdp_get_state",
          arguments: { sessionName: "default", strictBinding: true, maxChars: 1000 },
        });
        assert.equal(after.structuredContent?.state?.attachmentCount ?? 0, 0, "upload/remove smoke left pending attachments");
        uploadRemove = {
          ok: true,
          attachmentCountAfterUpload: upload.structuredContent?.stateAfterUpload?.attachmentCount ?? null,
          attachmentCountAfterRemove: after.structuredContent?.state?.attachmentCount ?? null,
        };
      }
    }
  }

  console.log(JSON.stringify({
    ok: true,
    toolCount: names.length,
    cdpAvailable,
    boundTabId: bound?.structuredContent?.bound?.tabId ?? null,
    strictStateOk: state?.structuredContent?.ok ?? null,
    structuredReadOk: structured?.structuredContent?.ok ?? null,
    dryRunSend: dryRun,
    uploadRemove,
    warnings: state?.structuredContent?.bindingWarnings?.map((warning) => warning.code) ?? [],
  }, null, 2));
} finally {
  await client.close();
}
