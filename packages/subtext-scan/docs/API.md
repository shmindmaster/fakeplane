# API

CLI:

```text
subtext-scan scan file.pdf
subtext-scan scan *.pdf *.docx --json
subtext-scan scan upload.pdf --fail-on medium
```

Stdin is `-`. `--json` prints one object per file. `-q` is quiet.

| Exit | Meaning |
| --- | --- |
| 0 | Nothing at or above `--fail-on` |
| 1 | At least one finding at or above `--fail-on` |
| 2 | Missing, encrypted, or unsupported file, or bad arguments |

Library:

```js
import { scan, exceeds } from 'subtext-scan';

const result = await scan('upload.pdf');
if (exceeds(result, 'high')) quarantine(result.findings);
```

`scan(bytes, { name })` accepts a buffer. Each finding has `severity`,
`rule`, `page`, `bbox`, and `reason`.

MCP entry is `subtext-scan/mcp` (`src/mcp.mjs`).
