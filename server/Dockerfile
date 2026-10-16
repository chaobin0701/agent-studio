FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY packages/output-contract ./packages/output-contract
COPY server/package*.json ./server/
WORKDIR /app/server
RUN npm ci --install-links=true
COPY server/tsconfig.json ./
COPY server/src ./src
COPY server/config ./config
COPY server/scripts ./scripts
COPY server/migrations ./migrations
RUN npm run build && npm prune --omit=dev
FROM node:24-bookworm-slim
WORKDIR /app/server
ENV NODE_ENV=production
RUN mkdir -p /data/uploads && chown -R node:node /app /data/uploads
COPY --from=build --chown=node:node /app/server/package*.json ./
COPY --from=build --chown=node:node /app/server/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/dist ./dist
COPY --from=build --chown=node:node /app/server/config ./config
COPY --from=build --chown=node:node /app/server/migrations ./migrations
USER node
CMD ["node", "dist/main.js"]
