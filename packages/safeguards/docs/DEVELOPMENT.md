# Development

Git, Docker, and an editor are enough. Do not create a virtual environment or a `.cache` directory in the checkout.

```text
docker compose run --build --rm test
docker compose run --build --rm score
```

`test` runs `python tests/test_dataset.py`. It needs no network.

`score` runs `python scoring/score.py --check`. It fetches both pinned collections into the `safeguards-cache` volume and fails if `data/*`, `docs/RESULTS.md`, or `figures/controls-by-source.svg` differ from that run. An ordinary source edit is mounted into the container. Rebuild when the Dockerfile changes.

The image is Python 3.12 plus git. Scoring uses the standard library only. Bytecode goes to `/tmp/pyc`.

Do not hand-edit `docs/RESULTS.md`, `data/prompts.csv`, `data/controls.csv`, `data/summary.json`, or the chart. Change `scoring/rules.py` or `scoring/score.py`, then re-run `score`. A ruleset or source change is a version bump in `data/summary.json`, not a silent edit.
