# Testing

Two checks, both in the image.

```text
docker compose run --build --rm test
docker compose run --build --rm score
```

`tests/test_dataset.py` is offline. It checks row counts (356, of which 83 production and 273 GPT Store), that each overall score is the mean of its dimension scores, and that the committed tables agree with `scoring/rules.py`. Run this on every change.

`scoring/score.py --check` is the reproduction. It needs network and git, refetches the pinned commits, and returns non-zero if a generated file drifted. CI runs both jobs on every push to `main` and every pull request.

A self-check failure writes nothing. Fix the generator or the committed data before committing. Do not weaken a test to match a drift.
