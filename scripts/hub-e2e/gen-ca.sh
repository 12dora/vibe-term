#!/usr/bin/env bash
# 生成私有 CA 与 hub.tmex.test / entry.tmex.test 的服务端证书。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CA_DIR="${ROOT}/ca"
mkdir -p "${CA_DIR}"

umask 077

openssl genrsa -out "${CA_DIR}/ca.key" 4096
openssl req -x509 -new -nodes -key "${CA_DIR}/ca.key" -sha256 -days 3650 \
  -subj "/CN=tmex-e2e-ca" -out "${CA_DIR}/ca.crt"

openssl genrsa -out "${CA_DIR}/hub.key" 2048
openssl req -new -key "${CA_DIR}/hub.key" -subj "/CN=hub.tmex.test" -out "${CA_DIR}/hub.csr"

cat > "${CA_DIR}/hub.ext" <<'EOF'
subjectAltName=DNS:hub.tmex.test,DNS:entry.tmex.test
extendedKeyUsage=serverAuth
keyUsage=digitalSignature,keyEncipherment
basicConstraints=CA:FALSE
EOF

openssl x509 -req -in "${CA_DIR}/hub.csr" -CA "${CA_DIR}/ca.crt" -CAkey "${CA_DIR}/ca.key" \
  -CAcreateserial -out "${CA_DIR}/hub.crt" -days 825 -sha256 -extfile "${CA_DIR}/hub.ext"

rm -f "${CA_DIR}/hub.csr"
chmod 644 "${CA_DIR}/ca.crt" "${CA_DIR}/hub.crt"
chmod 600 "${CA_DIR}/ca.key" "${CA_DIR}/hub.key"

echo "CA and server cert written to ${CA_DIR}"
