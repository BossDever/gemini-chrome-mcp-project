# Gemini MCP Plan

## Goal

Create a separate Gemini Chrome MCP server for local browser automation. Keep it
provider-specific and independent from the stable ChatGPT MCP project.

## Phase 1: Discovery

- Open Gemini in CDP Chrome.
- Confirm supported hostnames.
- Inspect composer, send button, stop button, response containers, attachments,
  and any file upload behavior.
- Capture a static Gemini-like fixture for tests.

## Phase 2: Read-Only Baseline

- Implement low-level CDP tab connection and binding.
- Implement `gemini_cdp_get_state`.
- Implement `gemini_cdp_read` with raw and conservative structured modes.
- Add DOM fixture tests and tool-registration tests.
- Add `npm run check` and `npm run smoke:mcp`.

## Phase 3: Write Workflow

- Implement `gemini_cdp_send` only after state extraction is reliable.
- Add own-turn verification or an equivalent Gemini-specific submit check.
- Add `gemini_cdp_send_and_wait`.
- Add per-tab write locks.

## Phase 4: Files And Safety

- Investigate Gemini upload UI.
- Add file safety validation before uploads.
- Add live upload/remove smoke only if the UI can be controlled without risking
  user data.

## Avoid Initially

- Playwright adapter
- cross-provider abstraction
- auto watcher/background responder
- distributed multi-process lock
- copying ChatGPT DOM selectors without Gemini fixtures
