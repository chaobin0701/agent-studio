FROM node:24-bookworm-slim AS admin
RUN npm install --global pnpm@11.16.0
WORKDIR /app
COPY packages ./packages
COPY admin-vben ./admin-vben
WORKDIR /app/admin-vben
RUN pnpm install --frozen-lockfile && pnpm build
FROM caddy:2-alpine
COPY --from=admin /app/admin-vben/apps/web-ele/dist /srv/admin
COPY deploy/Caddyfile /etc/caddy/Caddyfile
