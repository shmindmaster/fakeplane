# Operations

## Reproduce

```text
docker compose run --build --rm score
```

Success prints `all generated files match a fresh run`. A stale path is printed and the command exits 1. A self-check failure exits 2 and writes nothing.

If an upstream collection is deleted or its history is rewritten, the fetch fails. Report that. Do not swap in a different commit without a version bump.

## Cache

`safeguards-cache` holds the two shallow upstream checkouts. Removing it only forces the next `score` to fetch again:

```text
docker volume rm safeguards_safeguards-cache
```

Do not prune volumes that belong to other compose projects. The checkout's `.cache/` is gitignored leftover. Delete it if it reappears. The container does not mount it.

## Generated files

`scoring/score.py` writes `data/prompts.csv`, `data/controls.csv`, `data/summary.json`, `docs/RESULTS.md`, and `figures/controls-by-source.svg`. The chart footer still names `agent-prompt-safeguards-2026` because that string is part of the generated SVG. The old GitHub name redirects to `shmindmaster/safeguards`. Change the footer only in `score.py`, then regenerate.

## Image

The local tag is `safeguards:local`. Remove it with `docker image rm safeguards:local` when you want the disk back. Docker is started for the task and is not a login item.
