# infra

The root `AGENTS.md` applies.

`docker/Dockerfile` is the only image: Node 22, `npm ci` from the lockfile.
Dev and CI use it. There is no second runtime and no production service.
