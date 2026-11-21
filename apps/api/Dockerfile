# Сборка из корня репозитория: docker build -f apps/api/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN pnpm --filter @kovsh/contracts build && pnpm --filter @kovsh/api build \
  && pnpm --filter @kovsh/api deploy --prod --legacy /out

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
