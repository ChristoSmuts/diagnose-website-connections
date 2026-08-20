# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage
# ---------------------------------------------------------------------------
# Node 24 LTS: the probe engine leans on the current OpenSSL and undici for TLS
# introspection and HTTP behaviour, and 24 is the supported LTS line.
FROM node:24-alpine AS build

# better-sqlite3 ships prebuilt binaries for this platform, but keep the
# toolchain available so an unusual architecture can still compile it.
RUN apk add --no-cache python3 make g++

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Manifests first, so a dependency install is cached independently of source
# changes — by far the slowest step to repeat.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/diagnostics/package.json ./packages/diagnostics/
COPY packages/persistence/package.json ./packages/persistence/
COPY packages/tokens/package.json ./packages/tokens/
COPY packages/ui/package.json ./packages/ui/

RUN pnpm install --frozen-lockfile

COPY . .
# NODE_ENV=production drops the 850 KB sourcemap, which would otherwise be copied
# into the runtime image and served publicly on metered bandwidth.
RUN NODE_ENV=production pnpm run build

# Drop dev dependencies from the tree we are about to copy forward.
#
# CI=true is load-bearing rather than decoration. `prune` deletes and relinks the
# whole modules directory, and pnpm refuses to do that unprompted when there is
# no TTY to confirm on — which a Docker build never has. Without it the build
# fails at this exact line with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY.
RUN CI=true pnpm prune --prod

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runtime

# Tini reaps zombies and forwards signals, so `docker stop` is immediate rather
# than waiting out the timeout.
RUN apk add --no-cache tini

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages ./packages

# The database lives on a volume; the app must be able to create it on first run.
RUN mkdir -p /app/data && chown -R node:node /app/data

# Never root. This process makes outbound connections to attacker-supplied URLs,
# so it gets the least privilege that still works.
USER node

ENV DATABASE_PATH=/app/data/dwc.db
ENV PORT=8787
ENV HOST=0.0.0.0

EXPOSE 8787

# Node 24 strips TypeScript natively, so the server runs straight from source
# with no build artefact to keep in sync.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/api/src/index.ts"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
