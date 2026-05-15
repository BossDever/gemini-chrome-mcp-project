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

An offline saved Gemini HTML snapshot was also checked locally. It confirmed
that selector strings such as `ql-editor`, `send-button`, `user-query`,
`model-response`, `message-content`, and `mat-progress-spinner` are present in
Gemini's rendered page assets. The snapshot itself is intentionally not copied
into this repo because saved web pages can contain account/session metadata and
large generated assets.

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

Later live upload testing showed that plain DOM `element.click()` on Gemini's
upload controls does not reliably open a CDP `Page.fileChooserOpened` event.
Using `Input.dispatchMouseEvent` inside the target tab against
`[data-test-id="local-images-files-uploader-button"]` does open the chooser
without taking over the Windows mouse cursor. After `DOM.setFileInputFiles`,
Gemini renders pending files under selectors such as:

```text
.attachment-preview-wrapper
uploader-file-preview
[data-test-id="file-preview"]
[data-test-id="file-name"]
[data-test-id="cancel-button"]
```

The cancel button contains the full filename in its `aria-label`, while the
visible chip may truncate long names.

## Code Import

Gemini's upload menu includes:

```text
[data-test-id="code-import-button"]
```

Clicking it opens an Import code dialog with:

```text
[data-test-id="repo-url-input"]
[data-test-id="import-repository-button"]
```

Live testing with
`https://github.com/BossDever/gemini-chrome-mcp-project.git` showed Gemini
validates the repo as `bossdever/gemini-chrome-mcp-project` and renders a
pending GitHub attachment:

```text
[data-test-id="code-link-preview"]
visible name: bossdever/...cp-project
type: GitHub
cancel aria-label: นำไฟล์ bossdever/gemini-chrome-mcp-project ออก
```

If Gemini asks to connect GitHub, decline by default for public repositories.
That avoids granting account-level GitHub access unless the caller explicitly
opts in.

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

## Conversation DOM After A Test Prompt

A harmless prompt was submitted through CDP to create a real conversation. The
write succeeded, but the Thai text became `????` because the shell script passed
Thai directly through a lossy command encoding path. Gemini implementation must
use UTF-8 base64 message input, like the ChatGPT MCP project, before writing to
the composer.

After submit, Gemini navigated to a conversation URL:

```text
https://gemini.google.com/app/1254be877f795ced?pli=1
```

The page title became:

```text
MCP: Gemini's Actionable AI Bridge - Google Gemini
```

### User Turn

Observed user-turn containers:

```text
user-query
.query-text
```

Example structure:

```html
<user-query class="ng-star-inserted">
  คุณบอกว่า

  ????? MCP Gemini: ??????? ? ??? ??????
</user-query>

<div class="query-text gds-body-l" role="heading">
  คุณบอกว่า

  ????? MCP Gemini: ??????? ? ??? ??????
</div>
```

The user text includes Gemini's localized prefix (`คุณบอกว่า`). The DOM adapter
should strip that prefix only in a locale-aware and tested way, or preserve raw
text with metadata until enough fixtures exist.

### Model Turn

Observed model-turn containers:

```text
model-response
response-container
message-content
.model-response-text
```

Best initial extraction target:

```css
model-response message-content
```

`response-container` and `model-response` include extra labels such as
`แสดงวิธีคิด` and `Gemini บอกว่า`, while `message-content` contained the model
answer body more cleanly.

`.model-response-text` was a custom `structured-content-container` element:

```html
<structured-content-container
  class="model-response-text has-thoughts contains-extensions-response processing-state-visible ...">
  ...
</structured-content-container>
```

The `processing-state-visible` class appeared on response content, but a later
live state check showed it can remain after the answer is effectively usable. Do
not use that class alone as a generating signal. Page-level
`mat-progress-spinner` elements can also represent side-nav/history loading, not
model generation. Prefer explicit stop controls until response-scoped progress
selectors are verified.

### Turn Extraction Guidance

Initial conservative turn extraction can use:

- user turns: `user-query`
- assistant turns: `model-response message-content`

Pair turns by DOM order rather than assuming each user turn always has one
assistant response. Return `completeConversation=false` and
`virtualizationPossible=true` until older-history behavior is understood.

### Encoding Guidance

Do not send Thai or unusual symbols from shell text directly. The first live
write produced:

```text
????? MCP Gemini: ??????? ? ??? ??????
```

The Gemini MCP server should accept `messageBase64` and decode UTF-8 before DOM
injection. It should also keep a suspicious-text guard for long `????` runs, as
the ChatGPT MCP server does.
