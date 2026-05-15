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
- Record selectors and pitfalls in `docs/DISCOVERY.md`.

## Phase 2: Read-Only Baseline

- Implement low-level CDP tab connection and binding.
- Implement `gemini_cdp_get_state`.
- Implement `gemini_cdp_read` with raw and conservative structured modes.
- Support `messageBase64` before any write workflow so Thai and unusual symbols
  do not pass through lossy shell encoding.
- Add DOM fixture tests and tool-registration tests.
- Add `npm run check` and `npm run smoke:mcp`.

Status: mostly implemented for the first milestone. More fixtures are still
needed before treating send-and-wait as stable.

## Phase 3: Write Workflow

- Implement `gemini_cdp_send` only after state extraction is reliable.
- Add own-turn verification or an equivalent Gemini-specific submit check.
- Add `gemini_cdp_send_and_wait`.
- Add per-tab write locks.

Status: implemented for the first milestone. `send_and_wait` still needs more
live fixtures because Gemini response timing can differ from ChatGPT.

## Phase 4: Files And Safety

- Investigate Gemini upload UI.
- Add file safety validation before uploads.
- Add live upload/remove smoke only if the UI can be controlled without risking
  user data.

Status: upload/remove is implemented through CDP file chooser interception and
in-tab mouse events. Next hardening step is stricter file safety policy and more
attachment fixtures.

## Phase 5: Code Repository Import

- Import public GitHub repository links through Gemini's Import code dialog.
- Decline GitHub account connection by default.
- Treat the resulting GitHub preview as a pending attachment and support remove.

Status: implemented and live-tested with this repo.

## Avoid Initially

- Playwright adapter
- cross-provider abstraction
- auto watcher/background responder
- distributed multi-process lock
- copying ChatGPT DOM selectors without Gemini fixtures
