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
- `chrome_cdp_list_tabs`
- `chrome_cdp_open_tab`
- `gemini_cdp_bind_tab`
- `gemini_cdp_get_bound_tab`
- `gemini_cdp_get_state`
- `gemini_cdp_read`
- `gemini_cdp_send`
- `gemini_cdp_send_and_wait`

The stable path starts with tab binding and read/state tools. `gemini_cdp_send`
supports `messageBase64` so Thai and unusual symbols do not pass through lossy
shell encoding. `gemini_cdp_send_and_wait` exists, but should be treated as
early hardening work until more live Gemini response fixtures are collected.

Run checks with:

```powershell
npm run check
npm run smoke:mcp -- --require-cdp --require-binding
npm run smoke:mcp -- --require-cdp --require-binding --dry-run-send
```

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
