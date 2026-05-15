import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { geminiDomAdapterScript } from "./gemini-dom-adapter.mjs";

const DEFAULT_CDP_BASE_URL = "http://127.0.0.1:9222";
const cdpQueues = new Map();

export function defaultCdpBaseUrl() {
  return process.env.GEMINI_CHROME_MCP_CDP_URL || DEFAULT_CDP_BASE_URL;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(baseUrl = defaultCdpBaseUrl()) {
  return baseUrl.replace(/\/+$/, "");
}

function sha256Text(text) {
  return createHash("sha256").update(text ?? "", "utf8").digest("hex");
}

function assertGeminiTab(tab) {
  try {
    const parsed = new URL(tab?.url ?? "");
    if (parsed.hostname === "gemini.google.com") return;
  } catch {
    // fall through
  }
  throw new Error(`CDP_TAB_NOT_GEMINI: ${tab?.url ?? "unknown URL"}`);
}

async function fetchJson(url, { timeoutMs = 5000, method = "GET" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function cdpStatus({ baseUrl = defaultCdpBaseUrl(), timeoutMs = 2500 } = {}) {
  const normalized = normalizeBaseUrl(baseUrl);
  try {
    const version = await fetchJson(`${normalized}/json/version`, { timeoutMs });
    return {
      ok: true,
      baseUrl: normalized,
      browser: version.Browser ?? null,
      protocolVersion: version["Protocol-Version"] ?? null,
      userAgent: version["User-Agent"] ?? null,
      webSocketDebuggerUrl: version.webSocketDebuggerUrl ?? null,
    };
  } catch (error) {
    return { ok: false, baseUrl: normalized, error: error.message };
  }
}

export async function listCdpTabs({ baseUrl = defaultCdpBaseUrl(), includeNonPages = false } = {}) {
  const normalized = normalizeBaseUrl(baseUrl);
  const tabs = await fetchJson(`${normalized}/json/list`);
  return tabs
    .filter((tab) => includeNonPages || tab.type === "page")
    .map((tab, index) => ({
      index,
      id: tab.id,
      tabId: tab.id,
      type: tab.type,
      title: tab.title ?? "",
      url: tab.url ?? "",
      attached: Boolean(tab.attached),
      canAttach: Boolean(tab.webSocketDebuggerUrl),
      webSocketDebuggerUrl: tab.webSocketDebuggerUrl ?? null,
    }));
}

export async function openCdpTab({ baseUrl = defaultCdpBaseUrl(), url = "https://gemini.google.com/app" } = {}) {
  const normalized = normalizeBaseUrl(baseUrl);
  const tab = await fetchJson(`${normalized}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  return {
    id: tab.id,
    tabId: tab.id,
    type: tab.type,
    title: tab.title ?? "",
    url: tab.url ?? "",
    webSocketDebuggerUrl: tab.webSocketDebuggerUrl ?? null,
  };
}

export async function findCdpTab({
  baseUrl = defaultCdpBaseUrl(),
  tabId,
  titleContains,
  urlContains = "gemini.google.com",
} = {}) {
  const tabs = await listCdpTabs({ baseUrl });
  let matches = tabs;
  if (tabId) {
    matches = tabs.filter((tab) => tab.id === tabId || tab.tabId === tabId);
  } else {
    if (titleContains) matches = matches.filter((tab) => tab.title.toLowerCase().includes(titleContains.toLowerCase()));
    if (urlContains) matches = matches.filter((tab) => tab.url.toLowerCase().includes(urlContains.toLowerCase()));
  }
  if (matches.length === 0) throw new Error("CDP_TAB_NOT_FOUND");
  if (!tabId && matches.length > 1) {
    throw new Error(`AMBIGUOUS_CDP_TAB: ${matches.map((tab) => `${tab.id}:${tab.title}`).join(" | ")}`);
  }
  return matches[0];
}

export async function readBoundTab(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeBoundTab(filePath, state) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
}

export class CdpSession {
  constructor(webSocketDebuggerUrl) {
    this.webSocketDebuggerUrl = webSocketDebuggerUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(this.webSocketDebuggerUrl);
    this.ws.addEventListener("message", (event) => this.handleMessage(event.data));
    this.ws.addEventListener("close", () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error("CDP websocket closed."));
      }
      this.pending.clear();
      for (const { reject, timer } of this.waiters) {
        clearTimeout(timer);
        reject(new Error("CDP websocket closed."));
      }
      this.waiters = [];
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out opening CDP websocket.")), 10000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP websocket error."));
      });
    });
  }

  handleMessage(raw) {
    const message = JSON.parse(raw);
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method) {
      const remaining = [];
      for (const waiter of this.waiters) {
        if (waiter.method === message.method && waiter.predicate(message.params ?? {})) {
          clearTimeout(waiter.timer);
          waiter.resolve(message.params ?? {});
        } else {
          remaining.push(waiter);
        }
      }
      this.waiters = remaining;
    }
  }

  send(method, params = {}, timeoutMs = 10000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP method ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (this.ws) this.ws.close();
  }

  waitForEvent(method, predicate = () => true, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.resolve !== resolve);
        reject(new Error(`Timed out waiting for CDP event ${method}.`));
      }, timeoutMs);
      this.waiters.push({ method, predicate, resolve, reject, timer });
    });
  }
}

export async function withCdpTab(tab, fn) {
  if (!tab?.webSocketDebuggerUrl) throw new Error("Selected CDP tab does not expose webSocketDebuggerUrl.");
  const session = new CdpSession(tab.webSocketDebuggerUrl);
  await session.connect();
  try {
    await session.send("Runtime.enable");
    await session.send("Page.enable");
    return await fn(session);
  } finally {
    session.close();
  }
}

export async function evaluateCdp(session, expression, timeoutMs = 10000) {
  const result = await session.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    timeoutMs,
  );
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "CDP Runtime.evaluate failed.");
  return result.result?.value;
}

export async function getCdpState({ baseUrl = defaultCdpBaseUrl(), tabId, maxChars = 20000 } = {}) {
  const normalized = normalizeBaseUrl(baseUrl);
  const tab = await findCdpTab({ baseUrl: normalized, tabId });
  assertGeminiTab(tab);
  return withCdpTab(tab, async (session) => {
    const state = await evaluateCdp(session, `(() => {
      ${geminiDomAdapterScript()}
      return geminiDomAdapter.getGeminiDomState(document);
    })()`);
    const conversationText = state.turns.map((turn) => turn.text).join("\\n\\n");
    return {
      ok: true,
      tab,
      state: {
        ...state,
        turns: state.turns.map((turn) => ({ ...turn, text: turn.text.slice(0, maxChars) })),
        conversationText: conversationText.slice(-maxChars),
        conversationTextLength: conversationText.length,
        conversationTextHash: sha256Text(conversationText),
        lastUserText: state.lastUserText.slice(0, maxChars),
        lastUserTextLength: state.lastUserText.length,
        lastUserTextHash: sha256Text(state.lastUserText),
        lastAssistantText: state.lastAssistantText.slice(0, maxChars),
        lastAssistantTextLength: state.lastAssistantText.length,
        lastAssistantTextHash: sha256Text(state.lastAssistantText),
        tabId: tab.id,
      },
    };
  });
}

export async function readCdpPage({
  baseUrl = defaultCdpBaseUrl(),
  tabId,
  maxChars = 20000,
  mode = "raw",
  maxTurns = 6,
  maxCharsPerTurn = 6000,
  includeRawFallback = false,
  includeText = true,
} = {}) {
  const normalized = normalizeBaseUrl(baseUrl);
  const tab = await findCdpTab({ baseUrl: normalized, tabId });
  assertGeminiTab(tab);
  return withCdpTab(tab, async (session) => {
    const normalizedMode = ["raw", "structured", "combined"].includes(mode) ? mode : "raw";
    const needsRaw = normalizedMode === "raw" || normalizedMode === "combined" || includeRawFallback;
    const needsStructured = normalizedMode === "structured" || normalizedMode === "combined";
    const stateResult = await getCdpState({ baseUrl: normalized, tabId: tab.id, maxChars: needsRaw ? maxChars : 1000 });
    const structured = needsStructured ? await evaluateCdp(session, `(() => {
      ${geminiDomAdapterScript()}
      return geminiDomAdapter.buildStructuredVisibleDomRead({
        doc: document,
        maxTurns: ${JSON.stringify(maxTurns)},
        maxCharsPerTurn: ${JSON.stringify(maxCharsPerTurn)},
        includeText: ${JSON.stringify(includeText)}
      });
    })()`) : null;
    if (structured) {
      structured.turns = structured.turns.map((turn) => ({
        ...turn,
        textHash: typeof turn.text === "string" ? sha256Text(turn.text) : null,
        hashSource: typeof turn.text === "string" ? "returned_text" : "none",
      }));
    }
    const state = needsRaw ? stateResult.state : {
      ...stateResult.state,
      turns: [],
      conversationText: "",
      conversationTextHash: "",
      conversationTextLength: 0,
      lastUserText: "",
      lastUserTextHash: "",
      lastUserTextLength: 0,
      lastAssistantText: "",
      lastAssistantTextHash: "",
      lastAssistantTextLength: 0,
    };
    return {
      ok: true,
      tab,
      page: {
        mode: normalizedMode,
        title: state.title,
        url: state.url,
        text: needsRaw ? state.conversationText : "",
        textLength: needsRaw ? state.conversationTextLength : 0,
        hasComposer: state.hasComposer,
        composerText: state.composerText,
        turns: needsRaw ? state.turns : [],
        lastAssistantText: needsRaw ? state.lastAssistantText : "",
        structured,
        rawFallbackIncluded: needsRaw,
        state,
      },
    };
  });
}

function cdpLockKey(baseUrl, tabId) {
  return `${normalizeBaseUrl(baseUrl)}|${tabId}`;
}

async function withCdpTabLock({ baseUrl, tabId }, fn) {
  if (!tabId) return fn();
  const key = cdpLockKey(baseUrl, tabId);
  const previous = cdpQueues.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const next = previous.catch(() => {}).then(() => gate);
  cdpQueues.set(key, next);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (cdpQueues.get(key) === next) cdpQueues.delete(key);
  }
}

export async function sendCdpMessage({
  baseUrl = defaultCdpBaseUrl(),
  tabId,
  message,
  submit = true,
  replaceDraft = false,
  force = false,
  lockTimeoutMs = 120000,
} = {}) {
  if (typeof message !== "string" || !message) throw new Error("message is required.");
  const normalized = normalizeBaseUrl(baseUrl);
  const tab = await findCdpTab({ baseUrl: normalized, tabId });
  assertGeminiTab(tab);
  const encodedMessage = Buffer.from(message, "utf8").toString("base64");
  return withCdpTabLock({ baseUrl: normalized, tabId: tab.id }, () => withCdpTab(tab, async (session) => {
    const stateBeforeSend = (await getCdpState({ baseUrl: normalized, tabId: tab.id })).state;
    if (stateBeforeSend.isGenerating && !force) {
      return { ok: false, errorCode: "BUSY_GENERATING", tab, stateBeforeSend };
    }
    if (stateBeforeSend.composerText && !replaceDraft) {
      return { ok: false, errorCode: "DRAFT_EXISTS", tab, stateBeforeSend };
    }
    const write = await evaluateCdp(session, `(() => {
      ${geminiDomAdapterScript()}
      const bytes = Uint8Array.from(atob(${JSON.stringify(encodedMessage)}), (ch) => ch.charCodeAt(0));
      const message = new TextDecoder().decode(bytes);
      const editor = geminiDomAdapter.findComposer(document);
      if (!editor) return { ok: false, errorCode: "COMPOSER_NOT_FOUND" };
      editor.focus();
      editor.textContent = message;
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: message }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      const sendButton = geminiDomAdapter.findSendButton(document);
      return {
        ok: true,
        promptText: geminiDomAdapter.textOf(editor),
        sendButtonFound: Boolean(sendButton),
        sendButtonEnabled: Boolean(sendButton) && !geminiDomAdapter.isElementDisabled(sendButton)
      };
    })()`);
    if (!write.ok) return { ok: false, tab, write, stateBeforeSend };
    if (!submit) return { ok: true, submitted: false, tab, write, stateBeforeSend };
    await sleep(500);
    const clicked = await evaluateCdp(session, `(() => {
      ${geminiDomAdapterScript()}
      const sendButton = geminiDomAdapter.findSendButton(document);
      if (!sendButton) return { ok: false, errorCode: "SEND_BUTTON_NOT_FOUND" };
      if (geminiDomAdapter.isElementDisabled(sendButton)) return { ok: false, errorCode: "SEND_BUTTON_DISABLED" };
      sendButton.click();
      return { ok: true };
    })()`);
    await sleep(800);
    const stateAfterSubmit = (await getCdpState({ baseUrl: normalized, tabId: tab.id })).state;
    const ownTurnAppeared = stateAfterSubmit.lastUserText.includes(message) ||
      stateAfterSubmit.turnCount > stateBeforeSend.turnCount;
    return {
      ok: clicked.ok && ownTurnAppeared,
      errorCode: clicked.ok && ownTurnAppeared ? undefined : "GEMINI_SUBMIT_VERIFY_FAILED",
      tab,
      submitted: clicked.ok,
      ownTurnAppeared,
      write,
      clicked,
      stateBeforeSend,
      stateAfterSubmit,
    };
  }));
}

export async function sendCdpMessageAndWait({
  baseUrl = defaultCdpBaseUrl(),
  tabId,
  message,
  timeoutMs = 45000,
  pollMs = 1000,
  stableMs = 2500,
  ...sendOptions
} = {}) {
  const sent = await sendCdpMessage({ baseUrl, tabId, message, submit: true, ...sendOptions });
  if (!sent.ok) return { ...sent, wait: null };
  const start = Date.now();
  let lastState = null;
  let candidateHash = "";
  let stableSince = 0;
  while (Date.now() - start < timeoutMs) {
    await sleep(pollMs);
    const state = (await getCdpState({ baseUrl, tabId: sent.tab.id })).state;
    lastState = state;
    const hasAssistantAfterUser = state.lastAssistantTurnIndex > state.lastUserTurnIndex;
    if (!state.isGenerating && hasAssistantAfterUser && state.lastAssistantTextLength > 0) {
      if (state.lastAssistantTextHash !== candidateHash) {
        candidateHash = state.lastAssistantTextHash;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= stableMs) {
        return {
          ok: true,
          tab: sent.tab,
          sent,
          wait: { ok: true, stableMs, elapsedMs: Date.now() - start },
          lastAssistantText: state.lastAssistantText,
          lastAssistantTextHash: state.lastAssistantTextHash,
          finalState: state,
        };
      }
    }
  }
  return {
    ok: false,
    errorCode: "GEMINI_REPLY_WAIT_TIMEOUT",
    tab: sent.tab,
    sent,
    wait: { ok: false, elapsedMs: Date.now() - start },
    lastAssistantText: lastState?.lastAssistantText ?? "",
    lastAssistantTextHash: lastState?.lastAssistantTextHash ?? "",
    finalState: lastState,
  };
}

export async function uploadCdpFile({
  baseUrl = defaultCdpBaseUrl(),
  tabId,
  filePath,
  waitForUploadMs = 15000,
  force = false,
  lockTimeoutMs = 120000,
} = {}) {
  if (!filePath) throw new Error("filePath is required.");
  const fileInfo = await stat(filePath);
  if (!fileInfo.isFile()) throw new Error("filePath must point to a file.");

  const normalized = normalizeBaseUrl(baseUrl);
  const tab = await findCdpTab({ baseUrl: normalized, tabId });
  assertGeminiTab(tab);
  const fileName = path.basename(filePath);

  return withCdpTabLock({ baseUrl: normalized, tabId: tab.id }, () => withCdpTab(tab, async (session) => {
    const stateBeforeUpload = (await getCdpState({ baseUrl: normalized, tabId: tab.id })).state;
    if (stateBeforeUpload.isGenerating && !force) {
      return { ok: false, errorCode: "BUSY_GENERATING", tab, stateBeforeUpload };
    }

    await session.send("DOM.enable");
    const uploaded = await uploadViaFileChooserInterception(session, filePath, fileName, waitForUploadMs);
    const stateAfterUpload = (await getCdpState({ baseUrl: normalized, tabId: tab.id })).state;
    return {
      ...uploaded,
      tab,
      fileName,
      fileLength: fileInfo.size,
      stateBeforeUpload,
      stateAfterUpload,
    };
  }));
}

async function uploadViaFileChooserInterception(session, filePath, fileName, waitForUploadMs) {
  await session.send("Page.setInterceptFileChooserDialog", { enabled: true });
  try {
    const chooserPromise = session
      .waitForEvent("Page.fileChooserOpened", () => true, 7000)
      .catch((error) => ({ errorCode: "FILE_CHOOSER_NOT_OPENED", message: error.message }));

    const target = await evaluateCdp(session, `(async () => {
      ${geminiDomAdapterScript()}
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const centerOf = (el) => {
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
      };
      let item = document.querySelector('[data-test-id="local-images-files-uploader-button"]');
      if (!item) {
        const openButton = document.querySelector("button.upload-card-button.open");
        if (!openButton) return { ok: false, errorCode: "UPLOAD_MENU_BUTTON_NOT_FOUND" };
        return { ok: true, target: "open_menu", ...centerOf(openButton) };
      }
      return {
        ok: true,
        target: "upload_item",
        label: geminiDomAdapter.labelOf(item),
        ...centerOf(item)
      };
    })()`, 10000);
    if (!target?.ok) return { ok: false, method: "FileChooserIntercept", clicked: target };

    let clicked = target;
    if (target.target === "open_menu") {
      await dispatchMouseClick(session, target);
      await sleep(700);
      clicked = await evaluateCdp(session, `(() => {
        ${geminiDomAdapterScript()}
        const item = document.querySelector('[data-test-id="local-images-files-uploader-button"]');
        if (!item) return { ok: false, errorCode: "UPLOAD_MENU_ITEM_NOT_FOUND" };
        if (geminiDomAdapter.isElementDisabled(item)) return { ok: false, errorCode: "UPLOAD_MENU_ITEM_DISABLED" };
        const rect = item.getBoundingClientRect();
        return {
          ok: true,
          target: "upload_item",
          label: geminiDomAdapter.labelOf(item),
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          width: rect.width,
          height: rect.height
        };
      })()`, 10000);
      if (!clicked?.ok) return { ok: false, method: "FileChooserIntercept", clicked };
    }

    await dispatchMouseClick(session, clicked);

    const chooser = await chooserPromise;
    if (chooser.errorCode) return { ok: false, method: "FileChooserIntercept", clicked, ...chooser };

    const params = { files: [filePath] };
    if (chooser.backendNodeId) params.backendNodeId = chooser.backendNodeId;
    else if (chooser.frameId) params.frameId = chooser.frameId;
    await session.send("DOM.setFileInputFiles", params, 10000);

    const attachment = await waitForAttachmentByName(session, fileName, waitForUploadMs);
    return {
      ok: Boolean(attachment?.found),
      errorCode: attachment?.found ? undefined : "GEMINI_ATTACHMENT_NOT_FOUND_AFTER_UPLOAD",
      method: "FileChooserIntercept",
      clicked,
      chooser: {
        mode: chooser.mode ?? null,
        backendNodeId: chooser.backendNodeId ?? null,
        frameId: chooser.frameId ?? null,
      },
      attachment,
    };
  } finally {
    await session.send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
  }
}

async function dispatchMouseClick(session, point) {
  await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" }, 10000);
  await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 }, 10000);
  await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 }, 10000);
}

async function waitForAttachmentByName(session, fileName, waitForUploadMs) {
  const deadline = Date.now() + waitForUploadMs;
  let attachment = null;
  while (Date.now() < deadline) {
    attachment = await evaluateCdp(session, `(() => {
      ${geminiDomAdapterScript()}
      const fileName = ${JSON.stringify(fileName)};
      const fileStem = fileName.replace(/\\.[^.]+$/, "");
      const all = [...document.querySelectorAll("[aria-label], [data-test-id], [data-testid], button, [role=button], mat-chip, .file-name, [class*=file], [class*=upload], [class*=attach]")];
      const candidates = all.map((el, index) => {
        const text = geminiDomAdapter.textOf(el);
        const ariaLabel = el.getAttribute("aria-label") || "";
        const dataTestId = el.getAttribute("data-test-id") || el.getAttribute("data-testid") || "";
        const className = el.getAttribute("class") || "";
        const haystack = [text, ariaLabel, dataTestId, className].join(" ");
        return {
          index,
          tag: el.tagName.toLowerCase(),
          text: text.slice(0, 300),
          ariaLabel: ariaLabel.slice(0, 300),
          dataTestId,
          className: className.slice(0, 300),
          visible: Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
          matched: haystack.toLowerCase().includes(fileName.toLowerCase()) ||
            (fileStem.length >= 3 && haystack.toLowerCase().includes(fileStem.toLowerCase()))
        };
      }).filter((candidate) => candidate.matched);
      return { found: candidates.length > 0, fileName, candidates };
    })()`, 10000);
    if (attachment?.found) break;
    await sleep(500);
  }
  return attachment;
}

export async function removeCdpAttachments({
  baseUrl = defaultCdpBaseUrl(),
  tabId,
  attachmentNameContains,
  removeAll = false,
  maxAttachments = 10,
  waitMs = 10000,
  lockTimeoutMs = 120000,
} = {}) {
  if (!removeAll && !attachmentNameContains) {
    throw new Error("Provide attachmentNameContains or set removeAll=true.");
  }
  const normalized = normalizeBaseUrl(baseUrl);
  const tab = await findCdpTab({ baseUrl: normalized, tabId });
  assertGeminiTab(tab);
  const filterText = (attachmentNameContains ?? "").toLowerCase();

  return withCdpTabLock({ baseUrl: normalized, tabId: tab.id }, () => withCdpTab(tab, async (session) => {
    const stateBeforeRemove = (await getCdpState({ baseUrl: normalized, tabId: tab.id })).state;
    const removed = await evaluateCdp(session, `(() => {
      ${geminiDomAdapterScript()}
      const filterText = ${JSON.stringify(filterText)};
      const removeAll = ${JSON.stringify(Boolean(removeAll))};
      const maxAttachments = ${JSON.stringify(maxAttachments)};
      const cards = [...document.querySelectorAll('.attachment-preview-wrapper, uploader-file-preview, [data-test-id="file-preview"], .file-preview')];
      const clicked = [];
      const seenButtons = new WeakSet();
      for (const card of cards) {
        const name = geminiDomAdapter.textOf(card.querySelector?.('[data-test-id="file-name"], .file-name')) ||
          geminiDomAdapter.textOf(card);
        const removeButton = card.querySelector?.('[data-test-id="cancel-button"], button.cancel-button') ||
          card.parentElement?.querySelector?.('[data-test-id="cancel-button"], button.cancel-button') ||
          null;
        const removeLabel = removeButton?.getAttribute?.("aria-label") || geminiDomAdapter.textOf(removeButton);
        const haystack = [name, geminiDomAdapter.textOf(card), removeLabel].join(" ").toLowerCase();
        if (!removeAll && !haystack.includes(filterText)) continue;
        if (!removeButton) {
          clicked.push({ name, clicked: false, reason: "REMOVE_BUTTON_NOT_FOUND" });
          continue;
        }
        if (seenButtons.has(removeButton)) continue;
        seenButtons.add(removeButton);
        removeButton.click();
        clicked.push({ name, clicked: true, removeLabel });
        if (clicked.filter((entry) => entry.clicked).length >= maxAttachments) break;
      }
      return { ok: true, requested: clicked.length, clicked };
    })()`, 10000);

    const deadline = Date.now() + waitMs;
    let stateAfterRemove = (await getCdpState({ baseUrl: normalized, tabId: tab.id })).state;
    while (Date.now() < deadline) {
      const remaining = stateAfterRemove.attachments.filter((attachment) => {
        const haystack = [attachment.name, attachment.text, attachment.removeLabel].join(" ").toLowerCase();
        return removeAll || haystack.includes(filterText);
      });
      if (remaining.length === 0) break;
      await sleep(500);
      stateAfterRemove = (await getCdpState({ baseUrl: normalized, tabId: tab.id })).state;
    }
    const remainingMatches = stateAfterRemove.attachments.filter((attachment) => {
      const haystack = [attachment.name, attachment.text, attachment.removeLabel].join(" ").toLowerCase();
      return removeAll || haystack.includes(filterText);
    });
    const clickedCount = removed.clicked.filter((entry) => entry.clicked).length;
    const ok = removed.requested > 0 && clickedCount > 0 && remainingMatches.length === 0;
    return {
      ok,
      errorCode: ok ? undefined : removed.requested === 0 ? "GEMINI_ATTACHMENT_NOT_FOUND" : "GEMINI_REMOVE_ATTACHMENTS_INCOMPLETE",
      tab,
      removed,
      remainingMatches,
      stateBeforeRemove,
      stateAfterRemove,
    };
  }));
}

function githubRepositoryKey(repoUrl) {
  try {
    const parsed = new URL(repoUrl);
    if (parsed.hostname !== "github.com" && !parsed.hostname.endsWith(".github.com")) return "";
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/");
    if (parts.length < 2) return "";
    return `${parts[0]}/${parts[1]}`.toLowerCase();
  } catch {
    return "";
  }
}

export async function importCdpCodeRepository({
  baseUrl = defaultCdpBaseUrl(),
  tabId,
  repoUrl,
  waitForImportMs = 30000,
  allowGithubConnect = false,
  force = false,
  lockTimeoutMs = 120000,
} = {}) {
  if (!repoUrl) throw new Error("repoUrl is required.");
  const repositoryKey = githubRepositoryKey(repoUrl);
  if (!repositoryKey) throw new Error("repoUrl must be a GitHub repository URL.");

  const normalized = normalizeBaseUrl(baseUrl);
  const tab = await findCdpTab({ baseUrl: normalized, tabId });
  assertGeminiTab(tab);

  return withCdpTabLock({ baseUrl: normalized, tabId: tab.id }, () => withCdpTab(tab, async (session) => {
    const stateBeforeImport = (await getCdpState({ baseUrl: normalized, tabId: tab.id })).state;
    if (stateBeforeImport.isGenerating && !force) {
      return { ok: false, errorCode: "BUSY_GENERATING", tab, stateBeforeImport };
    }

    const clicked = await openCodeImportDialog(session);
    if (!clicked.ok) return { ok: false, tab, clicked, stateBeforeImport };

    const wrote = await evaluateCdp(session, `(() => {
      const input = document.querySelector('[data-test-id="repo-url-input"]');
      if (!input) return { ok: false, errorCode: "REPO_URL_INPUT_NOT_FOUND" };
      const repoUrl = ${JSON.stringify(repoUrl)};
      input.focus();
      input.value = repoUrl;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: repoUrl }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, value: input.value };
    })()`);
    if (!wrote.ok) return { ok: false, tab, clicked, wrote, stateBeforeImport };

    await sleep(800);
    const firstImport = await clickImportRepositoryButton(session);
    if (!firstImport.ok) return { ok: false, tab, clicked, wrote, firstImport, stateBeforeImport };
    await sleep(2500);

    const consent = await handleGithubConsentDialog(session, { allowGithubConnect });
    if (consent.handled) {
      await sleep(1000);
      const secondImport = await clickImportRepositoryButton(session);
      if (!secondImport.ok) return { ok: false, tab, clicked, wrote, firstImport, consent, secondImport, stateBeforeImport };
    }

    const attachment = await waitForRepositoryAttachment(session, repositoryKey, waitForImportMs);
    const stateAfterImport = (await getCdpState({ baseUrl: normalized, tabId: tab.id })).state;
    return {
      ok: Boolean(attachment?.found),
      errorCode: attachment?.found ? undefined : "GEMINI_REPOSITORY_ATTACHMENT_NOT_FOUND_AFTER_IMPORT",
      tab,
      repoUrl,
      repositoryKey,
      clicked,
      wrote,
      firstImport,
      consent,
      attachment,
      stateBeforeImport,
      stateAfterImport,
    };
  }));
}

async function openCodeImportDialog(session) {
  const menuTarget = await evaluateCdp(session, `(() => {
    const openButton = document.querySelector("button.upload-card-button.open");
    if (!openButton) {
      const codeButton = document.querySelector('[data-test-id="code-import-button"]');
      if (codeButton) return { ok: true, target: "code_import_ready" };
      return { ok: false, errorCode: "UPLOAD_MENU_BUTTON_NOT_FOUND" };
    }
    const rect = openButton.getBoundingClientRect();
    return {
      ok: true,
      target: "open_menu",
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
  })()`);
  if (!menuTarget.ok) return menuTarget;
  if (menuTarget.target === "open_menu") {
    await dispatchMouseClick(session, menuTarget);
    await sleep(700);
  }
  const codeTarget = await evaluateCdp(session, `(() => {
    const button = document.querySelector('[data-test-id="code-import-button"]');
    if (!button) return { ok: false, errorCode: "CODE_IMPORT_BUTTON_NOT_FOUND" };
    const rect = button.getBoundingClientRect();
    return {
      ok: true,
      target: "code_import",
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      text: button.innerText || button.textContent || ""
    };
  })()`);
  if (!codeTarget.ok) return codeTarget;
  await dispatchMouseClick(session, codeTarget);
  await sleep(1000);
  return { ok: true, menuTarget, codeTarget };
}

async function clickImportRepositoryButton(session) {
  const target = await evaluateCdp(session, `(() => {
    const button = document.querySelector('[data-test-id="import-repository-button"]');
    if (!button) return { ok: false, errorCode: "IMPORT_REPOSITORY_BUTTON_NOT_FOUND" };
    const disabled = Boolean(button.disabled || button.getAttribute("aria-disabled") === "true");
    const rect = button.getBoundingClientRect();
    return {
      ok: !disabled,
      errorCode: disabled ? "IMPORT_REPOSITORY_BUTTON_DISABLED" : undefined,
      disabled,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      text: button.innerText || button.textContent || ""
    };
  })()`);
  if (target.ok) await dispatchMouseClick(session, target);
  return target;
}

async function handleGithubConsentDialog(session, { allowGithubConnect = false } = {}) {
  const target = await evaluateCdp(session, `(() => {
    const dialog = document.querySelector('[data-test-id="tool-consent-dialog"], .consent-dialog-container');
    if (!dialog) return { handled: false, present: false };
    const buttons = [...dialog.querySelectorAll("button")]
      .filter((el) => Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    if (buttons.length === 0) return { handled: false, present: true, errorCode: "CONSENT_BUTTON_NOT_FOUND" };
    const button = buttons[${allowGithubConnect ? "buttons.length - 1" : "0"}];
    const rect = button.getBoundingClientRect();
    return {
      handled: true,
      present: true,
      action: ${JSON.stringify(allowGithubConnect ? "connect" : "decline")},
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      text: button.innerText || button.textContent || "",
      ariaLabel: button.getAttribute("aria-label") || ""
    };
  })()`);
  if (target.handled && target.x != null && target.y != null) {
    await dispatchMouseClick(session, target);
  }
  return target;
}

async function waitForRepositoryAttachment(session, repositoryKey, waitForImportMs) {
  const deadline = Date.now() + waitForImportMs;
  let attachment = null;
  while (Date.now() < deadline) {
    attachment = await evaluateCdp(session, `(() => {
      ${geminiDomAdapterScript()}
      const repositoryKey = ${JSON.stringify(repositoryKey)};
      const candidates = geminiDomAdapter.extractAttachmentCandidates(document)
        .filter((candidate) => {
          const haystack = [candidate.name, candidate.text, candidate.removeLabel].join(" ").toLowerCase();
          return haystack.includes(repositoryKey) ||
            (haystack.includes("github") && haystack.includes(repositoryKey.split("/")[1]));
        });
      return { found: candidates.length > 0, repositoryKey, candidates };
    })()`, 10000);
    if (attachment?.found) break;
    await sleep(500);
  }
  return attachment;
}
