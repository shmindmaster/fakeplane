# infra

The root `AGENTS.md` applies.

`docker/node.Dockerfile` is the Node 22 image. `docker/python.Dockerfile` is
the Python 3.12 image, using uv. Compose at the repo root starts Postgres 16
and Redis 7 for the suites. Dev and CI use these images. Do not add a second
compose project or a host install path.
