# python

The root `AGENTS.md` applies.

Async port of the same state machine and state format, so a Node worker and
a Python worker can share one store. Dependencies live in the image via
`uv sync --frozen`. Run `docker compose run --build --rm python`. Do not
create `.venv` here.
