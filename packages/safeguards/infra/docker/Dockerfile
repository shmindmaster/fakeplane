# syntax=docker/dockerfile:1

FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPYCACHEPREFIX=/tmp/pyc

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin app \
    && mkdir -p /tmp/pyc \
    && chown app:app /tmp/pyc

WORKDIR /app

COPY scoring ./scoring
COPY tests ./tests
COPY data ./data
COPY docs ./docs
COPY figures ./figures

RUN mkdir -p /app/.cache \
    && chown -R app:app /app

USER app

CMD ["python", "tests/test_dataset.py"]
