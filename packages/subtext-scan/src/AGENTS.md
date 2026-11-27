# src

The root `AGENTS.md` applies.

`pdf.mjs`, `docx.mjs`, and `html.mjs` are the format readers. `phrases.mjs`
is the instruction rules. `unicode.mjs` is hidden Unicode. `mcp.mjs` is the
MCP server. `index.mjs` is the public `scan` and `exceeds` API. Keep parsers
free of network calls.
