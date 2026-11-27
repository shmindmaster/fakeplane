# Security

The tool is a gate against indirect prompt injection hidden in documents.
It is not a guarantee that a model will ignore a visible instruction.

- Default `--fail-on high` blocks hidden instructions and lets a visible
  quotation of an attack through. Use `--fail-on medium` when hidden
  non-instruction text must also stop the pipeline.
- The scanner does not phone home and does not need a secret.
- Do not log the full extracted text of a customer document in CI output
  unless that document is a fixture.
- A covered-text finding is also how a failed redaction looks. Treat it as
  a block, not as a warning to ignore.
- Report parser bypasses as security issues. `SECURITY.md` at the repo root
  is the GitHub policy entry.
