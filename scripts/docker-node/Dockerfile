# 可升级的 tmex 节点容器。与 scripts/hub-e2e/Dockerfile 同源：ubuntu:24.04 +
# Node 22 官方 tarball + 钉死版本的 Bun，运行时由 tmex-cli 自己铺装到 /opt/tmex。
# 多架构：TARGETARCH=amd64|arm64（Apple Silicon 上原生构建 arm64，不走 qemu）。
FROM ubuntu:24.04
ARG TARGETARCH
# 打进镜像的 tmex-cli 包，路径相对构建上下文（scripts/docker-node）。
ARG TMEX_TARBALL=build/tmex-cli.tgz

ENV DEBIAN_FRONTEND=noninteractive \
    BUN_INSTALL=/usr/local \
    BUN_VERSION=1.3.14 \
    NODE_VERSION=22.18.0 \
    PATH=/usr/local/bin:$PATH

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        coreutils \
        curl \
        openssl \
        procps \
        tmux \
        unzip \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Node 22 官方 tarball（不走 nodesource / node 官方镜像）。
RUN NODE_ARCH="$([ "${TARGETARCH}" = "arm64" ] && echo arm64 || echo x64)" \
    && curl -fsSL --retry 5 --retry-delay 5 "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 \
    && node --version \
    && npm --version

# 钉死 Bun。优先用构建上下文 build/bun-linux-<arch>.zip（本机预下载，避免目标机访问 github 不稳定）。
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

# 安装包只解包到 /opt/tmex-pkg，首启由 entrypoint 调 `tmex init` 铺装到 /opt/tmex（named volume）。
COPY ${TMEX_TARBALL} /opt/tmex-pkg/tmex-cli.tgz
RUN tar -xzf /opt/tmex-pkg/tmex-cli.tgz -C /opt/tmex-pkg \
    && test -f /opt/tmex-pkg/package/bin/tmex.js \
    && test -f /opt/tmex-pkg/package/dist/cli-node.js \
    && test -f /opt/tmex-pkg/package/dist/runtime/server.js \
    && rm -rf /tmp/build

COPY entrypoint.sh /usr/local/bin/tmex-node-entrypoint.sh
RUN chmod 755 /usr/local/bin/tmex-node-entrypoint.sh \
    && mkdir -p /opt/tmex /var/lib/tmex

WORKDIR /opt/tmex
EXPOSE 9883 39001
HEALTHCHECK --interval=10s --timeout=5s --start-period=120s --retries=18 \
    CMD curl -fsS http://127.0.0.1:9883/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/tmex-node-entrypoint.sh"]
