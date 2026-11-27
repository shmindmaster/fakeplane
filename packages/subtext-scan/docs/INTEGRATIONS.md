# Integrations

| Piece | Role |
| --- | --- |
| `pdfjs-dist` | PDF text and geometry |
| `pdf-lib` | Builds the fixtures. Dev dependency |
| `htmlparser2` | HTML |
| `fflate` | DOCX zip |
| `@modelcontextprotocol/server` | MCP server |
| `@modelcontextprotocol/client` | MCP test client. Dev dependency |
| `zod` | MCP and option schemas |

There is no model provider, no cloud account, and no webhook. A pipeline
gate shells out to the CLI and treats exit 1 as "do not ingest this file".
