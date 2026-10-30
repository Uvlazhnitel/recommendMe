# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Native build fallback; none of these tools are copied to the runtime stage.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build \
    && node --input-type=module -e "import fs from 'node:fs'; import ts from 'typescript'; fs.writeFileSync('next.config.mjs', ts.transpileModule(fs.readFileSync('next.config.ts','utf8'), {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText)" \
    && npm prune --omit=dev --offline --no-audit --no-fund \
    && rm -rf .next/cache

FROM node:24-bookworm-slim AS runtime
ARG APP_GIT_SHA=unknown
ENV APP_GIT_SHA=$APP_GIT_SHA
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 DATABASE_PATH=/app/data/movies.sqlite
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json /app/next.config.mjs ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/src/lib ./src/lib/
COPY --from=build --chown=node:node /app/scripts/container-db.mjs /app/scripts/db-init.ts /app/scripts/localize-ru.ts ./scripts/
RUN mkdir -p data backups .next/cache && chown -R node:node data backups .next/cache
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
# Direct Node process: no npm wrapper intercepts termination signals. No init,
# migrations, imports, profile generation or external API calls on startup.
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
