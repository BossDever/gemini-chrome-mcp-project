export function textOf(el) {
  return (el?.innerText || el?.textContent || el?.value || "").trim();
}

export function labelOf(el) {
  return [
    el?.getAttribute?.("aria-label") || "",
    el?.getAttribute?.("data-test-id") || "",
    el?.getAttribute?.("data-testid") || "",
    el?.getAttribute?.("class") || "",
    textOf(el),
  ].join(" ").toLowerCase();
}

export function isElementDisabled(el) {
  return !el || Boolean(el.disabled) || el.getAttribute?.("aria-disabled") === "true";
}

export function isLikelyVisible(el) {
  if (!el || el.hidden || el.getAttribute?.("aria-hidden") === "true") return false;
  const style = el.getAttribute?.("style") || "";
  if (/(^|;)\s*display\s*:\s*none/i.test(style) || /(^|;)\s*visibility\s*:\s*hidden/i.test(style)) {
    return false;
  }
  if (typeof el.offsetWidth === "number" || typeof el.offsetHeight === "number" || el.getClientRects) {
    return Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects?.().length);
  }
  return true;
}

export function findComposer(doc = document) {
  const editors = [
    ...doc.querySelectorAll('.ql-editor[contenteditable="true"][role="textbox"], [role="textbox"][contenteditable="true"]'),
  ];
  return editors.find((el) => !el.classList?.contains("ql-clipboard")) ?? null;
}

export function findSendButton(doc = document) {
  const composer = findComposer(doc);
  const candidates = [
    ...doc.querySelectorAll("button.send-button.submit, button.send-button"),
  ].filter((el) => !isElementDisabled(el));
  if (!composer) return candidates[0] ?? null;
  const composerRoot = composer.closest("rich-textarea, input-area, bard-input, form") || composer.parentElement;
  return candidates.find((button) => composerRoot?.contains(button)) ?? candidates[0] ?? null;
}

export function isGeminiGenerating(doc = document) {
  const controls = [
    ...doc.querySelectorAll("button, [role=button]"),
  ].filter((el) => isLikelyVisible(el) && !isElementDisabled(el));
  return controls.some((el) => {
    const label = [
      el?.getAttribute?.("aria-label") || "",
      el?.getAttribute?.("title") || "",
      el?.getAttribute?.("data-test-id") || "",
      el?.getAttribute?.("data-testid") || "",
    ].join(" ").toLowerCase();
    const testId = [
      el.getAttribute?.("data-test-id") || "",
      el.getAttribute?.("data-testid") || "",
      el.getAttribute?.("class") || "",
    ].join(" ").toLowerCase();
    const iconText = textOf(el.querySelector?.("mat-icon, .mat-icon")).toLowerCase();
    const hasStopIcon = Boolean(el.querySelector?.('svg[aria-label*="stop" i], [data-icon*="stop" i]')) ||
      /stop|\u0e2b\u0e22\u0e38\u0e14/.test(iconText);
    return /stop|interrupt|cancel\s+(generation|response)|cancel.*(generation|response)/.test(label) ||
      /\u0e2b\u0e22\u0e38\u0e14|\u0e22\u0e01\u0e40\u0e25\u0e34\u0e01.*(\u0e01\u0e32\u0e23\u0e2a\u0e23\u0e49\u0e32\u0e07|\u0e04\u0e33\u0e15\u0e2d\u0e1a)/.test(label) ||
      /stop|interrupt|cancel-(generation|response)|cancel.*(generation|response)/.test(testId) ||
      hasStopIcon;
  });
}

export function stripUserPrefix(text) {
  return String(text || "")
    .replace(/^\s*You said\s*/i, "")
    .replace(/^\s*\u0e04\u0e38\u0e13\u0e1a\u0e2d\u0e01\u0e27\u0e48\u0e32\s*/u, "")
    .trim();
}

export function stripAssistantPrefix(text) {
  return String(text || "")
    .replace(/^\s*Show thinking\s*/i, "")
    .replace(/^\s*Gemini said\s*/i, "")
    .replace(/^\s*\u0e41\u0e2a\u0e14\u0e07\u0e27\u0e34\u0e18\u0e35\u0e04\u0e34\u0e14\s*/u, "")
    .replace(/^\s*Gemini \u0e1a\u0e2d\u0e01\u0e27\u0e48\u0e32\s*/u, "")
    .trim();
}

export function extractVisibleTurns(doc = document) {
  const records = [];
  for (const el of doc.querySelectorAll("user-query, model-response")) {
    if (el.matches("user-query")) {
      const rawText = textOf(el);
      records.push({
        index: records.length,
        role: "user",
        roleConfidence: "high",
        source: "visible_dom",
        rawText,
        text: stripUserPrefix(rawText),
      });
      continue;
    }

    const body = el.querySelector("message-content") || el.querySelector(".model-response-text") || el;
    const rawText = textOf(body);
    records.push({
      index: records.length,
      role: "assistant",
      roleConfidence: body === el ? "medium" : "high",
      source: "visible_dom",
      rawText,
      text: stripAssistantPrefix(rawText),
    });
  }
  return records;
}

export function extractAttachmentCandidates(doc = document) {
  const records = [];
  const cards = [
    ...doc.querySelectorAll('.attachment-preview-wrapper, uploader-file-preview, [data-test-id="file-preview"], .file-preview'),
  ];
  const seen = new WeakSet();
  const seenKeys = new Set();
  const seenDisplayKeys = new Set();
  for (const card of cards) {
    if (seen.has(card)) continue;
    seen.add(card);
    const nameEl = card.querySelector?.('[data-test-id="file-name"], .file-name');
    const removeButton = card.querySelector?.('[data-test-id="cancel-button"], button.cancel-button') ||
      card.parentElement?.querySelector?.('[data-test-id="cancel-button"], button.cancel-button') ||
      null;
    const text = textOf(card);
    const name = textOf(nameEl) || text;
    const removeLabel = removeButton?.getAttribute?.("aria-label") || textOf(removeButton);
    if (!name && !removeLabel) continue;
    const displayKey = `${name}|${text}`;
    if (seenDisplayKeys.has(displayKey)) continue;
    seenDisplayKeys.add(displayKey);
    const key = removeLabel || `${name}|${text}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    records.push({
      index: records.length,
      name,
      text,
      removeLabel,
      hasRemoveControl: Boolean(removeButton),
      source: "composer_attachment_preview",
    });
  }
  return records;
}

export function truncateText(text, maxChars) {
  const value = String(text ?? "");
  if (!Number.isInteger(maxChars) || maxChars < 0 || value.length <= maxChars) {
    return { text: value, chars: value.length, returnedChars: value.length, truncated: false, omittedChars: 0 };
  }
  return {
    text: value.slice(0, maxChars),
    chars: value.length,
    returnedChars: maxChars,
    truncated: true,
    omittedChars: value.length - maxChars,
  };
}

export function buildStructuredVisibleDomRead({
  doc = document,
  maxTurns = 6,
  maxCharsPerTurn = 6000,
  includeText = true,
} = {}) {
  const allTurns = extractVisibleTurns(doc);
  const selectedTurns = Number.isInteger(maxTurns) && maxTurns > 0
    ? allTurns.slice(-maxTurns)
    : allTurns;
  const coverageWarnings = ["VISIBLE_DOM_ONLY"];
  if (selectedTurns.length < allTurns.length) coverageWarnings.push("MAX_TURNS_APPLIED");
  if (isGeminiGenerating(doc)) coverageWarnings.push("STREAMING_IN_PROGRESS");

  const turns = selectedTurns.map((turn) => {
    const clipped = truncateText(turn.text, maxCharsPerTurn);
    if (clipped.truncated && !coverageWarnings.includes("TURN_TRUNCATED")) {
      coverageWarnings.push("TURN_TRUNCATED");
    }
    return {
      index: turn.index,
      role: turn.role,
      roleConfidence: turn.roleConfidence,
      source: turn.source,
      chars: clipped.chars,
      returnedChars: includeText ? clipped.returnedChars : 0,
      truncated: clipped.truncated,
      omittedChars: clipped.omittedChars,
      rawTextHadLocalePrefix: turn.rawText !== turn.text,
      ...(includeText ? { text: clipped.text } : {}),
    };
  });

  return {
    mode: "structured_visible_dom",
    completeConversation: false,
    virtualizationPossible: true,
    rawFallbackAvailable: true,
    coverageWarnings,
    totalVisibleTurns: allTurns.length,
    returnedTurnCount: turns.length,
    maxTurnsApplied: Number.isInteger(maxTurns) && maxTurns > 0 ? maxTurns : null,
    maxCharsPerTurn,
    turns,
  };
}

export function getGeminiDomState(doc = document) {
  const composer = findComposer(doc);
  const sendButton = findSendButton(doc);
  const turns = extractVisibleTurns(doc);
  const attachments = extractAttachmentCandidates(doc);
  const lastUser = [...turns].reverse().find((turn) => turn.role === "user") ?? null;
  const lastAssistant = [...turns].reverse().find((turn) => turn.role === "assistant") ?? null;
  return {
    title: doc.title,
    url: doc.location?.href || globalThis.location?.href || "",
    hasComposer: Boolean(composer),
    composerText: textOf(composer),
    sendButtonEnabled: Boolean(sendButton) && !isElementDisabled(sendButton),
    isGenerating: isGeminiGenerating(doc),
    attachmentCount: attachments.length,
    attachmentNames: attachments.map((attachment) => attachment.name).filter(Boolean),
    attachments,
    turnCount: turns.length,
    turns,
    lastUserText: lastUser?.text ?? "",
    lastUserTurnIndex: lastUser?.index ?? -1,
    lastAssistantText: lastAssistant?.text ?? "",
    lastAssistantTurnIndex: lastAssistant?.index ?? -1,
  };
}

export function geminiDomAdapterScript() {
  return String.raw`
    const geminiDomAdapter = (() => {
      const textOf = ${textOf.toString()};
      const labelOf = ${labelOf.toString()};
      const isElementDisabled = ${isElementDisabled.toString()};
      const isLikelyVisible = ${isLikelyVisible.toString()};
      const findComposer = ${findComposer.toString()};
      const findSendButton = ${findSendButton.toString()};
      const isGeminiGenerating = ${isGeminiGenerating.toString()};
      const stripUserPrefix = ${stripUserPrefix.toString()};
      const stripAssistantPrefix = ${stripAssistantPrefix.toString()};
      const extractVisibleTurns = ${extractVisibleTurns.toString()};
      const extractAttachmentCandidates = ${extractAttachmentCandidates.toString()};
      const truncateText = ${truncateText.toString()};
      const buildStructuredVisibleDomRead = ${buildStructuredVisibleDomRead.toString()};
      const getGeminiDomState = ${getGeminiDomState.toString()};
      return {
        textOf,
        labelOf,
        isElementDisabled,
        isLikelyVisible,
        findComposer,
        findSendButton,
        isGeminiGenerating,
        stripUserPrefix,
        stripAssistantPrefix,
        extractVisibleTurns,
        extractAttachmentCandidates,
        truncateText,
        buildStructuredVisibleDomRead,
        getGeminiDomState,
      };
    })();
  `;
}
