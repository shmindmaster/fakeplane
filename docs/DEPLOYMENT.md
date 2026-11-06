# Deployment

A library, a CLI, and a GitHub Action. Not a hosted service.

- npm package `fakeplane`. Not published yet. The README installs it with
  `npx -y github:shmindmaster/fakeplane` until the first npm release.
- The release workflow is `.github/workflows/release.yml`.
- `action.yml` is the action. It uses the checked-out package and Node on
  the runner.
- CI builds `infra/docker/Dockerfile` and runs the suite. There is no
  registry image and no production environment.

Rollback of `main` is `git revert`.
