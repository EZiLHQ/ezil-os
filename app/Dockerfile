# syntax=docker/dockerfile:1
# Repository-root context; deploy.sh supplies app/.dockerignore as the
# Dockerfile-specific ignore file. Build with --platform linux/amd64.
FROM oven/bun:1.3.14 AS bun
FROM node:22-bookworm-slim AS dependencies
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /workspace/app
COPY app/package.json app/bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS build
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
ARG GIT_SHA
ENV NEXT_TELEMETRY_DISABLED=1
COPY app/src ./src
COPY app/public ./public
COPY app/next.config.ts app/tsconfig.json app/postcss.config.mjs ./
# boot-payload.ts imports contract.ts, which imports surfaces.ts (and back).
COPY native/src/contract.ts native/src/surfaces.ts /workspace/native/src/
# Eager server env validation needs a DB URL during build. This inert local
# placeholder is scoped to RUN; no runtime credential is baked into the image.
RUN test -n "$NEXT_PUBLIC_SUPABASE_URL" && test -n "$NEXT_PUBLIC_SUPABASE_ANON_KEY" \
    && test -n "$NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY" && test -n "$GIT_SHA" \
    && SUPABASE_DATABASE_URL=postgresql://build:build@127.0.0.1:1/build bun run build

FROM node:22-bookworm-slim AS runtime
ARG GIT_SHA
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 EZIL_GIT_SHA=$GIT_SHA
LABEL org.opencontainers.image.revision=$GIT_SHA
WORKDIR /workspace/app
# Retain TypeScript for Next's next.config.ts loader; no standalone config change.
COPY --from=build --chown=node:node /workspace/app/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/app/.next ./.next
COPY --from=build --chown=node:node /workspace/app/public ./public
COPY --from=build --chown=node:node /workspace/app/package.json /workspace/app/next.config.ts ./
USER node
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
