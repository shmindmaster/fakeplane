# Security policy

## Supported versions

Security fixes target `main` and the latest release. The project is pre-1.0 and has no long-term support line.

## Report a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not open a public issue for a suspected vulnerability.

Include a synthetic document that reproduces the problem (never a real one), the command or API call, the expected result and the observed result.

## In scope

- **A hiding technique that a person cannot see, that a common extractor returns, and that the scanner does not report.** This is a detection bypass, and it is the most valuable kind of report.
- A crafted file that crashes the scanner, hangs it, or makes it use unbounded memory.
- Output that lets a document escape the terminal report: raw control or escape sequences, or hidden characters that are not shown.
- An MCP tool result that includes hidden text when `include_text` is false, or a path read outside `--root`.

The documented limits in the README (no rendering, no OCR, no font forensics, English phrase rules, a partial CSS model) are known gaps, not vulnerabilities. Reports that close one of them are still welcome as feature requests.

## Handling untrusted documents

The scanner parses hostile files. It uses pdf.js with `isEvalSupported: false`. It never runs document JavaScript, fetches remote resources or writes files. Run it with the least privilege your pipeline allows, as you would any parser.
