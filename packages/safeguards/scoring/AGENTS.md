# scoring

The root `AGENTS.md` applies.

`rules.py` is the ruleset. Changing a pattern or a group changes scores and
needs a version bump. `score.py` writes `data/`, `docs/RESULTS.md`, and
`figures/controls-by-source.svg`. It must refuse to write when the leak scan
fails.

Run `docker compose run --build --rm score` after a generator change. The
upstream cache stays on `safeguards-cache`.
