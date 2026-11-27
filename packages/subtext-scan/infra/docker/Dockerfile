# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim

ENV npm_config_update_notifier=false \
    npm_config_fund=false

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin
COPY tests ./tests
COPY fixtures ./fixtures
COPY scripts ./scripts
COPY README.md LICENSE NOTICE ./

CMD ["npm", "test"]
