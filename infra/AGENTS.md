# infra

The root `AGENTS.md` applies.

`docker/Dockerfile` is the only image: Node 22 and `npm ci`. `test` runs
`npm test`, which builds with `tsc` and then runs Vitest. The `dist/` output
stays in the container. Do not add a host toolchain.
