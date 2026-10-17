FROM node:26-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN APP_MODE=local npm run typecheck && APP_MODE=local npm run build
RUN npm prune --omit=dev

FROM node:26-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production APP_MODE=production APP_HOST=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends restic ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --from=build --chown=node:node /app/next.config.ts /app/tsconfig.json ./
COPY --chown=node:node deploy/entrypoint.sh ./entrypoint.sh
RUN mkdir -p /app/data /app/backups && chown node:node /app/data /app/backups && chmod 700 /app/data /app/backups
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node","scripts/healthcheck.mjs"]
ENTRYPOINT ["sh","/app/entrypoint.sh"]
CMD ["node","scripts/dev.mjs","--production"]
