# tmex hub/node e2e 运行时。只从 ubuntu:24.04 构建；Caddy 另用 caddy:2。
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
        unzip \
        xz-utils \
        coreutils \
        procps \
    && rm -rf /var/lib/apt/lists/*

# Node 22 官方 tarball（不走 nodesource / Docker Hub 上的 node 镜像）
RUN NODE_ARCH="$([ "${TARGETARCH}" = "arm64" ] && echo arm64 || echo x64)" \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 \
    && node --version \
    && npm --version

# 钉死 Bun 1.3.14（fetch / WebSocket 均认 NODE_EXTRA_CA_CERTS）
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && bun --version

COPY build/tmex-cli.tgz /tmp/tmex-cli.tgz
RUN mkdir -p /opt/tmex-pkg /opt/tmex/runtime /opt/tmex/resources /opt/tmex/native /var/lib/tmex \
    && tar -xzf /tmp/tmex-cli.tgz -C /opt/tmex-pkg \
    && cp -a /opt/tmex-pkg/package/dist/runtime/. /opt/tmex/runtime/ \
    && cp -a /opt/tmex-pkg/package/resources/fe-dist /opt/tmex/resources/fe-dist \
    && cp -a /opt/tmex-pkg/package/resources/gateway-drizzle /opt/tmex/resources/gateway-drizzle \
    && test -f /opt/tmex/runtime/server.js \
    && test -f /opt/tmex/runtime/cli-auth.js \
    && test -f /opt/tmex-pkg/package/bin/tmex.js \
    && rm -f /tmp/tmex-cli.tgz

COPY entrypoint.sh /usr/local/bin/tmex-entrypoint.sh
RUN chmod 755 /usr/local/bin/tmex-entrypoint.sh

WORKDIR /opt/tmex
EXPOSE 9883 39001
HEALTHCHECK --interval=5s --timeout=5s --start-period=90s --retries=24 \
    CMD curl -fsS http://127.0.0.1:9883/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/tmex-entrypoint.sh"]
