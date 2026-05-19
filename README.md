# Gemini Chrome MCP

Separate Gemini-specific Chrome MCP server.

This project should reuse the proven patterns from
`../chatgpt-chrome-mcp-project` without mixing provider-specific code:

- CDP tab binding with `sessionName`
- path-local runtime bindings under `.gemini-chrome-mcp/`
- per-tab write locks
- conservative read modes
- upload/remove smoke only if Gemini UI supports it safely
- metadata-only audit logs
- file safety checks
- operations docs and known limitations

## Current Milestone

The first implementation milestone is CDP-only and provider-specific:

- `chrome_cdp_status`
- `chrome_cdp_launch`
- `chrome_cdp_list_tabs`
- `chrome_cdp_open_tab`
- `gemini_cdp_bind_tab`
- `gemini_cdp_get_bound_tab`
- `gemini_cdp_get_state`
- `gemini_cdp_list_artifacts`
- `gemini_cdp_select_toolbox_mode`
- `gemini_cdp_import_code_repository`
- `gemini_cdp_read`
- `gemini_cdp_upload_file`
- `gemini_cdp_remove_attachments`
- `gemini_cdp_send`
- `gemini_cdp_send_and_wait`
- `gemini_cdp_save_generated_image`
- `gemini_cdp_generate_image_and_save`

The stable path starts with launching or reusing a CDP Chrome profile, tab
binding, and read/state tools. `chrome_cdp_launch` opens the Chrome profile and
reports whether the Gemini composer is ready. If login is needed, finish it in
the opened Chrome window and tell the agent to continue; pass `waitForReadyMs`
only when a blocking wait is desired, and `bindSessionName` to bind an already
ready tab automatically.
`gemini_cdp_send`
supports `messageBase64` so Thai and unusual symbols do not pass through lossy
shell encoding. `gemini_cdp_send_and_wait` has a live smoke path and should be
rechecked against real Gemini UI changes before releases.
Write workflows use per-tab CDP locks with operation timeouts and session
cleanup. Submitted messages are verified against the advanced user turn text
instead of accepting any turn count change.
`gemini_cdp_upload_file` and `gemini_cdp_remove_attachments` use CDP file
chooser interception and in-tab mouse events, so they do not take over the
Windows mouse cursor. Uploads are checked for file type, size, SHA-256, and
blocked executable-style extensions before Gemini sees the file.
`gemini_cdp_import_code_repository` automates Gemini's "Import code" GitHub URL
workflow and declines GitHub account connection by default unless explicitly
allowed. GitHub consent matching is fail-closed and repository URLs are parsed
as GitHub URLs before any UI action.
`gemini_cdp_list_artifacts` is a read-only diagnostic for image/download
workflows. It reports visible images, likely generated images, and download-like
controls without clicking them. It also reports Gemini image placeholders such
as `[Image: ...]` when the image tool produces a textual placeholder instead of
a downloadable file.
`gemini_cdp_save_generated_image` saves a visible generated image from the bound
tab. It tries source bytes first and falls back to canvas PNG when Gemini uses a
blob URL that cannot be fetched directly. The result includes file path, MIME,
dimensions, SHA-256, candidate details, and warnings such as
`CANVAS_FALLBACK_USED`.
`gemini_cdp_generate_image_and_save` is the one-call image workflow: it selects
image mode, sends the prompt, waits for a new generated image artifact, saves
it, and returns file metadata. Use this instead of manually chaining mode
selection, send, artifact polling, and save calls.
`gemini_cdp_select_toolbox_mode` can select Gemini toolbar modes such as
`image`, `video`, `music`, or `canvas` before sending a prompt.

Run checks with:

```powershell
npm run check
npm run smoke:mcp -- --require-cdp --require-binding
npm run smoke:mcp -- --require-cdp --require-binding --dry-run-send
npm run smoke:mcp -- --require-cdp --require-binding --live-send-and-wait
npm run smoke:mcp -- --require-cdp --require-binding --dry-run-send --upload-remove-file C:\path\to\small.txt
npm run smoke:mcp -- --require-cdp --require-binding --generate-image-save
```

The `--live-send-and-wait` smoke sends a real Gemini message in the bound tab.
The `--generate-image-save` smoke is intentionally optional because it creates a
real Gemini image and may consume quota or wait on provider-side generation.

## Operations

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for the day-to-day runbook and
[docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) for remaining provider
constraints.

## Add To Codex

```powershell
codex mcp add gemini-chrome -- node C:\Users\suwit\Desktop\MCP\gemini-chrome-mcp-project\src\server.mjs
codex mcp list
```

From the workspace root, you can register both provider MCP servers with:

```powershell
.\scripts\register-codex-mcp.ps1
```

Restart Codex after adding or changing MCP server entries.

## Initial Direction

Start with a small Gemini-specific baseline:

1. Identify Gemini URL and tab binding rules.
2. Build a `gemini-dom-adapter.mjs` from real Gemini DOM fixtures.
3. Add read/state tools before any write tools.
4. Add send-and-wait only after state and turn extraction are reliable.
5. Add upload/remove only after live UI behavior is understood.

Do not copy ChatGPT selectors directly. Gemini needs its own fixtures, role
detection, composer detection, send-button detection, and safety checks.

Current discovery notes live in [docs/DISCOVERY.md](docs/DISCOVERY.md).
