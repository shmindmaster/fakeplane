# tests

The root `AGENTS.md` applies.

```text
docker compose run --build --rm test
```

`test_dataset.py` is offline and uses the standard library plus `scoring/`.
Do not add a network call to this suite. The fetch check is `score`.
