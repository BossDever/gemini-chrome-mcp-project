import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";

import {
  buildStructuredVisibleDomRead,
  extractAttachmentCandidates,
  extractVisibleTurns,
  findComposer,
  findSendButton,
  getGeminiDomState,
} from "../src/gemini-dom-adapter.mjs";

test("findComposer targets Gemini editor and ignores Quill clipboard", () => {
  const document = parseHTML(`
    <div class="ql-clipboard" contenteditable="true"></div>
    <div class="ql-editor ql-blank textarea new-input-ui" role="textbox" aria-label="Prompt" contenteditable="true"></div>
  `).document;
  assert.equal(findComposer(document)?.classList.contains("ql-editor"), true);
});

test("findSendButton uses the composer send button, not side-nav history", () => {
  const document = parseHTML(`
    <a role="button" data-test-id="conversation">เรื่องที่มีคำว่า send file</a>
    <div class="input-area">
      <div class="ql-editor" role="textbox" contenteditable="true"></div>
      <button class="send-button submit" aria-label="ส่งข้อความ"></button>
    </div>
  `).document;
  assert.equal(findSendButton(document)?.tagName.toLowerCase(), "button");
  assert.equal(findSendButton(document)?.classList.contains("send-button"), true);
});

test("extractVisibleTurns extracts user and assistant body text", () => {
  const document = parseHTML(`
    <chat-window-content>
      <user-query>คุณบอกว่า\n\nHello Gemini</user-query>
      <model-response>
        <response-container>Gemini บอกว่า\n\nNoisy wrapper</response-container>
        <message-content>Gemini บอกว่า\n\nHello user</message-content>
      </model-response>
    </chat-window-content>
  `).document;
  const turns = extractVisibleTurns(document);
  assert.deepEqual(turns.map((turn) => ({ role: turn.role, text: turn.text })), [
    { role: "user", text: "Hello Gemini" },
    { role: "assistant", text: "Hello user" },
  ]);
});

test("structured visible DOM read reports visible-only and truncation metadata", () => {
  const document = parseHTML(`
    <user-query>You said\n\nQuestion</user-query>
    <model-response><message-content>This is a deliberately long answer.</message-content></model-response>
    <button aria-label="Stop generating"></button>
  `).document;
  const result = buildStructuredVisibleDomRead({ doc: document, maxTurns: 1, maxCharsPerTurn: 10 });
  assert.equal(result.completeConversation, false);
  assert.equal(result.virtualizationPossible, true);
  assert.deepEqual(result.coverageWarnings, ["VISIBLE_DOM_ONLY", "MAX_TURNS_APPLIED", "STREAMING_IN_PROGRESS", "TURN_TRUNCATED"]);
  assert.equal(result.turns[0].role, "assistant");
  assert.equal(result.turns[0].text, "This is a ");
  assert.equal(result.turns[0].truncated, true);
});

test("getGeminiDomState returns conservative state", () => {
  const document = parseHTML(`
    <div class="ql-editor" role="textbox" contenteditable="true">draft</div>
    <button class="send-button submit" aria-label="Send"></button>
    <user-query>You said\n\nQuestion</user-query>
    <model-response><message-content>Answer</message-content></model-response>
  `).document;
  const state = getGeminiDomState(document);
  assert.equal(state.hasComposer, true);
  assert.equal(state.composerText, "draft");
  assert.equal(state.sendButtonEnabled, true);
  assert.equal(state.turnCount, 2);
  assert.equal(state.lastUserText, "Question");
  assert.equal(state.lastAssistantText, "Answer");
});

test("attachment extraction deduplicates Gemini file preview controls", () => {
  const document = parseHTML(`
    <div class="attachment-preview-wrapper">
      <uploader-file-preview>
        <div data-test-id="file-preview">
          <div data-test-id="file-name">gemini-mcp...load-smoke</div>
          <button data-test-id="cancel-button" aria-label="Remove gemini-mcp-upload-smoke.txt"></button>
        </div>
      </uploader-file-preview>
    </div>
  `).document;
  const attachments = extractAttachmentCandidates(document);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].name, "gemini-mcp...load-smoke");
  assert.equal(attachments[0].hasRemoveControl, true);
  assert.equal(attachments[0].removeLabel, "Remove gemini-mcp-upload-smoke.txt");
});
