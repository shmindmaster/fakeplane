# Deployment

A library and CLI. Not a hosted app.

npm package `subtext-scan`. `publishConfig.access` is public and provenance
is on. The release workflow is `.github/workflows/release.yml`. The package
files are `bin/`, `src/`, `README.md`, `LICENSE`, and `NOTICE`.

Install the published package with `npm install subtext-scan`. Publish a new version for runtime changes. Documentation-only updates can ship with the next package release.

CI builds `infra/docker/Dockerfile` and runs the suite. There is no image
registry and no production environment. Rollback of `main` is `git revert`.
