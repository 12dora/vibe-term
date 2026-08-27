# Gateway Dockerfile
# 入口是 apps/gateway（API + /ws + /healthz），不构建前端。
# 生产契约由 loadEnv() 校验：TMEX_MASTER_KEY / GATEWAY_PORT / TMEX_BIND_HOST /
# DATABASE_URL / TMEX_FE_DIST_DIR / TMEX_MIGRATIONS_DIR。

FROM oven/bun:1 AS builder

WORKDIR /app

# bun.lock workspaces 覆盖 apps/* 与 packages/*，缺任一 package.json 会导致
# `bun install --frozen-lockfile` 失败。先拷全部 workspace 清单再装依赖。
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

# 编译 gateway 需要的源码（含 ghostty-terminal wasm 资源与 shared）
COPY packages/shared/ packages/shared/
COPY packages/ghostty-terminal/ packages/ghostty-terminal/
COPY apps/gateway/ apps/gateway/

WORKDIR /app/apps/gateway
# bun build 会把源码里的静态 `process.env.NODE_ENV` 内联成构建期取值；
# 不设的话 healthz 的 env 字段会永远是 development。
ENV NODE_ENV=production
RUN bun run build

FROM oven/bun:1-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends tmux openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# oven/bun 镜像已有 uid 1000 的 bun 用户，不可再 useradd -u 1000。
RUN mkdir -p /data /app/fe-dist /app/assets \
  && chown -R bun:bun /app /data

COPY --from=builder --chown=bun:bun /app/apps/gateway/dist ./dist
COPY --from=builder --chown=bun:bun /app/apps/gateway/drizzle ./drizzle
COPY --from=builder --chown=bun:bun /app/packages/ghostty-terminal/src/assets/ghostty-vt.wasm ./assets/ghostty-vt.wasm

USER bun

ENV NODE_ENV=production
ENV DATABASE_URL=/data/tmex.db
ENV GATEWAY_PORT=8080
ENV TMEX_BIND_HOST=0.0.0.0
ENV TMEX_MIGRATIONS_DIR=/app/drizzle
ENV TMEX_FE_DIST_DIR=/app/fe-dist
ENV TMEX_GHOSTTY_WASM_PATH=/app/assets/ghostty-vt.wasm

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8080/healthz').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["bun", "dist/index.js"]
