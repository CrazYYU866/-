# Сборка из корня репозитория: docker build -f apps/api/Dockerfile -t kovsh-api .
# Базовый образ можно заменить (например, на зеркало реестра): --build-arg NODE_IMAGE=cr.yandex/.../node:22-alpine
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
# Ставятся зависимости только сервера и общих контрактов (мобильные приложения и админка в образ не входят).
RUN pnpm install --frozen-lockfile --filter @kovsh/api...
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN pnpm --filter @kovsh/contracts build && pnpm --filter @kovsh/api build \
  && pnpm --filter @kovsh/api deploy --prod --legacy /out \
  && cp -r apps/api/migrations /out/migrations

FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/api/v1/health || exit 1
# Миграции — отдельной командой перед запуском новой версии: node dist/database/migrate.cli.js
CMD ["node", "dist/main.js"]
