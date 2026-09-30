# ---------------------------------------------------------------------------
# Production image for the NestJS API. Multi-stage: dependencies and the
# TypeScript build happen in throwaway stages, so the runtime image carries
# production dependencies and compiled JavaScript only.
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS deps
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci


# ---------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev


# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Patch the OS layer to what Debian has published, as the Django image does
# (D21 in docs/roadmap.md): the base image lags its own security suite.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# The image's own unprivileged user.
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/api/health/').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "dist/main.js"]
