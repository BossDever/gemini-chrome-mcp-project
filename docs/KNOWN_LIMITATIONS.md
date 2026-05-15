# Gemini Chrome MCP Known Limitations

- Gemini generated images commonly use `blob:` URLs that cannot be fetched
  directly from page JavaScript. The saver falls back to canvas PNG and reports
  this explicitly.
- Canvas fallback preserves rendered pixels but not original image bytes,
  original file metadata, compression, color profiles, original filename, or
  original MIME. Save results report `originalBytesPreserved=false`,
  `metadataPreserved=false`, and `originalMimePreserved=false` for this path.
- If browser canvas export is blocked by CORS/tainting, the result reports
  `CANVAS_EXPORT_FAILED` and `canvasTainted=true`.
- Network response capture for original image bytes is not implemented yet.
  It should be enabled before generation starts if added later.
- `gemini_cdp_generate_image_and_save` waits for a new visible generated image
  artifact. If Gemini returns only a textual placeholder or refuses the prompt,
  the tool times out with `GEMINI_GENERATED_IMAGE_WAIT_TIMEOUT`.
- Live image smoke is optional because it can consume quota, trigger provider
  rate limits, and takes longer than normal checks.
- The tool controls one bound tab at a time. Multiple agents should use
  different `sessionName` bindings when they need independent Gemini tabs.
