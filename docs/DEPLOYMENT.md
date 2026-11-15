# Deployment

A library, a CLI, and a GitHub Action. Not a hosted service.

- The public npm package is [`fakeplane`](https://www.npmjs.com/package/fakeplane). Run it with `npx -y fakeplane`.
- A new version is published through `.github/workflows/release.yml` when a new
  `v*` tag matches the package version. npm versions are immutable. A documentation
  change on `main` does not require a tag or package release.
- `action.yml` is the action. It uses the checked-out package and Node on
  the runner.
- CI builds `infra/docker/Dockerfile` and runs the suite. There is no
  registry image and no production environment.

Rollback of `main` is `git revert`.
