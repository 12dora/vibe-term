# Frontend Dockerfile
FROM oven/bun:1 AS builder

WORKDIR /app

# bun.lock workspaces 覆盖 apps/* 与 packages/*，缺任一 package.json 会导致
# `bun install --frozen-lockfile` 失败。packages/app/package.json 还被 vite
# 在构建期读取以注入 monorepo 版本号。
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY apps/fe/package.json apps/fe/
COPY apps/gateway/package.json apps/gateway/
COPY packages/api-client/package.json packages/api-client/
COPY packages/app/package.json packages/app/
COPY packages/ghostty-terminal/package.json packages/ghostty-terminal/
COPY packages/notifications/package.json packages/notifications/
COPY packages/panels/package.json packages/panels/
COPY packages/shared/package.json packages/shared/
COPY packages/stores/package.json packages/stores/
COPY packages/terminal-ui/package.json packages/terminal-ui/
COPY packages/theme/package.json packages/theme/
COPY packages/ui/package.json packages/ui/
COPY packages/ws-client/package.json packages/ws-client/

RUN bun install --frozen-lockfile

COPY packages/shared/ packages/shared/
COPY packages/ui/ packages/ui/
COPY packages/ghostty-terminal/ packages/ghostty-terminal/
COPY packages/ws-client/ packages/ws-client/
COPY packages/api-client/ packages/api-client/
COPY packages/notifications/ packages/notifications/
COPY packages/stores/ packages/stores/
COPY packages/theme/ packages/theme/
COPY packages/terminal-ui/ packages/terminal-ui/
COPY packages/panels/ packages/panels/
COPY packages/app/package.json packages/app/
COPY apps/fe/ apps/fe/

WORKDIR /app/apps/fe
RUN bun run build

FROM nginx:alpine

COPY --from=builder /app/apps/fe/dist /usr/share/nginx/html
COPY apps/fe/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
