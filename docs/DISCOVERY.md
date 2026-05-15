# Gemini DOM Discovery

Discovery date: 2026-05-15

Gemini was open and logged in at:

```text
https://gemini.google.com/app?pli=1
```

CDP tab observed:

```text
title: Google Gemini
tabId: 42E76C5740048DEEB510C18CF7DFB14D
```

## Initial Page State

The inspected page was the Gemini start screen, not an active conversation. It
showed Thai UI text:

```text
การสนทนากับ Gemini
สวัสดี คุณ Suwit
จะให้เราทำอะไรให้บ้าง
```

Because there were no user/model turns in the visible chat area yet, turn
extraction still needs discovery from a real conversation.

## Composer

The prompt composer is a Quill contenteditable editor:

```html
<div
  class="ql-editor ql-blank textarea new-input-ui"
  role="textbox"
  aria-label="ป้อนพรอมต์สำหรับ Gemini"
  contenteditable="true">
</div>
```

Candidate selector:

```css
.ql-editor[contenteditable="true"][role="textbox"]
```

Use a container/visibility check before writing, because Quill also creates a
`div.ql-clipboard[contenteditable="true"]` helper that must not be targeted.

## Send Button

The visible send button appeared as:

```html
<button
  class="mdc-icon-button mat-mdc-icon-button mat-mdc-button-base send-button ... submit ..."
  aria-label="ส่งข้อความ">
</button>
```

Candidate selector:

```css
button.send-button.submit
```

Important: do not detect the send button with broad text matching across all
`[role=button]` elements. Gemini side-nav conversation titles can contain words
like "ส่ง" or "file", so broad text/label matching can select a history item
instead of the composer send button.

## Upload Controls

Upload-related buttons were visible:

```html
<button class="upload-card-button open ..." aria-label="เปิดเมนูอัปโหลดไฟล์">
</button>

<button class="hidden-local-upload-button" data-test-id="hidden-local-image-upload-button">
</button>

<button class="hidden-local-file-upload-button" data-test-id="hidden-local-file-upload-button">
</button>
```

Upload support should not be implemented until the file chooser and attachment
state are inspected in a live test. The first Gemini MCP baseline should stay
read-only.

## Visible Containers

Observed top-level chat containers:

```text
chat-window
chat-window-content
assistant-messages-primary
```

On the start screen, `assistant-messages-primary` contained only the greeting:

```text
จะให้เราทำอะไรให้บ้าง
```

Potential conversation selectors that were empty on the start screen:

```text
query-content
model-response
message-content
user-query
```

These should be re-inspected after sending a harmless test prompt.

## Initial Adapter Guidance

Start with read-only DOM helpers:

- `findComposer(doc)`: target `.ql-editor[contenteditable=true][role=textbox]`,
  excluding `.ql-clipboard`.
- `findSendButton(doc)`: prefer `button.send-button.submit` near the composer.
- `extractVisibleTurns(doc)`: do not guess until a real conversation fixture is
  captured.
- `getState(doc)`: return `hasComposer`, `composerText`, `sendButtonEnabled`,
  `isGenerating`, and conservative `coverageWarnings`.

## Next Discovery Step

Use CDP to create or open a harmless Gemini conversation, then inspect:

- user turn element
- model response element
- streaming state / stop button
- final assistant response state
- any copy/code block controls
- whether old turns remain in the DOM or are virtualized
