# ---------------------------------------------------------------------------
# Production image for the Rangon web app (storefront + admin + POS).
# deps -> build -> minimal standalone runtime.
#
# No `# syntax=` directive on purpose: nothing here needs a Dockerfile frontend
# newer than the built-in one, and pulling an external frontend adds a network
# dependency (and a failure mode) to every build.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund


FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* values are baked into the client bundle at build time, so they
# are passed as build args — they are public by definition, never secrets.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_CURRENCY=BDT
ARG NEXT_PUBLIC_CURRENCY_SYMBOL=৳
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_CURRENCY=$NEXT_PUBLIC_CURRENCY \
    NEXT_PUBLIC_CURRENCY_SYMBOL=$NEXT_PUBLIC_CURRENCY_SYMBOL
RUN npm run build


FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

# The standalone server runs under plain `node`; npm is never invoked here.
# npm vendors its own dependency tree (tar, sigstore, ip-address, ...) into the
# base image, and those advisories fail the Trivy gate while being unreachable
# from anything this app declares -- no package.json pin can fix them. Dropping
# npm from the runtime removes them along with the tooling itself. The guard
# turns a silently-wrong path into a build failure rather than a quiet no-op.
#
# `apk upgrade` patches the OS layer to whatever Alpine has published at build
# time. It is here because the base image lags its own security branch:
# node:22-alpine shipped openssl 3.5.7-r0 while Alpine 3.24 already carried the
# 3.5.8-r0 fix for CVE-2026-14456, and the scan gate is not something a
# package.json can answer. This is safe to run unconditionally *because* the
# gate sets `ignore-unfixed: true` -- it only ever fails on a CVE whose fix is
# already published, which is exactly the set `apk upgrade` installs. Without
# it, every image scan stays red until upstream rebuilds the base image.
RUN apk upgrade --no-cache \
    && apk add --no-cache curl \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && ! command -v npm > /dev/null \
    && addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
