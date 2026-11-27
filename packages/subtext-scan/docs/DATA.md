# Data

No database. The corpus is `fixtures/`, produced by
`scripts/generate-fixtures.mjs`. Tests fail when a fixture drifts from that
generator.

A scan result is in memory: the file name, the format, page count, and the
finding list. Nothing is written next to the input file. The CLI prints
text or JSON to stdout.

Do not commit a document that contains someone else's real customer data.
Fixtures are synthetic.
