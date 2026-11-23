# Веб-часть стенда: админка и веб-версия приложения заказчика (страница заявки по SMS-ссылке) за Caddy с HTTPS.
ARG NODE_IMAGE=node:22-alpine
ARG CADDY_IMAGE=caddy:2-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @kovsh/admin... --filter @kovsh/client...
RUN pnpm --filter @kovsh/contracts build \
  && pnpm --filter @kovsh/admin build \
  && cd apps/client && EXPO_OFFLINE=1 CI=1 npx expo export --platform web --output-dir dist

FROM ${CADDY_IMAGE}
COPY infra/stand/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/admin/dist /srv/admin
COPY --from=build /repo/apps/client/dist /srv/app
