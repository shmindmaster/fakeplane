# Data

Following the structure of *Datasheets for Datasets* (Gebru et al., 2021).

## Motivation

**Why was it created?** To measure which safeguards the people who build AI agents write into the agent's own instructions, and which they leave out. Builders often rely on the system prompt as the place where an agent's rules live. This dataset shows, prompt by prompt, what those prompts actually say.

**Who created it?** Sarosh Hussain, as an independent study. No sponsor or funding.

**What question does it answer?** Whether system prompts behind production agent products write down more of 23 common safeguards than general-purpose GPT Store prompts, and which safeguards appear in none of them.

## Composition

**What does each record represent?** One publicly collected AI system prompt. The record holds identifiers and scores, not the prompt text.

**How many records?** 356: 83 from a collection of system prompts behind production agent products (coding agents, AI IDEs and assistants), and 273 from a collection of GPT Store custom-GPT prompts.

**What is in each record?** (`data/prompts.csv`)

| Field | Meaning |
| --- | --- |
| `prompt_id` | First 16 hex characters of SHA-256 of the upstream path. Stable, and identical to the `file_id` used by the original prompt-scoring tool |
| `source_category` | `production` or `gpt_store` |
| `source_collection` | Upstream GitHub repository |
| `upstream_commit`, `upstream_commit_date` | The pinned commit and its date |
| `upstream_path`, `source_url` | Where the prompt lives upstream, and a link to it at the pinned commit |
| `collection_date` | Date the commits were pinned and fetched (2026-07-28) |
| `git_blob_sha1`, `content_sha256` | Hashes of the prompt file as committed upstream |
| `text_bytes`, `word_count` | Size of the prompt text |
| `score` | Overall coverage, 0-100 |
| `controls_stated` | How many of the 23 safeguards the text states |
| `dim_*` | Coverage for each of the 8 groups, 0-100 |
| 23 safeguard columns | 1 if the text states that safeguard, else 0 |

`data/controls.csv` is one row per safeguard: group, label, rule ids, and counts and rates per source. `data/summary.json` holds the distributions, the statistical test, the zero-floor check, the never-stated list, and licence notes.

**Is it a sample?** No. It is every qualifying file in two collections at fixed commits. Those collections are themselves gathered by their maintainers from leaks, extraction and user submissions, and are of unknown completeness. Neither is a random sample of production agents or of GPTs.

**Is anything missing?** Prompt text, by design. Files with fewer than 20 words and README or LICENSE files were excluded. JSON tool definitions in the production collection were not scored.

**Is there sensitive or personal data?** No personal data is stored. Upstream paths name products, vendors and GPT titles.

## Collection

**How was it collected?** Both collections were fetched with `git fetch --depth 1` at one pinned commit each, on 2026-07-28. `scoring/score.py` repeats this exactly.

**Who was involved?** The author only. No crowdworkers, no annotation.

**Over what time frame?** The production commit is dated 2026-07-12. The GPT Store commit is dated 2024-09-27; the prompts in it are older than that date.

**Ethical review?** None was sought. The study scores publicly available text and does not redistribute it.

## Preprocessing

UTF-8 decoding with replacement of invalid bytes, and line endings normalised to `\n`. Scoring is lower-cased regular-expression matching. Nothing else is done to the text. See [METHODOLOGY.md](METHODOLOGY.md).

## Uses

**Good uses**

- Seeing which safeguards are commonly written into agent prompts and which are rare, as a checklist for reviewing your own.
- Comparing written safeguards across the two kinds of prompt.
- Re-scoring with a different ruleset: fetch the pinned sources with `scoring/score.py`, edit `scoring/rules.py`, and compare.

**Uses to avoid**

- Rating or ranking a product's safety. A score reflects what one prompt file says, not the product's code, its other prompts, or its runtime behaviour.
- Treating a high score as evidence that a control works. Asking a model to keep an audit log does not produce one.
- Generalising to all agents. The collections are skewed toward coding assistants, which makes retrieval and compliance safeguards rare by construction.

## Limits

- **Written text only.** Coverage records whether a sentence is present, not whether it is well written or obeyed.
- **Regex matching.** Rules match wording, so a safeguard phrased in unusual words is missed, and a sentence that matches a rule is counted even if its context weakens it. Rules were tuned against this corpus to remove false positives; the looser diagnostic probes bound the misses for the five safeguards no prompt states.
- **Unknown provenance.** Upstream maintainers' claims about where a prompt came from, and whether it is current, could not be verified. Products change their prompts often.
- **Category by collection.** `production` means "taken from the production-agent collection", not "verified to be in production".
- **One ruleset.** Scores from different rulesets are not comparable.
- **An earlier version was withdrawn.** A 1,368-prompt version of this study, published with the author's earlier, now-archived prompt-scoring tool, was withdrawn after hand-transcribed numbers turned out wrong. Every number in this dataset is generated by the script, and CI fails if the committed files drift from a fresh run.

## Licensing of the sources

| Collection | Licence declared by its maintainer | Who owns the prompt text |
| --- | --- | --- |
| x1xhlol/system-prompts-and-models-of-ai-tools | GPL-3.0 (`LICENSE.md` at the pinned commit) | The vendors the prompts were taken from |
| linexjlin/GPTs | None declared | The individual GPT authors |

A maintainer's licence covers their compilation, not text written by others. Because neither licence clearly allows redistributing the prompts, this dataset publishes only identifiers, links, hashes and derived scores, and no quotations. The original report described these collections as CC0 and MIT respectively; that was wrong and is corrected here.

## Distribution and maintenance

- **Where:** GitHub (`shmindmaster/safeguards`, renamed from `agent-prompt-safeguards-2026`) and Hugging Face Datasets (`shmindmaster/agent-prompt-safeguards-2026`).
- **Licence:** data CC BY 4.0; code Apache-2.0.
- **Versioning:** semantic versions in `data/summary.json`. A ruleset change or a new source is a new minor or major version, never a silent edit.
- **Contact:** issues on the GitHub repository.

`docs/RESULTS.md` and `figures/controls-by-source.svg` are generated by `scoring/score.py`. Do not edit them by hand.
