# Frontend Dockerfile
FROM oven/bun:1 AS builder

WORKDIR /app

# 复制 workspace 配置
COPY package.json bun.lock* tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY packages/ghostty-terminal/package.json packages/ghostty-terminal/
COPY packages/ws-client/package.json packages/ws-client/
COPY packages/api-client/package.json packages/api-client/
COPY packages/notifications/package.json packages/notifications/
COPY apps/fe/package.json apps/fe/

# 安装依赖
RUN bun install

# 复制源代码
COPY packages/shared/ packages/shared/
COPY packages/ui/ packages/ui/
COPY packages/ghostty-terminal/ packages/ghostty-terminal/
COPY packages/ws-client/ packages/ws-client/
COPY packages/api-client/ packages/api-client/
COPY packages/notifications/ packages/notifications/
COPY apps/fe/ apps/fe/

# 构建
WORKDIR /app/apps/fe
RUN bun run build

# 生产镜像 - nginx
FROM nginx:alpine

# 复制构建产物
COPY --from=builder /app/apps/fe/dist /usr/share/nginx/html

# 复制 nginx 配置
COPY apps/fe/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
