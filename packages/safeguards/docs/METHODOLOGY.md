# Methodology

## Sources

Two public GitHub collections, each fetched at one pinned commit on 2026-07-28:

| Source category | Collection | Pinned commit | Files scored |
| --- | --- | --- | ---: |
| `production` | [x1xhlol/system-prompts-and-models-of-ai-tools](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools) | `2054f580b1203da061e8e3df3c6449de2ad7c322` | 83 |
| `gpt_store` | [linexjlin/GPTs](https://github.com/linexjlin/GPTs) | `3adfb7b38423b64a995057483c1f9007ed5f4da5` | 273 |

A prompt's category comes from the collection it was taken from. Nobody labelled prompts by hand.

**Inclusion.** Production: every `.txt` file in the collection. GPT Store: every `.md` file under `prompts/`. In both, files whose name contains `readme` or `license` are skipped, as are files with fewer than 20 words (stubs and index files). JSON tool schemas in the production collection are not instruction text and are not scored.

**Reading.** Each prompt is read from its committed git blob, decoded as UTF-8 (invalid bytes replaced), with line endings normalised to `\n`. `content_sha256` is the SHA-256 of the blob bytes as committed upstream; `git_blob_sha1` is git's own object id, which you can check against GitHub directly.

## Scoring

The 23 safeguards and their rules are in [`scoring/rules.py`](../scoring/rules.py) (ruleset `prompt-safeguards@0.6.0`).

1. Each safeguard has one or more case-insensitive regular expressions. Several rules can express the same safeguard; they count once.
2. The safeguards fall into 8 groups (injection, hallucination, citation, cost, human approval, safe stopping, audit, compliance) of 2 to 4 safeguards each.
3. A group's score is the share of its safeguards the text states, rounded half-up to an integer from 0 to 100.
4. A prompt's score is the mean of its 8 group scores, rounded down.

So a prompt that states every safeguard scores 100, and a prompt reaches 50 only if its 8 group scores average 50 or more. No prompt in the dataset reaches 50; the highest is 34.

The rules match wording, not meaning. They were tuned against this corpus in earlier releases of the author's now-archived prompt-scoring tool to remove false positives (for example "dependency injection" no longer counts as a prompt-injection defence), and that history is in the comments of `rules.py`.

## Statistics

All computed by `scoring/score.py`, with fixed seeds so the output is identical on every run:

- **Effect size:** Cliff's delta between production and GPT Store scores, via the Mann-Whitney U identity with midranks for ties.
- **Significance:** two-sided permutation test on the same statistic, 10,000 relabelings, seed 20260729, add-one corrected (so *p* is never exactly 0; 0.0001 is the floor at this many relabelings).
- **Interval:** percentile bootstrap on the same statistic, 10,000 resamples within groups, seed 20260730.
- **Zero-floor check:** 70.7% of GPT Store prompts and 24.1% of production prompts score 0. Ties at zero weaken a rank statistic rather than inflate it, so the test is repeated on non-zero scores only (seed 20260731). Both results are published.
- **Never-stated safeguards:** for each safeguard no prompt states, a deliberately looser set of patterns is run as a diagnostic. It never changes a score. If the loose probe found the safeguard often, the rules would be too narrow; it finds at most 2 of 356 for any of the five, so the absence is in the prompts, not the rules.

## The no-text guarantee

Before writing anything, `scoring/score.py` builds every output in memory and checks that no 40-character run of any prompt's text, in raw, whitespace-collapsed or JSON-escaped form, appears in any of them. If one does, the run fails and writes nothing. The only fields excluded from that scan are `upstream_path` and `source_url`, which are references to where a prompt lives. In the GPT Store collection a file's name is the GPT's title, and the prompt often repeats its own title, so the scan would otherwise flag the reference itself.

## Reproduction

```text
docker compose run --build --rm score
```

This fetches both collections at their pinned commits, re-scores all 356 prompts, and fails if any committed file (`data/*`, `docs/RESULTS.md`, `figures/controls-by-source.svg`) differs from the fresh output. CI runs it on every push. If an upstream collection is deleted or its history rewritten, the fetch fails: that is reported, not hidden.

## Changes from the original report

The study was first published with the author's earlier, now-archived prompt-scoring tool. Scores and statistics are unchanged; all 356 rows were compared against that tool's published per-prompt scores and match. The ruleset, identical in content, was renamed `prompt-safeguards@0.6.0`. This version adds the upstream path, source URL and content hashes to each row, adds the "scored 50+" count, and corrects the licence notes for the two sources.
