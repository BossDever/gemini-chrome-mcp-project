#!/usr/bin/env node
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { appendAuditLog } from "./audit-log.mjs";
import {
  cdpStatus,
  defaultChromeUserDataDir,
  defaultCdpBaseUrl,
  findCdpTab,
  generateCdpImageAndSave,
  getCdpState,
  importCdpCodeRepository,
  listCdpArtifacts,
  listCdpTabs,
  launchCdpChrome,
  openCdpTab,
  readCdpPage,
  removeCdpAttachments,
  saveCdpGeneratedImage,
  sendCdpMessage,
  sendCdpMessageAndWait,
  selectCdpToolboxMode,
  uploadCdpFile,
} from "./cdp-client.mjs";
import {
  isGeminiUrl,
  normalizeSessionName,
  readBoundCdpTarget,
  resolveBoundCdpTarget,
  writeBoundCdpTarget,
} from "./cdp-session-manager.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const auditDir = path.join(__dirname, "..", ".gemini-chrome-mcp", "audit");

function sha256(text) {
  return createHash("sha256").update(text ?? "", "utf8").digest("hex");
}

function withMeta(result, { requestId, startedAt }) {
  const finishedAt = new Date().toISOString();
  return {
    ...result,
    requestId: requestId ?? null,
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
  };
}

function looksSuspiciousEncodingLoss(text) {
  return /\?{5,}/.test(text || "");
}

function resolveMessageInput({ message, messageBase64, allowSuspiciousText = false }) {
  let resolved = message ?? "";
  if (messageBase64) {
    resolved = Buffer.from(messageBase64, "base64").toString("utf8");
  }
  if (!resolved) throw new Error("MESSAGE_REQUIRED");
  if (!allowSuspiciousText && looksSuspiciousEncodingLoss(resolved)) {
    throw new Error("SUSPICIOUS_ENCODING_LOSS");
  }
  return resolved;
}

async function auditCdpWrite(tool, result, context = {}) {
  try {
    const tab = result?.tab ?? context.tab ?? null;
    const binding = result?.binding ?? context.binding ?? null;
    await appendAuditLog(
      {
        tool,
        requestId: result?.requestId ?? context.requestId,
        sessionName: result?.sessionName ?? context.sessionName,
        tabId: tab?.id ?? result?.tabId ?? context.tabId ?? binding?.tabId,
        baseUrl: context.baseUrl ?? binding?.baseUrl,
        url: tab?.url,
        ok: Boolean(result?.ok),
        errorCode: result?.errorCode,
        durationMs: result?.durationMs,
        dryRun: result?.dryRun,
        submit: context.submit,
        messageHash: result?.messageHash ?? context.messageHash,
        fileSha256: result?.sha256 ?? context.fileSha256,
        fileExtension: result?.extension ?? context.fileExtension,
        fileLength: result?.byteLength ?? context.fileLength,
        savedMethod: result?.savedMethod,
        imageWidth: result?.width,
        imageHeight: result?.height,
        attachmentNameContains: context.attachmentNameContains,
        removeAll: context.removeAll,
        maxAttachments: context.maxAttachments,
        bindingWarningCodes: (result?.bindingWarnings ?? context.bindingWarnings ?? []).map((warning) => warning.code),
      },
      { auditDir },
    );
  } catch {
    // Audit is best-effort and must never change tool behavior.
  }
}

const server = new McpServer({ name: "gemini-chrome-mcp", version: "0.1.0" });

server.registerTool(
  "chrome_cdp_status",
  {
    title: "Check Chrome CDP status",
    inputSchema: { baseUrl: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ baseUrl }) => {
    const result = await cdpStatus({ baseUrl });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  },
);

server.registerTool(
  "chrome_cdp_launch",
  {
    title: "Launch dedicated CDP Chrome",
    inputSchema: {
      port: z.number().int().min(1024).max(65535).optional(),
      userDataDir: z.string().optional(),
      chromePath: z.string().optional(),
      url: z.string().optional(),
      waitForReadyMs: z.number().int().min(0).max(900000).optional(),
      pollMs: z.number().int().min(250).max(10000).optional(),
      bindSessionName: z.string().optional(),
      requestId: z.string().optional(),
    },
    annotations: { openWorldHint: true },
  },
  async ({ port = 9222, userDataDir = defaultChromeUserDataDir(), chromePath, url = "https://gemini.google.com/app", waitForReadyMs = 0, pollMs = 1000, bindSessionName, requestId }) => {
    const startedAt = new Date().toISOString();
    try {
      const result = await launchCdpChrome({ port, userDataDir, chromePath, url, waitForReadyMs, pollMs });
      let binding = null;
      if (bindSessionName && result.ready?.ready && result.ready?.tab?.id) {
        const normalizedSessionName = normalizeSessionName(bindSessionName);
        binding = {
          sessionName: normalizedSessionName,
          baseUrl: result.baseUrl,
          tabId: result.ready.tab.id,
          title: result.ready.tab.title,
          url: result.ready.tab.url,
          boundAt: new Date().toISOString(),
        };
        await writeBoundCdpTarget(normalizedSessionName, binding);
      }
      const nextStep = result.ready?.ready
        ? (binding ? `Ready and bound to session '${binding.sessionName}'.` : "Ready. Bind the Gemini tab before using CDP tools.")
        : "Log in to Gemini in the opened Chrome window, then tell the agent you are done so it can bind/check the tab.";
      const withTiming = withMeta({ ...result, binding, nextStep }, { requestId, startedAt });
      return {
        content: [{ type: "text", text: JSON.stringify(withTiming, null, 2) }],
        structuredContent: withTiming,
        isError: !result.ok,
      };
    } catch (error) {
      const result = withMeta(
        { ok: false, errorCode: "CDP_CHROME_LAUNCH_FAILED", error: error.message },
        { requestId, startedAt },
      );
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: true };
    }
  },
);

server.registerTool(
  "chrome_cdp_list_tabs",
  {
    title: "List Chrome CDP tabs",
    inputSchema: { baseUrl: z.string().optional(), includeNonPages: z.boolean().optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ baseUrl, includeNonPages = false }) => {
    const tabs = await listCdpTabs({ baseUrl, includeNonPages });
    const result = { ok: true, tabs };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  },
);

server.registerTool(
  "chrome_cdp_open_tab",
  {
    title: "Open Gemini tab through Chrome CDP",
    inputSchema: { baseUrl: z.string().optional(), url: z.string().optional() },
    annotations: { openWorldHint: true },
  },
  async ({ baseUrl, url = "https://gemini.google.com/app" }) => {
    const tab = await openCdpTab({ baseUrl, url });
    const result = { ok: true, tab };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  },
);

server.registerTool(
  "gemini_cdp_bind_tab",
  {
    title: "Bind Gemini CDP tab",
    inputSchema: {
      baseUrl: z.string().optional(),
      sessionName: z.string().optional(),
      tabId: z.string().optional(),
      titleContains: z.string().optional(),
      urlContains: z.string().optional(),
      requestId: z.string().optional(),
    },
    annotations: { readOnlyHint: false },
  },
  async ({ baseUrl, sessionName = "default", tabId, titleContains, urlContains = "gemini.google.com", requestId }) => {
    const startedAt = new Date().toISOString();
    const normalizedSessionName = normalizeSessionName(sessionName);
    const tab = await findCdpTab({ baseUrl, tabId, titleContains, urlContains });
    if (!isGeminiUrl(tab.url)) {
      throw new Error(`CDP_TAB_NOT_GEMINI: ${tab.url}`);
    }
    const binding = {
      sessionName: normalizedSessionName,
      baseUrl: baseUrl ?? defaultCdpBaseUrl(),
      tabId: tab.id,
      title: tab.title,
      url: tab.url,
      boundAt: new Date().toISOString(),
    };
    await writeBoundCdpTarget(normalizedSessionName, binding);
    const result = withMeta({ ok: true, sessionName: normalizedSessionName, binding, tab }, { requestId, startedAt });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  },
);

server.registerTool(
  "gemini_cdp_get_bound_tab",
  {
    title: "Get bound Gemini CDP tab",
    inputSchema: { sessionName: z.string().optional(), requestId: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ sessionName = "default", requestId }) => {
    const startedAt = new Date().toISOString();
    const normalizedSessionName = normalizeSessionName(sessionName);
    const bound = await readBoundCdpTarget(normalizedSessionName);
    const result = withMeta({ ok: true, sessionName: normalizedSessionName, bound }, { requestId, startedAt });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  },
);

server.registerTool(
  "gemini_cdp_get_state",
  {
    title: "Get Gemini CDP state",
    inputSchema: {
      baseUrl: z.string().optional(),
      sessionName: z.string().optional(),
      tabId: z.string().optional(),
      useBoundTab: z.boolean().optional(),
      strictBinding: z.boolean().optional(),
      maxChars: z.number().int().min(100).max(200000).optional(),
      requestId: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ baseUrl, sessionName = "default", tabId, useBoundTab = true, strictBinding = false, maxChars = 20000, requestId }) => {
    const startedAt = new Date().toISOString();
    try {
      const target = await resolveBoundCdpTarget({ baseUrl, tabId, useBoundTab, sessionName, strictBinding });
      const state = await getCdpState({ baseUrl: target.baseUrl, tabId: target.tabId, maxChars });
      const result = withMeta({ ...state, sessionName: target.sessionName, binding: target.binding, bindingWarnings: target.bindingWarnings }, { requestId, startedAt });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    } catch (error) {
      const result = withMeta({ ok: false, errorCode: "GEMINI_CDP_GET_STATE_FAILED", error: error.message }, { requestId, startedAt });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: true };
    }
  },
);

server.registerTool(
  "gemini_cdp_read",
  {
    title: "Read Gemini tab through CDP",
    inputSchema: {
      baseUrl: z.string().optional(),
      sessionName: z.string().optional(),
      tabId: z.string().optional(),
      useBoundTab: z.boolean().optional(),
      strictBinding: z.boolean().optional(),
      maxChars: z.number().int().min(100).max(200000).optional(),
      mode: z.enum(["raw", "structured", "combined"]).optional(),
      maxTurns: z.number().int().min(1).max(200).optional(),
      maxCharsPerTurn: z.number().int().min(100).max(100000).optional(),
      includeRawFallback: z.boolean().optional(),
      includeText: z.boolean().optional(),
      requestId: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ baseUrl, sessionName = "default", tabId, useBoundTab = true, strictBinding = false, maxChars = 20000, mode = "raw", maxTurns = 6, maxCharsPerTurn = 6000, includeRawFallback = false, includeText = true, requestId }) => {
    const startedAt = new Date().toISOString();
    try {
      const target = await resolveBoundCdpTarget({ baseUrl, tabId, useBoundTab, sessionName, strictBinding });
      const read = await readCdpPage({ baseUrl: target.baseUrl, tabId: target.tabId, maxChars, mode, maxTurns, maxCharsPerTurn, includeRawFallback, includeText });
      const result = withMeta({ ...read, sessionName: target.sessionName, binding: target.binding, bindingWarnings: target.bindingWarnings }, { requestId, startedAt });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    } catch (error) {
      const result = withMeta({ ok: false, errorCode: "GEMINI_CDP_READ_FAILED", error: error.message }, { requestId, startedAt });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: true };
    }
  },
);

server.registerTool(
  "gemini_cdp_list_artifacts",
  {
    title: "List visible Gemini image/download artifacts",
    inputSchema: {
      baseUrl: z.string().optional(),
      sessionName: z.string().optional(),
      tabId: z.string().optional(),
      useBoundTab: z.boolean().optional(),
      strictBinding: z.boolean().optional(),
      maxItems: z.number().int().min(1).max(200).optional(),
      requestId: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ baseUrl, sessionName = "default", tabId, useBoundTab = true, strictBinding = false, maxItems = 50, requestId }) => {
    const startedAt = new Date().toISOString();
    try {
      const target = await resolveBoundCdpTarget({ baseUrl, tabId, useBoundTab, sessionName, strictBinding });
      const artifacts = await listCdpArtifacts({ baseUrl: target.baseUrl, tabId: target.tabId, maxItems });
      const result = withMeta({ ...artifacts, sessionName: target.sessionName, binding: target.binding, bindingWarnings: target.bindingWarnings }, { requestId, startedAt });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    } catch (error) {
      const result = withMeta({ ok: false, errorCode: "GEMINI_CDP_LIST_ARTIFACTS_FAILED", error: error.message }, { requestId, startedAt });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: true };
    }
  },
);

server.registerTool(
  "gemini_cdp_save_generated_image",
  {
    title: "Save visible Gemini generated image",
    inputSchema: {
      baseUrl: z.string().optional(),
      sessionName: z.string().optional(),
      tabId: z.string().optional(),
      useBoundTab: z.boolean().optional(),
      strictBinding: z.boolean().optional(),
      outputDir: z.string().optional(),
      fileNamePrefix: z.string().optional(),
      which: z.enum(["newest", "largest", "index"]).optional(),
      index: z.number().int().min(0).max(200).optional(),
      prefer: z.enum(["auto", "source", "canvas"]).optional(),
      maxPixels: z.number().int().min(1).max(100000000).optional(),
      waitForImageMs: z.number().int().min(1000).max(300000).optional(),
      dryRun: z.boolean().optional(),
      lockTimeoutMs: z.number().int().min(5000).max(600000).optional(),
      requestId: z.string().optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ baseUrl, sessionName = "default", tabId, useBoundTab = true, strictBinding = false, outputDir, fileNamePrefix = "gemini-generated-image", which = "newest", index = 0, prefer = "auto", maxPixels = 4096 * 4096, waitForImageMs = 30000, dryRun = false, lockTimeoutMs = 120000, requestId }) => {
    const startedAt = new Date().toISOString();
    const auditContext = { sessionName, baseUrl, tabId };
    try {
      const target = await resolveBoundCdpTarget({ baseUrl, tabId, useBoundTab, sessionName, strictBinding });
      Object.assign(auditContext, { sessionName: target.sessionName, baseUrl: target.baseUrl, tabId: target.tabId, binding: target.binding, bindingWarnings: target.bindingWarnings });
      const saved = await saveCdpGeneratedImage({
        baseUrl: target.baseUrl,
        tabId: target.tabId,
        outputDir,
        fileNamePrefix,
        which,
        index,
        prefer,
        maxPixels,
        waitForImageMs,
        dryRun,
        lockTimeoutMs,
      });
      const result = withMeta({ ...saved, sessionName: target.sessionName, binding: target.binding, bindingWarnings: target.bindingWarnings }, { requestId, startedAt });
      await auditCdpWrite("gemini_cdp_save_generated_image", result, auditContext);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: !saved.ok };
    } catch (error) {
      const result = withMeta({ ok: false, errorCode: "GEMINI_CDP_SAVE_GENERATED_IMAGE_FAILED", error: error.message }, { requestId, startedAt });
      await auditCdpWrite("gemini_cdp_save_generated_image", result, auditContext);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: true };
    }
  },
);

server.registerTool(
  "gemini_cdp_generate_image_and_save",
  {
    title: "Generate a Gemini image and save it",
    inputSchema: {
      message: z.string().optional(),
      messageBase64: z.string().optional(),
      allowSuspiciousText: z.boolean().optional(),
      baseUrl: z.string().optional(),
      sessionName: z.string().optional(),
      tabId: z.string().optional(),
      useBoundTab: z.boolean().optional(),
      strictBinding: z.boolean().optional(),
      outputDir: z.string().optional(),
      fileNamePrefix: z.string().optional(),
      prefer: z.enum(["auto", "source", "canvas"]).optional(),
      maxPixels: z.number().int().min(1).max(100000000).optional(),
      waitForImageMs: z.number().int().min(10000).max(600000).optional(),
      pollMs: z.number().int().min(500).max(30000).optional(),
      selectImageMode: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      force: z.boolean().optional(),
      lockTimeoutMs: z.number().int().min(5000).max(600000).optional(),
      requestId: z.string().optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ message, messageBase64, allowSuspiciousText = false, baseUrl, sessionName = "default", tabId, useBoundTab = true, strictBinding = false, outputDir, fileNamePrefix = "gemini-generated-image", prefer = "auto", maxPixels = 4096 * 4096, waitForImageMs = 300000, pollMs = 3000, selectImageMode = true, dryRun = false, force = false, lockTimeoutMs = 180000, requestId }) => {
    const startedAt = new Date().toISOString();
    const auditContext = { sessionName, baseUrl, tabId, submit: true };
    try {
      const resolvedMessage = resolveMessageInput({ message, messageBase64, allowSuspiciousText });
      auditContext.messageHash = sha256(resolvedMessage);
      const target = await resolveBoundCdpTarget({ baseUrl, tabId, useBoundTab, sessionName, strictBinding });
      Object.assign(auditContext, { sessionName: target.sessionName, baseUrl: target.baseUrl, tabId: target.tabId, binding: target.binding, bindingWarnings: target.bindingWarnings });
      const generated = await generateCdpImageAndSave({
        baseUrl: target.baseUrl,
        tabId: target.tabId,
        message: resolvedMessage,
        outputDir,
        fileNamePrefix,
        prefer,
        maxPixels,
        waitForImageMs,
        pollMs,
        selectImageMode,
        dryRun,
        force,
        lockTimeoutMs,
      });
      const result = withMeta({ ...generated, sessionName: target.sessionName, binding: target.binding, bindingWarnings: target.bindingWarnings }, { requestId, startedAt });
      await auditCdpWrite("gemini_cdp_generate_image_and_save", result, auditContext);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: !generated.ok };
    } catch (error) {
      const result = withMeta({ ok: false, errorCode: "GEMINI_CDP_GENERATE_IMAGE_AND_SAVE_FAILED", error: error.message }, { requestId, startedAt });
      await auditCdpWrite("gemini_cdp_generate_image_and_save", result, auditContext);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: true };
    }
  },
);

server.registerTool(
  "gemini_cdp_select_toolbox_mode",
  {
    title: "Select Gemini toolbox mode",
    inputSchema: {
      mode: z.enum(["image", "video", "music", "canvas", "deep_research", "guided_learning"]),
      baseUrl: z.string().optional(),
      sessionName: z.string().optional(),
      tabId: z.string().optional(),
      useBoundTab: z.boolean().optional(),
      strictBinding: z.boolean().optional(),
      lockTimeoutMs: z.number().int().min(1000).max(120000).optional(),
      requestId: z.string().optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ mode, baseUrl, sessionName = "default", tabId, useBoundTab = true, strictBinding = false, lockTimeoutMs = 30000, requestId }) => {
    const startedAt = new Date().toISOString();
    const auditContext = { sessionName, baseUrl, tabId };
    try {
      const target = await resolveBoundCdpTarget({ baseUrl, tabId, useBoundTab, sessionName, strictBinding });
      Object.assign(auditContext, { sessionName: target.sessionName, baseUrl: target.baseUrl, tabId: target.tabId, binding: target.binding, bindingWarnings: target.bindingWarnings });
      const selected = await selectCdpToolboxMode({ baseUrl: target.baseUrl, tabId: target.tabId, mode, lockTimeoutMs });
      const result = withMeta({ ...selected, sessionName: target.sessionName, binding: target.binding, bindingWarnings: target.bindingWarnings }, { requestId, startedAt });
      await auditCdpWrite("gemini_cdp_select_toolbox_mode", result, auditContext);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: !selected.ok };
    } catch (error) {
      const result = withMeta({ ok: false, errorCode: "GEMINI_CDP_SELECT_TOOLBOX_MODE_FAILED", error: error.message }, { requestId, startedAt });
      await auditCdpWrite("gemini_cdp_select_toolbox_mode", result, auditContext);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: true };
    }
  },
);

server.registerTool(
  "gemini_cdp_import_code_repository",
  {
    title: "Import GitHub repository to Gemini through CDP",
    inputSchema: {
      repoUrl: z.string(),
      waitForImportMs: z.number().int().min(1000).max(120000).optional(),
      allowGithubConnect: z.boolean().optional(),
      force: z.boolean().optional(),
      baseUrl: z.string().optional(),
      sessionName: z.string().optional(),
      tabId: z.string().optional(),
      useBoundTab: z.boolean().optional(),
      strictBinding: z.boolean().optional(),
      requestId: z.string().optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ repoUrl, waitForImportMs = 30000, allowGithubConnect = false, force = false, baseUrl, sessionName = "default", tabId, useBoundTab = true, strictBinding = false, requestId }) => {
    const startedAt = new Date().toISOString();
    const auditContext = { sessionName, baseUrl, tabId };
    try {
      const target = await resolveBoundCdpTarget({ baseUrl, tabId, useBoundTab, sessionName, strictBinding });
      Object.assign(auditContext, { sessionName: target.sessionName, baseUrl: target.baseUrl, tabId: target.tabId, binding: target.binding, bindingWarnings: target.bindingWarnings });
      const imported = await importCdpCodeRepository({ baseUrl: target.baseUrl, tabId: target.tabId, repoUrl, waitForImportMs, allowGithubConnect, force });
      const result = withMeta({ ...imported, sessionName: target.sessionName, binding: target.binding, bindingWarnings: target.bindingWarnings }, { requestId, startedAt });
      await auditCdpWrite("gemini_cdp_import_code_repository", result, auditContext);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: !imported.ok };
    } catch (error) {
      const result = withMeta({ ok: false, errorCode: "GEMINI_CDP_IMPORT_CODE_REPOSITORY_FAILED", error: error.message }, { requestId, startedAt });
      await auditCdpWrite("gemini_cdp_import_code_repository", result, auditContext);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: true };
    }
  },
);

server.registerTool(
  "gemini_cdp_remove_attachments",
  {
    title: "Remove Gemini CDP attachments",
    inputSchema: {
      attachmentNameContains: z.string().optional(),
      removeAll: z.boolean().optional(),
      maxAttachments: z.number().int().min(1).max(50).optional(),
      waitMs: z.number().int().min(500).max(60000).optional(),
      baseUrl: z.string().optional(),
      sessionName: z.string().optional(),
      tabId: z.string().optional(),
      useBoundTab: z.boolean().optional(),
      strictBinding: z.boolean().optional(),
      requestId: z.string().optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ attachmentNameContains, removeAll = false, maxAttachments = 10, waitMs = 10000, baseUrl, sessionName = "default", tabId, useBoundTab = true, strictBinding = false, requestId }) => {
    const startedAt = new Date().toISOString();
    const auditContext = { sessionName, baseUrl, tabId, attachmentNameContains, removeAll, maxAttachments };
    try {
      if (!attachmentNameContains && !removeAll) throw new Error("ATTACHMENT_FILTER_REQUIRED");
      const target = await resolveBoundCdpTarget({ baseUrl, tabId, useBoundTab, sessionName, strictBinding });
      Object.assign(auditContext, { sessionName: target.sessionName, baseUrl: target.baseUrl, tabId: target.tabId, binding: target.binding, bindingWarnings: target.bindingWarnings });
      const removed = await removeCdpAttachments({ baseUrl: target.baseUrl, tabId: target.tabId, attachmentNameContains, removeAll, maxAttachments, waitMs });
      const result = withMeta({ ...removed, sessionName: target.sessionName, binding: target.binding, bindingWarnings: target.bindingWarnings }, { requestId, startedAt });
      await auditCdpWrite("gemini_cdp_remove_attachments", result, auditContext);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: !removed.ok };
    } catch (error) {
      const result = withMeta({ ok: false, errorCode: "GEMINI_CDP_REMOVE_ATTACHMENTS_FAILED", error: error.message }, { requestId, startedAt });
      await auditCdpWrite("gemini_cdp_remove_attachments", result, auditContext);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: true };
    }
  },
);

server.registerTool(
  "gemini_cdp_upload_file",
  {
    title: "Upload file to Gemini through CDP",
    inputSchema: {
      filePath: z.string(),
      waitForUploadMs: z.number().int().min(1000).max(120000).optional(),
      force: z.boolean().optional(),
      baseUrl: z.string().optional(),
      sessionName: z.string().optional(),
      tabId: z.string().optional(),
      useBoundTab: z.boolean().optional(),
      strictBinding: z.boolean().optional(),
      requestId: z.string().optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ filePath, waitForUploadMs = 15000, force = false, baseUrl, sessionName = "default", tabId, useBoundTab = true, strictBinding = false, requestId }) => {
    const startedAt = new Date().toISOString();
    const auditContext = { sessionName, baseUrl, tabId };
    try {
      const target = await resolveBoundCdpTarget({ baseUrl, tabId, useBoundTab, sessionName, strictBinding });
      Object.assign(auditContext, { sessionName: target.sessionName, baseUrl: target.baseUrl, tabId: target.tabId, binding: target.binding, bindingWarnings: target.bindingWarnings });
      const upload = await uploadCdpFile({ baseUrl: target.baseUrl, tabId: target.tabId, filePath, waitForUploadMs, force });
      const result = withMeta({ ...upload, sessionName: target.sessionName, binding: target.binding, bindingWarnings: target.bindingWarnings }, { requestId, startedAt });
      await auditCdpWrite("gemini_cdp_upload_file", result, auditContext);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: !upload.ok };
    } catch (error) {
      const result = withMeta({ ok: false, errorCode: "GEMINI_CDP_UPLOAD_FILE_FAILED", error: error.message }, { requestId, startedAt });
      await auditCdpWrite("gemini_cdp_upload_file", result, auditContext);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: true };
    }
  },
);

server.registerTool(
  "gemini_cdp_send",
  {
    title: "Send Gemini message through CDP",
    inputSchema: {
      message: z.string().optional(),
      messageBase64: z.string().optional(),
      allowSuspiciousText: z.boolean().optional(),
      submit: z.boolean().optional(),
      replaceDraft: z.boolean().optional(),
      force: z.boolean().optional(),
      baseUrl: z.string().optional(),
      sessionName: z.string().optional(),
      tabId: z.string().optional(),
      useBoundTab: z.boolean().optional(),
      strictBinding: z.boolean().optional(),
      requestId: z.string().optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ message, messageBase64, allowSuspiciousText = false, submit = true, replaceDraft = false, force = false, baseUrl, sessionName = "default", tabId, useBoundTab = true, strictBinding = false, requestId }) => {
    const startedAt = new Date().toISOString();
    const auditContext = { sessionName, baseUrl, tabId, submit };
    try {
      const resolvedMessage = resolveMessageInput({ message, messageBase64, allowSuspiciousText });
      auditContext.messageHash = sha256(resolvedMessage);
      const target = await resolveBoundCdpTarget({ baseUrl, tabId, useBoundTab, sessionName, strictBinding });
      Object.assign(auditContext, { sessionName: target.sessionName, baseUrl: target.baseUrl, tabId: target.tabId, binding: target.binding, bindingWarnings: target.bindingWarnings });
      const sent = await sendCdpMessage({ baseUrl: target.baseUrl, tabId: target.tabId, message: resolvedMessage, submit, replaceDraft, force });
      const result = withMeta({ ...sent, messageHash: sha256(resolvedMessage), sessionName: target.sessionName, binding: target.binding, bindingWarnings: target.bindingWarnings }, { requestId, startedAt });
      await auditCdpWrite("gemini_cdp_send", result, auditContext);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: !sent.ok };
    } catch (error) {
      const result = withMeta({ ok: false, errorCode: "GEMINI_CDP_SEND_FAILED", error: error.message }, { requestId, startedAt });
      await auditCdpWrite("gemini_cdp_send", result, auditContext);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: true };
    }
  },
);

server.registerTool(
  "gemini_cdp_send_and_wait",
  {
    title: "Send Gemini message and wait for reply",
    inputSchema: {
      message: z.string().optional(),
      messageBase64: z.string().optional(),
      allowSuspiciousText: z.boolean().optional(),
      replaceDraft: z.boolean().optional(),
      force: z.boolean().optional(),
      timeoutMs: z.number().int().min(5000).max(600000).optional(),
      pollMs: z.number().int().min(250).max(10000).optional(),
      stableMs: z.number().int().min(500).max(30000).optional(),
      baseUrl: z.string().optional(),
      sessionName: z.string().optional(),
      tabId: z.string().optional(),
      useBoundTab: z.boolean().optional(),
      strictBinding: z.boolean().optional(),
      requestId: z.string().optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ message, messageBase64, allowSuspiciousText = false, replaceDraft = false, force = false, timeoutMs = 45000, pollMs = 1000, stableMs = 2500, baseUrl, sessionName = "default", tabId, useBoundTab = true, strictBinding = false, requestId }) => {
    const startedAt = new Date().toISOString();
    const auditContext = { sessionName, baseUrl, tabId, submit: true };
    try {
      const resolvedMessage = resolveMessageInput({ message, messageBase64, allowSuspiciousText });
      auditContext.messageHash = sha256(resolvedMessage);
      const target = await resolveBoundCdpTarget({ baseUrl, tabId, useBoundTab, sessionName, strictBinding });
      Object.assign(auditContext, { sessionName: target.sessionName, baseUrl: target.baseUrl, tabId: target.tabId, binding: target.binding, bindingWarnings: target.bindingWarnings });
      const result0 = await sendCdpMessageAndWait({ baseUrl: target.baseUrl, tabId: target.tabId, message: resolvedMessage, replaceDraft, force, timeoutMs, pollMs, stableMs });
      const result = withMeta({ ...result0, messageHash: sha256(resolvedMessage), sessionName: target.sessionName, binding: target.binding, bindingWarnings: target.bindingWarnings }, { requestId, startedAt });
      await auditCdpWrite("gemini_cdp_send_and_wait", result, auditContext);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: !result0.ok };
    } catch (error) {
      const result = withMeta({ ok: false, errorCode: "GEMINI_CDP_SEND_AND_WAIT_FAILED", error: error.message }, { requestId, startedAt });
      await auditCdpWrite("gemini_cdp_send_and_wait", result, auditContext);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
