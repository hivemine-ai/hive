# syntax=docker/dockerfile:1.7
# Hive v0.1 OSS — multi-stage image (server + hivectl in a single artifact).
# Base: node:20-bookworm-slim per Deployment tech spec.

# ───────────────────────────────────────────────────────────────────────────
# Stage 1 — builder. Compiles TypeScript for shared/server/cli packages and
# prunes dev dependencies. The resulting /app tree is copied into the runtime
# stage; no compiler or dev deps survive into the final image.
# ───────────────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

# Activate the exact pnpm version pinned in the root package.json
# (`packageManager` field — currently pnpm@10.13.1). Corepack is bundled with
# Node 20; no `npm install -g` needed.
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate

WORKDIR /app

# Copy lockfile and manifests first to maximize layer cache hits — only
# busted when dependencies change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/client/package.json packages/client/

# Install all dependencies (including dev, needed for tsc build below).
# better-sqlite3 native binding is allowed via the root pnpm.onlyBuiltDependencies
# allowlist. Frozen lockfile fails fast on drift.
RUN pnpm install --frozen-lockfile

# Now copy the rest of the source. Anything excluded by .dockerignore stays
# out (raw/, repositories/, _templates/, .env*, dist/, etc.).
COPY tsconfig.json ./
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/cli packages/cli
COPY packages/client packages/client

# Build the three packages we ship into runtime. Project references handle
# the dependency order (shared → server → cli).
RUN pnpm -r --filter @hive/shared --filter @hive/server --filter @hive/cli build

# Strip dev dependencies. Production-only deps remain under node_modules.
RUN pnpm prune --prod

# ───────────────────────────────────────────────────────────────────────────
# Stage 2 — runtime. Minimal image carrying compiled JS + production
# node_modules + non-root user + writable directories for keys and SQLite.
# ───────────────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

# OCI image metadata. Useful even pre-publication: `docker inspect` surfaces
# this for any operator who pulls the image, and internal scanners pick it up.
# When public distribution opens (follow-up PRY), these labels are already in
# place — no extra work needed at release time.
LABEL org.opencontainers.image.title="Hive" \
      org.opencontainers.image.description="Open-source MCP server for collaborative AI agents" \
      org.opencontainers.image.source="https://github.com/hivemine-ai/hive" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.authors="Hivemine <hivemine-ai@users.noreply.github.com>"

# `node` user (UID/GID 1000) is created by the official base image. We just
# pre-create the directories the server writes to so the volumes mount with
# correct ownership.
RUN mkdir -p /var/lib/hive/keys /var/lib/hive/db /app \
    && chown -R node:node /var/lib/hive /app \
    && chmod 0700 /var/lib/hive/keys

WORKDIR /app

# Single recursive copy from the builder. After `pnpm prune --prod` the tree
# under /app already contains only what runtime needs (production deps under
# packages/*/node_modules + the root hoist; compiled JS under packages/*/dist;
# package.json files for module resolution). Per-package COPYs would fail
# for packages without runtime deps (eg. @hive/shared has no prod deps so
# its node_modules is absent after prune).
COPY --from=builder --chown=node:node /app /app

# `hivectl` wrapper — operators invoke `docker compose exec hive-server hivectl ...`
# or override the entrypoint via `docker compose run --rm --entrypoint hivectl`.
RUN printf '#!/bin/sh\nexec node /app/packages/cli/dist/main.js "$@"\n' > /usr/local/bin/hivectl \
    && chmod +x /usr/local/bin/hivectl

USER node

# 8443 is the default HIVE_MCP_HTTP_PORT; informational only — the operator
# can rebind via env. Compose maps to host via HIVE_PUBLIC_PORT.
EXPOSE 8443

# Default DB and keys paths point to the volumes mounted at the same paths.
# Operator can override any of these via env in `.env`.
ENV HIVE_AUTH_KEYS_DIR=/var/lib/hive/keys \
    HIVE_DB_DIALECT=sqlite \
    HIVE_DB_URL=sqlite:/var/lib/hive/db/hive.sqlite \
    HIVE_MCP_HTTP_HOST=0.0.0.0 \
    HIVE_MCP_HTTP_PORT=8443 \
    NODE_ENV=production \
    TZ=UTC

# Server is the default ENTRYPOINT. Override (`--entrypoint hivectl`) to run
# the CLI without starting the server.
ENTRYPOINT ["node", "/app/packages/server/dist/main.js"]
