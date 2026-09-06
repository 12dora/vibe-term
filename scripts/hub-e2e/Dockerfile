# vibeterm hub/node e2e 运行时。只从 ubuntu:24.04 构建；Caddy 另用 caddy:2。
# 多架构：TARGETARCH=amd64|arm64（远端 x86 服务器 / 本机 Apple Silicon 原生，不走 qemu）。
FROM ubuntu:24.04
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive \
    BUN_INSTALL=/usr/local \
    BUN_VERSION=1.3.14 \
    NODE_VERSION=22.18.0 \
    PATH=/usr/local/bin:$PATH

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        openssl \
        rsync \
        tmux \
        iptables \
        iproute2 \
        unzip \
        xz-utils \
        coreutils \
        procps \
    && rm -rf /var/lib/apt/lists/*

# Node 22 官方 tarball（不走 nodesource / Docker Hub 上的 node 镜像）
RUN NODE_ARCH="$([ "${TARGETARCH}" = "arm64" ] && echo arm64 || echo x64)" \
    && curl -fsSL --retry 5 --retry-delay 5 "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 \
    && node --version \
    && npm --version

# 钉死 Bun 1.3.14（fetch / WebSocket 均认 NODE_EXTRA_CA_CERTS）。
# 优先使用构建上下文 build/bun-linux-<arch>.zip（本机预下载，避免目标机访问 github 不稳定），缺失时再联网安装。
COPY build/ /tmp/build/
RUN BUN_ARCH="$([ "${TARGETARCH}" = "arm64" ] && echo aarch64 || echo x64)" \
    && if [ -f "/tmp/build/bun-linux-${BUN_ARCH}.zip" ]; then \
         unzip -q "/tmp/build/bun-linux-${BUN_ARCH}.zip" -d /tmp/bunzip \
         && install -m 755 "/tmp/bunzip/bun-linux-${BUN_ARCH}/bun" /usr/local/bin/bun \
         && rm -rf /tmp/bunzip; \
       else \
         for i in 1 2 3 4 5; do \
           curl -fsSL --retry 3 https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && break; \
           echo "bun install attempt $i failed, retrying" && sleep 5; \
         done; \
       fi \
    && bun --version

# 改名前的 tarball 只有 bin/tmex.js，补一个 bin/vibeterm.js 符号链接，下游脚本统一按新名调用。
RUN cp /tmp/build/vibeterm-cli.tgz /tmp/vibeterm-cli.tgz && mkdir -p /opt/vibeterm-pkg /opt/vibeterm/runtime /opt/vibeterm/resources /opt/vibeterm/native /var/lib/vibeterm \
    && tar -xzf /tmp/vibeterm-cli.tgz -C /opt/vibeterm-pkg \
    && cp -a /opt/vibeterm-pkg/package/dist/runtime/. /opt/vibeterm/runtime/ \
    && cp -a /opt/vibeterm-pkg/package/resources/fe-dist /opt/vibeterm/resources/fe-dist \
    && cp -a /opt/vibeterm-pkg/package/resources/gateway-drizzle /opt/vibeterm/resources/gateway-drizzle \
    && test -f /opt/vibeterm/runtime/server.js \
    && test -f /opt/vibeterm/runtime/cli-auth.js \
    && { test -f /opt/vibeterm-pkg/package/bin/vibeterm.js \
      || ln -s tmex.js /opt/vibeterm-pkg/package/bin/vibeterm.js; } \
    && test -f /opt/vibeterm-pkg/package/bin/vibeterm.js \
    && rm -rf /tmp/vibeterm-cli.tgz /tmp/build

COPY entrypoint.sh /usr/local/bin/vibeterm-entrypoint.sh
RUN chmod 755 /usr/local/bin/vibeterm-entrypoint.sh

WORKDIR /opt/vibeterm
EXPOSE 9883 39001
HEALTHCHECK --interval=5s --timeout=5s --start-period=90s --retries=24 \
    CMD curl -fsS http://127.0.0.1:9883/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/vibeterm-entrypoint.sh"]
