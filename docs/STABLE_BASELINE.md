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
- check and smoke scripts
- DOM fixture tests

## Verification

```powershell
npm run check
npm run smoke:mcp -- --require-cdp --require-binding
```

Current tests: 8/8.

## Known Boundaries

- Upload/download tools are not implemented.
- `gemini_cdp_send_and_wait` is early and needs more live fixtures. In one live
  test, Gemini accepted the user turn but did not return an assistant response
  before the MCP client timeout.
- Generating detection currently uses explicit stop controls only. Page-level
  spinners can represent side-nav/history loading and are intentionally ignored.
- Structured read is visible DOM only, not a full transcript export.
