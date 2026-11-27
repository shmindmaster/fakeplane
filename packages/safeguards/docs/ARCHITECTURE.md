# Architecture

A dataset plus one standard-library scorer. There is no web, mobile, or API service.

```text
pinned upstream commits
  -> git fetch into the cache volume
  -> read each prompt from its git blob
  -> 23 safeguards in scoring/rules.py
  -> data/prompts.csv, data/controls.csv, data/summary.json
  -> docs/RESULTS.md and figures/controls-by-source.svg
```

| Path | Owns |
| --- | --- |
| `scoring/rules.py` | Ruleset `prompt-safeguards@0.6.0`. Grouping is the scoring denominator |
| `scoring/score.py` | Fetch, score, statistics, leak scan, and the generated files |
| `tests/test_dataset.py` | Offline consistency checks. No network |
| `data/` | Committed scores and summary. No prompt text |
| `figures/` | The committed chart |
| `docs/RESULTS.md` | Generated results page |
| `hf/README.md` | Hugging Face dataset card |
| `infra/docker/Dockerfile` | The only image. Python 3.12 plus git |

The cache of upstream checkouts is the Docker volume `safeguards-cache`, mounted at `/app/.cache`. It is not a directory in the checkout.

`score.py --check` fails when a generated file differs from a fresh run, and it writes nothing on a self-check failure.
