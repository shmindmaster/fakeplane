# syntax=docker/dockerfile:1

FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

ENV UV_LINK_MODE=copy \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPYCACHEPREFIX=/tmp/pyc

WORKDIR /app

COPY python/pyproject.toml python/uv.lock python/README.md python/LICENSE python/NOTICE ./
COPY python/src ./src

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen

COPY python/tests ./tests

CMD ["uv", "run", "pytest", "-q"]
