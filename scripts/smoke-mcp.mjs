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
const liveSendAndWait = args.has("--live-send-and-wait");
const generateImageSave = args.has("--generate-image-save");
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
  assert.equal(names.length, 17, "unexpected MCP tool count");
  assert(names.includes("chrome_cdp_launch"), "missing chrome_cdp_launch");
  assert(names.includes("gemini_cdp_get_state"), "missing gemini_cdp_get_state");
  assert(names.includes("gemini_cdp_list_artifacts"), "missing gemini_cdp_list_artifacts");
  assert(names.includes("gemini_cdp_save_generated_image"), "missing gemini_cdp_save_generated_image");
  assert(names.includes("gemini_cdp_generate_image_and_save"), "missing gemini_cdp_generate_image_and_save");
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
  let liveSend = null;
  let uploadRemove = null;
  let imageSave = null;
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
      if (liveSendAndWait) {
        const before = await client.callTool({
          name: "gemini_cdp_get_state",
          arguments: { sessionName: "default", strictBinding: true, maxChars: 1000 },
        });
        assert.equal(before.structuredContent?.state?.composerText || "", "", "live send requires an empty composer");
        assert.equal(before.structuredContent?.state?.attachmentCount ?? 0, 0, "live send requires no pending attachments");
        const runId = `gemini-mcp-live-${Date.now()}`;
        const message = `Reply with exactly this token and nothing else: ${runId}`;
        const sent = await client.callTool({
          name: "gemini_cdp_send_and_wait",
          arguments: {
            sessionName: "default",
            strictBinding: true,
            messageBase64: Buffer.from(message, "utf8").toString("base64"),
            replaceDraft: true,
            timeoutMs: 90000,
            pollMs: 1000,
            stableMs: 1500,
          },
        }, undefined, { timeout: 150000 });
        assert.equal(sent.structuredContent?.ok, true, "live send-and-wait failed");
        assert.equal(sent.isError ?? false, false, "live send-and-wait returned an MCP error");
        assert((sent.structuredContent?.lastAssistantTextLength ?? sent.structuredContent?.lastAssistantText?.length ?? 0) > 0, "live send-and-wait returned no assistant text");
        liveSend = {
          ok: true,
          wait: sent.structuredContent?.wait ?? null,
          lastAssistantTextHash: sent.structuredContent?.lastAssistantTextHash ?? null,
          finalTurnCount: sent.structuredContent?.finalState?.turnCount ?? null,
        };
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
      if (generateImageSave) {
        const runId = `gemini-smoke-${Date.now()}`;
        const generated = await client.callTool({
          name: "gemini_cdp_generate_image_and_save",
          arguments: {
            sessionName: "default",
            strictBinding: true,
            messageBase64: Buffer.from(
              `Create a square image for an MCP smoke test with the exact text "${runId}" centered.`,
              "utf8",
            ).toString("base64"),
            fileNamePrefix: runId,
            waitForImageMs: 300000,
            pollMs: 3000,
          },
        });
        assert.equal(generated.structuredContent?.ok, true, "generate image/save smoke failed");
        assert.equal(generated.isError ?? false, false, "generate image/save smoke returned an MCP error");
        assert(generated.structuredContent?.filePath, "generate image/save smoke did not return a file path");
        assert((generated.structuredContent?.byteLength ?? 0) > 0, "saved image is empty");
        imageSave = {
          ok: true,
          filePath: generated.structuredContent.filePath,
          method: generated.structuredContent.savedMethod,
          byteLength: generated.structuredContent.byteLength,
          width: generated.structuredContent.width,
          height: generated.structuredContent.height,
          warningCodes: (generated.structuredContent.warnings ?? []).map((warning) => warning.code),
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
    liveSendAndWait: liveSend,
    uploadRemove,
    imageSave,
    warnings: state?.structuredContent?.bindingWarnings?.map((warning) => warning.code) ?? [],
  }, null, 2));
} finally {
  await client.close();
}
