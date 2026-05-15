import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    if (!message.id || !this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else pending.resolve(message.result ?? {});
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
  timeoutMs = 120000,
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
