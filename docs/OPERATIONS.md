# Gemini Chrome MCP Operations

## Stable Workflow

1. Start or reuse a Chrome instance with CDP on `127.0.0.1:9222`.
2. Bind the intended Gemini tab with `gemini_cdp_bind_tab`.
3. Use `strictBinding=true` for write operations so stale or wrong tabs fail.
4. Prefer `messageBase64` for Thai or unusual characters.
5. Use `gemini_cdp_generate_image_and_save` for image generation instead of
   manually chaining toolbox selection, send, polling, and save.

From the workspace root, start the shared local CDP profile with:

```powershell
.\scripts\start-cdp-chrome.ps1 -Url https://gemini.google.com/app
```

When launching through MCP `chrome_cdp_launch`, the tool opens Chrome and
reports whether the Gemini composer is already ready. If the profile is new,
log in inside the Chrome window that opens, then tell the agent you are done so
it can bind/check the tab. Pass `bindSessionName: "default"` to bind
automatically only when the composer is already visible. Set `waitForReadyMs`
explicitly when a blocking wait is desired.

Register the Gemini MCP server in Codex with:

```powershell
.\scripts\register-codex-mcp.ps1 -SkipChatGpt
```

## Image Generation

`gemini_cdp_generate_image_and_save` performs the full image path:

- captures the current visible generated image set,
- selects Gemini image mode,
- sends the prompt,
- polls until a new generated image appears,
- saves the newest generated image,
- returns file path, SHA-256, dimensions, source kind, save method, and warnings.

Gemini often exposes generated images as `blob:` URLs. When direct source fetch
fails, the saver falls back to a canvas PNG export and returns
`CANVAS_FALLBACK_USED`. This is expected for current Gemini image UI behavior.
Canvas fallback returns `originalBytesPreserved=false`, `metadataPreserved=false`,
and `originalMimePreserved=false` because it saves rendered pixels as PNG rather
than the provider's original artifact bytes.

## Checks

```powershell
npm run check
npm run smoke:mcp
npm run smoke:mcp -- --require-cdp --require-binding
npm run smoke:mcp -- --require-cdp --require-binding --dry-run-send
npm run smoke:mcp -- --require-cdp --require-binding --live-send-and-wait
npm run smoke:mcp -- --require-cdp --require-binding --generate-image-save
```

`--live-send-and-wait` sends a real message in the bound Gemini tab and should
only be run when changing the conversation is acceptable.

Only run `--generate-image-save` when a real generated image smoke is intended,
because it can consume provider quota and takes longer than normal smoke tests.

## Audit

Write tools append metadata-only audit records under
`.gemini-chrome-mcp/audit/YYYY-MM-DD.jsonl`. The audit log stores hashes and
safe metadata only. It does not store raw prompts, raw URLs, full file paths, or
attachment filter text.

Audited tools include send, send-and-wait, upload, remove, toolbox selection,
repository import, save-generated-image, and generate-image-and-save.
