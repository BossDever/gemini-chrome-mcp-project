# Stable Baseline

Baseline date: 2026-05-15

This project has a first CDP-only Gemini MCP milestone. It is not yet at feature
parity with the ChatGPT MCP project, but the core architecture is in place:

- CDP tab discovery and opening
- path-local tab binding under `.gemini-chrome-mcp/bindings/`
- strict binding checks
- raw and conservative structured read modes
- Gemini-specific DOM adapter
- base64 message input for write safety
- send and send-and-wait tools
- per-tab CDP write locks with operation timeout and websocket cleanup
- strict own-turn verification for submitted messages
- local upload file safety metadata and blocking for executable-style files
- CDP file upload and pending attachment removal
- GitHub repository code import through Gemini's Import code dialog
- fail-closed GitHub consent matching and repository URL parsing
- check and smoke scripts
- DOM fixture tests

## Verification

```powershell
npm run check
npm run smoke:mcp -- --require-cdp --require-binding
npm run smoke:mcp -- --require-cdp --require-binding --dry-run-send
npm run smoke:mcp -- --require-cdp --require-binding --dry-run-send --upload-remove-file C:\path\to\small.txt
```

Current tests: 19/19.

## Known Boundaries

- Download tools are not implemented.
- Upload/remove is implemented through CDP file chooser interception and
  in-tab mouse events. Live smoke verified upload creates one pending attachment
  and removal returns the composer to zero pending attachments.
- Upload safety blocks executable-style extensions by default and enforces a
  size limit. Set `GEMINI_MCP_UPLOAD_MAX_BYTES` to tune the limit, or
  `GEMINI_MCP_ALLOW_UNSAFE_UPLOAD=1` only when intentionally testing unsafe
  local files.
- GitHub repository import is implemented with `allowGithubConnect=false` by
  default. Public repo import was live-tested with
  `https://github.com/BossDever/gemini-chrome-mcp-project.git`, producing one
  pending GitHub attachment and then removing it cleanly.
- GitHub consent automation now matches action labels instead of button order.
  If Gemini shows an unrecognized or ambiguous consent dialog, the import fails
  closed instead of clicking through.
- `gemini_cdp_send_and_wait` is early and needs more live fixtures. Its default
  timeout is intentionally below common 60s MCP client timeouts. In one live
  test, Gemini accepted the user turn but did not return an assistant response
  before the MCP client timeout.
- Generating detection uses visible stop controls, including Thai labels and
  structural stop indicators. Page-level spinners can represent side-nav/history
  loading and are intentionally ignored.
- Structured read is visible DOM only, not a full transcript export.
