# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim

ENV npm_config_update_notifier=false \
    npm_config_fund=false

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY tsconfig.json vitest.config.ts tsup.config.ts ./
COPY src ./src
COPY test ./test
COPY examples ./examples

CMD ["npm", "test"]
