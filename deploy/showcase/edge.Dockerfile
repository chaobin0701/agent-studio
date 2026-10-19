FROM node:24-bookworm-slim AS admin
RUN npm install --global pnpm@11.16.0
WORKDIR /app
COPY packages ./packages
COPY admin-vben ./admin-vben
WORKDIR /app/admin-vben
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24-bookworm-slim AS chat
WORKDIR /app
COPY packages ./packages
COPY chat ./chat
WORKDIR /app/chat
RUN npm ci --install-links=true && npm run build

FROM caddy:2-alpine
COPY --from=admin /app/admin-vben/apps/web-ele/dist /srv/admin
COPY --from=chat /app/chat/dist /srv/chat
COPY deploy/showcase/Caddyfile /etc/caddy/Caddyfile
