# Deployment

There is no application server, staging stack, or production container to promote. The dataset is the release.

- GitHub: `shmindmaster/safeguards`. The previous name `agent-prompt-safeguards-2026` redirects.
- Hugging Face Datasets: `shmindmaster/agent-prompt-safeguards-2026`. The card is `hf/README.md`.
- Version: `1.0.0` in `data/summary.json` and `CITATION.cff`.

CI (`.github/workflows/ci.yml`) builds `infra/docker/Dockerfile` and runs `test`, then `score`. Both use that image. A green `score` job means the committed tables match a fresh run.

Publish a new dataset version by merging to `main` after `score` passes. Update the Hugging Face card in the same change when the public description changes. Do not create a hosting app for this repository.

Rollback is `git revert` on `main`. There is no deployed image digest.
