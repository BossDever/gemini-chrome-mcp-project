# Gemini Chrome MCP

Workspace for a separate Gemini-specific Chrome MCP server.

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
