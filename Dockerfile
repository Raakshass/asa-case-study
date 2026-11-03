# Production image for the Invoice AP Agent (Railway, or any Docker host). See README.md, "Deploy on Railway".
#
#   docker build -t invoice-ap .
#   docker run --rm -p 3000:3000 -v invoice-ap-storage:/app/storage -e OPENROUTER_API_KEY \
#     -e EXTRACT_MODEL=google/gemini-3.8-flash -e FALLBACK_MODEL=anthropic/claude-haiku-5.5 \
#     -e DEMO_RESET_ENABLED=true -e DEMO_RESET_TOKEN=<16+ random characters> invoice-ap
#   (-e OPENROUTER_API_KEY without a value passes the key from your shell, so it never appears in the command.)
#
# Layout decisions (each was replayed by hand outside Docker, see README.md):
# - Node 22 LTS on Debian slim (glibc). better-sqlite3 12.11.1 publishes prebuilt binaries for Node 22 (ABI 127) on
#   linux x64 and arm64, so no compiler is needed; the compiler is installed only if that download fails.
# - `next start` runs from /app (the project root): the app reads data/seed and data/samples from <cwd>/data and starts
#   its PDF text worker from <cwd>/src/lib/pdf-text-worker.mjs. Without that file uploads are parsed on the main thread
#   (a safety regression), so it is copied explicitly below.
# - Writable state (app.db, uploads/) lives in DATA_DIR=/app/storage, the volume mount point. Never mount a volume
#   at /app/data: it would hide data/seed and data/samples.
# - The config is next.config.mjs on purpose: `next start` compiles a next.config.ts at boot and then needs the
#   `typescript` package (without it Next 15 tries to `npm install typescript` at every start and exits when it
#   cannot), so the runtime image would have to carry typescript. A plain .mjs needs nothing.
# - The process runs as the unprivileged `node` user and cannot change the app files. Railway mounts volumes as root,
#   so on Railway set the service variable RAILWAY_RUN_UID=0 (Railway's documented fix for non-root images).

# ---- deps: all dependencies (dev included), with better-sqlite3's native binary --------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund \
 || (echo "npm ci failed; installing python3, make and g++ to build better-sqlite3 from source, then retrying" \
     && apt-get update \
     && apt-get install -y --no-install-recommends python3 make g++ \
     && rm -rf /var/lib/apt/lists/* \
     && npm ci --no-audit --no-fund)

# ---- build: next build (no secrets needed; .env* files are kept out by .dockerignore) ---------------------------
FROM deps AS build
COPY . .
RUN npm run build && rm -rf .next/cache

# ---- prod-deps: production dependencies only, reusing the native binary built or downloaded above ---------------
FROM deps AS prod-deps
RUN npm prune --omit=dev --no-audit --no-fund

# ---- runtime: exactly what `next start` needs -------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PORT=3000 \
    DATA_DIR=/app/storage
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/package-lock.json /app/next.config.* ./
COPY --from=build /app/.next ./.next
COPY --from=build /app/data/seed ./data/seed
COPY --from=build /app/data/samples ./data/samples
COPY --from=build /app/src/lib/pdf-text-worker.mjs ./src/lib/pdf-text-worker.mjs
RUN mkdir -p /app/storage && chown node:node /app/storage
USER node
EXPOSE 3000
# `next start` listens on $PORT on all interfaces; the server must start in /app (see above).
CMD ["npm", "run", "start"]
