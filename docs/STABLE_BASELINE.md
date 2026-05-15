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
- CDP file upload and pending attachment removal
- check and smoke scripts
- DOM fixture tests

## Verification

```powershell
npm run check
npm run smoke:mcp -- --require-cdp --require-binding
npm run smoke:mcp -- --require-cdp --require-binding --dry-run-send
npm run smoke:mcp -- --require-cdp --require-binding --dry-run-send --upload-remove-file C:\path\to\small.txt
```

Current tests: 9/9.

## Known Boundaries

- Download tools are not implemented.
- Upload/remove is implemented through CDP file chooser interception and
  in-tab mouse events. Live smoke verified upload creates one pending attachment
  and removal returns the composer to zero pending attachments.
- `gemini_cdp_send_and_wait` is early and needs more live fixtures. Its default
  timeout is intentionally below common 60s MCP client timeouts. In one live
  test, Gemini accepted the user turn but did not return an assistant response
  before the MCP client timeout.
- Generating detection currently uses explicit stop controls only. Page-level
  spinners can represent side-nav/history loading and are intentionally ignored.
- Structured read is visible DOM only, not a full transcript export.
