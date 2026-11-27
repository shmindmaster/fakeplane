# infra

The root `AGENTS.md` applies.

`docker/Dockerfile` is the only image: Python 3.12 and git, user id 10001.
`test` and `score` in the root `compose.yaml` both use it. The score cache is
the named volume `safeguards-cache`. Do not bind-mount the checkout's
`.cache`, and do not add a second image or orchestrator.
