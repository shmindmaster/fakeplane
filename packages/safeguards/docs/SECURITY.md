# Security

This repository stores no third-party prompt text and no personal data. Each row identifies a prompt by upstream path, a link at a pinned commit, and content hashes.

`scoring/score.py` builds every output in memory and refuses to write if any 40-character run of prompt text appears, in raw, whitespace-collapsed, or JSON-escaped form. The only fields left out of that scan are `upstream_path` and `source_url`. The scan is described in [METHODOLOGY.md](METHODOLOGY.md).

Source licences:

| Collection | Maintainer's licence | Who owns the prompt text |
| --- | --- | --- |
| x1xhlol/system-prompts-and-models-of-ai-tools | GPL-3.0 at the pinned commit | The vendors |
| linexjlin/GPTs | None declared | The GPT authors |

A maintainer's licence covers their compilation, not text written by others. Do not add quotations or prompt bodies.

Code (`scoring/`, `tests/`) is Apache-2.0 (`LICENSE`). Data (`data/`, `figures/`, `docs/RESULTS.md`) is CC BY 4.0 (`LICENSE-DATA`). `NOTICE` at the repo root records that split. `scoring/rules.py` is derived from the author's earlier prompt-scoring tool (0.6.14) and is relicensed here under Apache-2.0.

The upstream cache stays on the `safeguards-cache` volume. Do not copy it into the checkout. Do not commit `.cache/` or `.reference-scores.json`.
