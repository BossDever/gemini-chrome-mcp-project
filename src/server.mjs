#!/usr/bin/env node
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  cdpStatus,
  defaultCdpBaseUrl,
  findCdpTab,
  getCdpState,
  listCdpTabs,
  openCdpTab,
  readCdpPage,
  removeCdpAttachments,
  sendCdpMessage,
  sendCdpMessageAndWait,
  uploadCdpFile,
} from "./cdp-client.mjs";
import {
  normalizeSessionName,
  readBoundCdpTarget,
  resolveBoundCdpTarget,
  writeBoundCdpTarget,
} from "./cdp-session-manager.mjs";

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
    try {
      if (!attachmentNameContains && !removeAll) throw new Error("ATTACHMENT_FILTER_REQUIRED");
      const target = await resolveBoundCdpTarget({ baseUrl, tabId, useBoundTab, sessionName, strictBinding });
      const removed = await removeCdpAttachments({ baseUrl: target.baseUrl, tabId: target.tabId, attachmentNameContains, removeAll, maxAttachments, waitMs });
      const result = withMeta({ ...removed, sessionName: target.sessionName, binding: target.binding, bindingWarnings: target.bindingWarnings }, { requestId, startedAt });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: !removed.ok };
    } catch (error) {
      const result = withMeta({ ok: false, errorCode: "GEMINI_CDP_REMOVE_ATTACHMENTS_FAILED", error: error.message }, { requestId, startedAt });
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
    try {
      const target = await resolveBoundCdpTarget({ baseUrl, tabId, useBoundTab, sessionName, strictBinding });
      const upload = await uploadCdpFile({ baseUrl: target.baseUrl, tabId: target.tabId, filePath, waitForUploadMs, force });
      const result = withMeta({ ...upload, sessionName: target.sessionName, binding: target.binding, bindingWarnings: target.bindingWarnings }, { requestId, startedAt });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: !upload.ok };
    } catch (error) {
      const result = withMeta({ ok: false, errorCode: "GEMINI_CDP_UPLOAD_FILE_FAILED", error: error.message }, { requestId, startedAt });
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
    try {
      const resolvedMessage = resolveMessageInput({ message, messageBase64, allowSuspiciousText });
      const target = await resolveBoundCdpTarget({ baseUrl, tabId, useBoundTab, sessionName, strictBinding });
      const sent = await sendCdpMessage({ baseUrl: target.baseUrl, tabId: target.tabId, message: resolvedMessage, submit, replaceDraft, force });
      const result = withMeta({ ...sent, messageHash: sha256(resolvedMessage), sessionName: target.sessionName, binding: target.binding, bindingWarnings: target.bindingWarnings }, { requestId, startedAt });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: !sent.ok };
    } catch (error) {
      const result = withMeta({ ok: false, errorCode: "GEMINI_CDP_SEND_FAILED", error: error.message }, { requestId, startedAt });
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
    try {
      const resolvedMessage = resolveMessageInput({ message, messageBase64, allowSuspiciousText });
      const target = await resolveBoundCdpTarget({ baseUrl, tabId, useBoundTab, sessionName, strictBinding });
      const result0 = await sendCdpMessageAndWait({ baseUrl: target.baseUrl, tabId: target.tabId, message: resolvedMessage, replaceDraft, force, timeoutMs, pollMs, stableMs });
      const result = withMeta({ ...result0, messageHash: sha256(resolvedMessage), sessionName: target.sessionName, binding: target.binding, bindingWarnings: target.bindingWarnings }, { requestId, startedAt });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: !result0.ok };
    } catch (error) {
      const result = withMeta({ ok: false, errorCode: "GEMINI_CDP_SEND_AND_WAIT_FAILED", error: error.message }, { requestId, startedAt });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
