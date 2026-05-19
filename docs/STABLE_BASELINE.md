# Stable Baseline

Baseline date: 2026-05-15

This project has a hardened CDP-only Gemini MCP baseline. It is close to the
ChatGPT MCP CDP path for core read/write workflows, while still lacking the
ChatGPT project's UIA fallback and download tooling:

- CDP Chrome launch, tab discovery, and opening
- path-local tab binding under `.gemini-chrome-mcp/bindings/`
- strict binding checks
- raw and conservative structured read modes
- read-only visible artifact diagnostics for image/download workflows
- Gemini toolbox mode selection for image/video/music/canvas workflows
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
- live send-and-wait smoke
- DOM fixture tests

## Verification

```powershell
npm run check
npm run smoke:mcp -- --require-cdp --require-binding
npm run smoke:mcp -- --require-cdp --require-binding --dry-run-send
npm run smoke:mcp -- --require-cdp --require-binding --live-send-and-wait
npm run smoke:mcp -- --require-cdp --require-binding --dry-run-send --upload-remove-file C:\path\to\small.txt
npm run smoke:mcp -- --require-cdp --require-binding --generate-image-save
```

Current tests: 30/30.

Latest local verification on 2026-05-16:

```powershell
npm run check
npm run smoke:mcp
npm run smoke:mcp -- --require-cdp --require-binding
npm run smoke:mcp -- --require-cdp --require-binding --dry-run-send
npm run smoke:mcp -- --require-cdp --require-binding --live-send-and-wait
```

All passed against the workspace CDP Chrome profile on `127.0.0.1:9222`.
The live send-and-wait smoke completed in about 9.1 seconds. Gemini changed the
conversation URL/title after the first real send; strict binding now treats
same-tab Gemini URL/title drift as non-fatal warnings while still blocking
missing tabs, base URL overrides, or non-Gemini tabs.

## Known Boundaries

- Generic download-click tools are not implemented. Image workflows can still
  inspect visible artifacts and save visible generated images through
  `gemini_cdp_list_artifacts`, `gemini_cdp_save_generated_image`, and
  `gemini_cdp_generate_image_and_save`.
- Image generation was tried live on 2026-05-15. Gemini accepted the prompt but
  the current page/model first responded that it could not directly output image
  files. After selecting the toolbar `image` mode, Gemini routed the request to
  `gemini-3-pro-image-preview` but rendered a textual `[Image: ...]`
  placeholder instead of an `<img>`, blob, or download control. This means there
  was still no local file to download from the DOM. `gemini_cdp_list_artifacts`
  reports both real image/download artifacts and these placeholders.
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
- `gemini_cdp_send_and_wait` has a passing live smoke, but Gemini can still
  rate limit, delay, or change its DOM. Keep the live smoke in release checks
  when validating against a new Gemini UI.
- Generating detection uses visible stop controls, including Thai labels and
  structural stop indicators. Page-level spinners can represent side-nav/history
  loading and are intentionally ignored.
- Structured read is visible DOM only, not a full transcript export.
