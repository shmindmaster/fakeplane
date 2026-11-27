# Architecture

One Node library. No server.

| Path | Owns |
| --- | --- |
| `src/pdf.mjs` | PDF text, colour, clip, optional content, annotations, metadata |
| `src/docx.mjs` | DOCX runs, vanish, comments, tracked deletions, properties |
| `src/html.mjs` | CSS hiding, off-page placement, comments, alt and meta |
| `src/phrases.mjs` | Ten instruction-phrasing rules |
| `src/unicode.mjs` | Tag characters, bidi overrides, zero-width runs |
| `src/text.mjs` | Shared text decisions |
| `src/mcp.mjs` | MCP server |
| `bin/subtext-scan.mjs` | CLI |
| `fixtures/` | Generated corpus the tests scan |
| `infra/docker/Dockerfile` | Node 22 image |

`scan` returns findings. `exceeds(result, severity)` is the gate. The CLI exits 0 when nothing meets `--fail-on` (default `high`), 1 when something does, and 2 when a file cannot be scanned.
