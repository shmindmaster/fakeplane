# data

The root `AGENTS.md` applies.

`prompts.csv`, `controls.csv`, and `summary.json` are generated. Do not edit
them by hand and do not put prompt text here. Regenerate with
`docker compose run --build --rm score` and commit only when that command
reports a match, or when you intentionally bumped the version and reviewed
the diff.
