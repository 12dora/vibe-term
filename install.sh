#!/bin/sh
# VibeTerm installer: download the CLI tarball from GitHub Releases and run `init`.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/12dora/vibe-term/main/install.sh | sh
#   wget -qO- https://raw.githubusercontent.com/12dora/vibe-term/main/install.sh | sh
#   sh install.sh [init flags...]
#   sh install.sh --allow-unverified [init flags...]  # checksum skip, versions < 1.1.4 only
# Env:
#   VIBETERM_VERSION  pin a release (with or without leading v); TMEX_VERSION is accepted as an alias
VIBETERM_RELEASE_REPO='12dora/vibe-term'
VIBETERM_MIN_BUN_VERSION='1.3.0'
VIBETERM_INSTALL_UA='User-Agent: vibeterm-install'
VIBETERM_INSTALL_TMP=
VIBETERM_CLI_ASSET=
vibeterm_die() { echo "vibeterm install: $*" >&2; exit 1; }
vibeterm_version_from_tag() {
  local tag="$1"
  tag="${tag#v}"; tag="${tag#V}"
  printf '%s' "$tag"
}
vibeterm_classify_checksum_http() {
  case "$1" in
    404) printf '%s' missing ;;
    200) printf '%s' ok ;;
    *) printf '%s' error ;;
  esac
}
# Hex for a filename field that is EXACTLY $2 (no directories, no *).
vibeterm_sha256sums_hex_for() {
  awk -v want="$2" '
    length($1) == 64 && $1 !~ /[^a-fA-F0-9]/ {
      name = $2
      sub(/^\*/, "", name)
      if (name == want) { print tolower($1); found = 1; exit 0 }
    }
    END { if (!found) exit 1 }
  ' "$1"
}
vibeterm_is_semver() {
  printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
}
vibeterm_tag_from_location_headers() {
  local location tag
  location="$(printf '%s' "$1" | grep -i '^[[:space:]]*location:' | head -n 1 | tr -d '\r')"
  location="${location#*:}"
  location="${location#"${location%%[![:space:]]*}"}"
  location="${location%"${location##*[![:space:]]}"}"
  [ -n "$location" ] || return 1
  location="${location%/}"
  tag="${location##*/}"
  [ -n "$tag" ] || return 1
  printf '%s' "$tag"
}
# Returns 0 if $1 >= $2 (dotted numeric prefix).
vibeterm_version_ge() {
  local left="$1" right="$2" i=0 x y
  while [ "$i" -lt 3 ]; do
    x="${left%%.*}"; y="${right%%.*}"
    case "$left" in *.*) left="${left#*.}" ;; *) left=0 ;; esac
    case "$right" in *.*) right="${right#*.}" ;; *) right=0 ;; esac
    x="${x%%[!0-9]*}"; y="${y%%[!0-9]*}"
    x="${x:-0}"; y="${y:-0}"
    [ "$x" -gt "$y" ] && return 0
    [ "$x" -lt "$y" ] && return 1
    i=$((i + 1))
  done
  return 0
}
vibeterm_node_version_ok() {
  local major="${1#v}"
  major="${major%%.*}"
  case "$major" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$major" -ge 20 ]
}
vibeterm_dir_on_path() {
  local needle="${1%/}" IFS=: entry
  for entry in ${PATH:-}; do
    [ "${entry%/}" = "$needle" ] && return 0
  done
  return 1
}
vibeterm_detect_os() {
  local os
  os="$(uname -s 2>/dev/null || true)"
  case "$os" in
    Darwin | Linux) ;;
    *) vibeterm_die "unsupported OS: ${os:-unknown} (need macOS or Linux)" ;;
  esac
}
vibeterm_http_client() {
  if command -v curl >/dev/null 2>&1; then
    printf '%s' curl
    return 0
  fi
  if command -v wget >/dev/null 2>&1; then
    printf '%s' wget
    return 0
  fi
  echo "vibeterm install: missing required command: curl or wget" >&2
  return 1
}
vibeterm_http_get() {
  local url="$1" dest="$2"
  case "$(vibeterm_http_client)" in
    curl) curl -fsSL -o "$dest" -H "$VIBETERM_INSTALL_UA" "$url" ;;
    wget) wget -q -O "$dest" --header "$VIBETERM_INSTALL_UA" "$url" ;;
    *) return 1 ;;
  esac
}
vibeterm_http_status_from_headers() {
  printf '%s' "$1" | awk '
    { sub(/\r$/, ""); n = split($0, f, " ")
      if (n >= 2 && f[1] ~ /^[Hh][Tt][Tt][Pp]\// && f[2] ~ /^[0-9][0-9][0-9]$/) code = f[2] }
    END { if (code != "") { print code; exit 0 } exit 1 }'
}
vibeterm_http_get_code() {
  local url="$1" dest="$2" hdr code
  case "$(vibeterm_http_client)" in
    curl) curl -sS -L -o "$dest" -w '%{http_code}' -H "$VIBETERM_INSTALL_UA" "$url" || return 1 ;;
    wget)
      hdr="${dest}.hdr"
      wget -S -O "$dest" --header "$VIBETERM_INSTALL_UA" "$url" >"$hdr" 2>&1 || true
      code="$(vibeterm_http_status_from_headers "$(cat "$hdr")")" || return 1
      printf '%s' "$code"
      ;;
    *) return 1 ;;
  esac
}
# $1 alpine-release, $2 ld-musl glob, $3 optional ldd --version dump (tests).
vibeterm_libc_is_musl() {
  local alpine_release="${1:-/etc/alpine-release}"
  local musl_glob="${2:-/lib/ld-musl-*}"
  local ldd_version_file="${3:-}"
  [ -f "$alpine_release" ] && return 0
  if [ -n "$ldd_version_file" ]; then
    grep -q musl "$ldd_version_file" 2>/dev/null && return 0
  else
    ldd --version 2>&1 | grep -q musl && return 0
  fi
  set -- $musl_glob
  [ -e "$1" ]
}
# $1 arch $2 cpuinfo $3 alpine-release $4 ld-musl glob $5 optional ldd dump.
vibeterm_bun_release_target() {
  local arch="$1" cpuinfo="${2:-/proc/cpuinfo}" alpine_release="${3:-/etc/alpine-release}"
  local musl_glob="${4:-/lib/ld-musl-*}" ldd_version_file="${5:-}" target
  case "$arch" in
    x86_64 | amd64) target=linux-x64 ;;
    aarch64 | arm64) target=linux-aarch64 ;;
    *) echo "vibeterm install: unsupported CPU architecture for Bun zip: ${arch}" >&2; return 1 ;;
  esac
  if vibeterm_libc_is_musl "$alpine_release" "$musl_glob" "$ldd_version_file"; then
    target="${target}-musl"
  fi
  case "$target" in
    linux-x64*)
      if ! grep -q avx2 "$cpuinfo" 2>/dev/null; then target="${target}-baseline"; fi
      ;;
  esac
  printf '%s' "$target"
}
vibeterm_file_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}
vibeterm_verify_named_sha256() {
  local file="$1" sums="$2" name="$3" expected actual
  expected="$(vibeterm_sha256sums_hex_for "$sums" "$name")" || \
    vibeterm_die "SHA256SUMS does not list ${name}"
  actual="$(vibeterm_file_sha256 "$file")"
  expected="$(printf '%s' "$expected" | tr 'A-F' 'a-f')"
  actual="$(printf '%s' "$actual" | tr 'A-F' 'a-f')"
  [ "$actual" = "$expected" ] || vibeterm_die "Release tarball sha256 mismatch for ${name}"
}
vibeterm_install_bun_zip() {
  local os target zip sums dest_dir work own_tmp=0
  os="$(uname -s 2>/dev/null || true)"
  case "$os" in
    Linux) ;;
    *) vibeterm_die "Bun zip bootstrap supports Linux only; install bash and curl to use bun.sh" ;;
  esac
  command -v unzip >/dev/null 2>&1 || { echo "unzip is required; on Alpine: apk add unzip" >&2; exit 1; }
  target="$(vibeterm_bun_release_target "$(uname -m)")" || exit 1
  if [ -n "${VIBETERM_INSTALL_TMP:-}" ]; then
    work="$VIBETERM_INSTALL_TMP"
  else
    work="$(mktemp -d "${TMPDIR:-/tmp}/vibeterm-bun.XXXXXX")"
    own_tmp=1
  fi
  zip="${work}/bun.zip"; sums="${work}/SHASUMS256.txt"
  echo "vibeterm install: downloading bun-${target}.zip"
  vibeterm_http_get "https://github.com/oven-sh/bun/releases/latest/download/bun-${target}.zip" "$zip" || \
    vibeterm_die "failed to download bun-${target}.zip"
  vibeterm_http_get "https://github.com/oven-sh/bun/releases/latest/download/SHASUMS256.txt" "$sums" || \
    vibeterm_die "failed to fetch bun SHASUMS256.txt"
  vibeterm_verify_named_sha256 "$zip" "$sums" "bun-${target}.zip"
  dest_dir="${HOME}/.bun/bin"
  mkdir -p "$dest_dir"
  unzip -oq "$zip" -d "$dest_dir"
  mv "${dest_dir}/bun-${target}/bun" "${dest_dir}/bun"
  chmod +x "${dest_dir}/bun"
  rm -rf "${dest_dir}/bun-${target}"
  [ "$own_tmp" -eq 1 ] && rm -rf "$work"
}
vibeterm_ensure_bun() {
  local ver
  export PATH="${HOME}/.bun/bin:${PATH:-}"
  if command -v bun >/dev/null 2>&1; then
    ver="$(bun --version 2>/dev/null || true)"
    if [ -n "$ver" ] && vibeterm_version_ge "$ver" "$VIBETERM_MIN_BUN_VERSION"; then return 0; fi
    echo "vibeterm install: Bun ${ver:-unknown} is older than ${VIBETERM_MIN_BUN_VERSION}; installing a newer Bun"
  else
    echo "vibeterm install: Bun not found; installing via bun.sh"
  fi
  if command -v bash >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
    curl -fsSL https://bun.sh/install | bash
  else
    vibeterm_install_bun_zip
  fi
  export PATH="${HOME}/.bun/bin:${PATH:-}"
  command -v bun >/dev/null 2>&1 || vibeterm_die "Bun install failed"
  ver="$(bun --version 2>/dev/null || true)"
  if [ -z "$ver" ] || ! vibeterm_version_ge "$ver" "$VIBETERM_MIN_BUN_VERSION"; then
    vibeterm_die "Bun ${ver:-unknown} is still older than ${VIBETERM_MIN_BUN_VERSION}"
  fi
}
vibeterm_tag_from_latest_redirect() {
  local headers url="https://github.com/${VIBETERM_RELEASE_REPO}/releases/latest"
  case "$(vibeterm_http_client)" in
    curl) headers="$(curl -sI -m 15 -H "$VIBETERM_INSTALL_UA" "$url")" || return 1 ;;
    wget)
      # busybox wget has no -I / --max-redirect; take the first Location from -S.
      headers="$(wget -S -O /dev/null --header "$VIBETERM_INSTALL_UA" -T 15 "$url" 2>&1)" || true
      ;;
    *) return 1 ;;
  esac
  vibeterm_tag_from_location_headers "$headers"
}
# `releases/latest` 的 302 不占 REST 配额：按 1/2/4 s 退避重试，不再回退任何 API。
vibeterm_latest_version_with_retry() {
  local delays="${VIBETERM_LATEST_RETRY_DELAYS:-1 2 4}" delay tag version
  while :; do
    tag="$(vibeterm_tag_from_latest_redirect 2>/dev/null || true)"
    version="$(vibeterm_version_from_tag "$tag")"
    if vibeterm_is_semver "$version"; then
      printf '%s' "$version"
      return 0
    fi
    [ -n "$delays" ] || return 1
    delay="${delays%% *}"
    if [ "$delays" = "$delay" ]; then delays=''; else delays="${delays#* }"; fi
    sleep "$delay"
  done
}
vibeterm_resolve_version() {
  local requested="${VIBETERM_VERSION:-${TMEX_VERSION:-}}" pinned version
  if [ -n "$requested" ]; then
    pinned="$(vibeterm_version_from_tag "$requested")"
    vibeterm_is_semver "$pinned" || vibeterm_die "invalid VIBETERM_VERSION: ${requested}"
    printf '%s' "$pinned"
    return 0
  fi
  version="$(vibeterm_latest_version_with_retry)" || {
    echo "vibeterm install: could not resolve the latest release from github.com/${VIBETERM_RELEASE_REPO}/releases/latest after 4 attempts" >&2
    echo "vibeterm install: check your network, or pin a version, e.g. VIBETERM_VERSION=<ver> sh install.sh" >&2
    exit 1
  }
  printf '%s' "$version"
}
vibeterm_print_latest() { vibeterm_resolve_version; printf '\n'; }
# Preserve init's exit status through tee without pipefail.
vibeterm_run_cli_logged() {
  local runner="$1" cli_js="$2" stf status
  shift 2
  stf="${VIBETERM_INSTALL_TMP:-${TMPDIR:-/tmp}}/vibeterm-init.status.$$"
  (
    set +e
    "$runner" "$cli_js" init "$@"
    echo $? >"$stf"
  ) | tee -a "$VIBETERM_INIT_LOG"
  status="$(cat "$stf")"
  rm -f "$stf"
  return "$status"
}
vibeterm_run_init() {
  local pkg_dir="$1" runner cli_js
  shift
  cli_js="${pkg_dir}/bin/vibeterm.js"
  [ -f "$cli_js" ] || cli_js="${pkg_dir}/bin/tmex.js"
  export VIBETERM_INSTALL_SOURCE=install.sh
  if command -v node >/dev/null 2>&1 && vibeterm_node_version_ok "$(node --version 2>/dev/null || true)"; then
    runner=node
  else
    runner=bun
  fi
  if [ -z "${VIBETERM_INIT_LOG:-}" ]; then
    "$runner" "$cli_js" init "$@"
    return $?
  fi
  vibeterm_run_cli_logged "$runner" "$cli_js" "$@"
}
# `set -e` 会让 init 的非零退出直接静默中断整个脚本，用户看不到发生了什么。
vibeterm_run_init_or_fail() {
  local status=0
  vibeterm_run_init "$@" || status=$?
  if [ "$status" -ne 0 ]; then
    echo "vibeterm install: init failed (exit ${status}); see the message above" >&2
    exit "$status"
  fi
}
vibeterm_cleanup_tmp() {
  if [ -n "${VIBETERM_INSTALL_TMP:-}" ] && [ -d "$VIBETERM_INSTALL_TMP" ]; then
    rm -rf "$VIBETERM_INSTALL_TMP"
    VIBETERM_INSTALL_TMP=
  fi
}
vibeterm_print_path_hint() {
  local local_bin="${HOME}/.local/bin" bun_bin="${HOME}/.bun/bin"
  vibeterm_dir_on_path "$local_bin" && return 0
  if { [ -L "${bun_bin}/vibeterm" ] || [ -f "${bun_bin}/vibeterm" ]; } && vibeterm_dir_on_path "$bun_bin"; then
    return 0
  fi
  echo "If 'vibeterm' is not found, add ~/.local/bin to PATH:"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
}
vibeterm_hint_alpine() {
  [ -f /etc/alpine-release ] || return 0
  if ! command -v tmux >/dev/null 2>&1; then
    echo "vibeterm install: tmux not found; on Alpine: apk add tmux"
  fi
  if [ ! -e /usr/lib/libstdc++.so.6 ] || [ ! -e /usr/lib/libgcc_s.so.1 ]; then
    echo "vibeterm install: musl bun needs libstdc++; on Alpine: apk add libstdc++ libgcc"
  fi
}
vibeterm_download_cli() {
  local version="$1" tgz="$2" asset tarball_url
  asset="vibeterm-cli-${version}.tgz"
  tarball_url="https://github.com/${VIBETERM_RELEASE_REPO}/releases/download/v${version}/${asset}"
  echo "vibeterm install: downloading ${tarball_url}"
  if vibeterm_http_get "$tarball_url" "$tgz"; then
    VIBETERM_CLI_ASSET="$asset"
    return 0
  fi
  asset="tmex-cli-${version}.tgz"
  tarball_url="https://github.com/${VIBETERM_RELEASE_REPO}/releases/download/v${version}/${asset}"
  echo "vibeterm install: retrying with ${tarball_url}"
  if vibeterm_http_get "$tarball_url" "$tgz"; then
    VIBETERM_CLI_ASSET="$asset"
    return 0
  fi
  vibeterm_die "failed to download ${asset} (version not found or network error)"
}
vibeterm_verify_cli_tarball() {
  local version="$1" asset="$2" tgz="$3" allow_unverified="$4"
  local sums_file="${VIBETERM_INSTALL_TMP}/SHA256SUMS" sums_code sums_class
  local sums_url="https://github.com/${VIBETERM_RELEASE_REPO}/releases/download/v${version}/SHA256SUMS"
  sums_code="$(vibeterm_http_get_code "$sums_url" "$sums_file")" || \
    vibeterm_die "failed to fetch SHA256SUMS (network error)"
  sums_class="$(vibeterm_classify_checksum_http "$sums_code")"
  case "$sums_class" in
    missing)
      if vibeterm_version_ge "$version" "1.1.4"; then
        vibeterm_die "Release ${version} requires SHA256SUMS (HTTP 200, matching digest). Refusing to continue."
      fi
      if [ "$allow_unverified" -ne 1 ]; then
        vibeterm_die "Release ${version} has no SHA256SUMS. Re-run with --allow-unverified to proceed."
      fi
      echo "vibeterm install: SHA256SUMS not found; tarball integrity is unverified"
      ;;
    ok)
      if ! vibeterm_sha256sums_hex_for "$sums_file" "$asset" >/dev/null; then
        asset="tmex-cli-${version}.tgz"
      fi
      vibeterm_verify_named_sha256 "$tgz" "$sums_file" "$asset"
      ;;
    *) vibeterm_die "failed to fetch SHA256SUMS (HTTP ${sums_code})" ;;
  esac
}
vibeterm_invoke_init() {
  local pkg_dir="$1"
  shift
  if [ -t 0 ]; then
    vibeterm_run_init_or_fail "$pkg_dir" "$@"
    return
  fi
  # dash/ash `exec 3</dev/tty` exits the shell on failure; probe in a subshell.
  if ( : </dev/tty ) 2>/dev/null; then
    vibeterm_run_init_or_fail "$pkg_dir" "$@" </dev/tty
  else
    echo "vibeterm install: no TTY; running non-interactively"
    vibeterm_run_init_or_fail "$pkg_dir" "$@" --no-interactive
  fi
}
vibeterm_install() {
  set -eu
  local allow_unverified=0 has=0 arg version tgz pkg_dir init_log
  for arg in "$@"; do
    if [ "$arg" = "--allow-unverified" ]; then
      allow_unverified=1
    elif [ "$has" -eq 0 ]; then
      set -- "$arg"; has=1
    else
      set -- "$@" "$arg"
    fi
  done
  [ "$has" -eq 1 ] || set --
  vibeterm_http_client >/dev/null || exit 1
  command -v tar >/dev/null 2>&1 || vibeterm_die "missing required command: tar"
  vibeterm_detect_os
  vibeterm_hint_alpine
  vibeterm_ensure_bun
  version="$(vibeterm_resolve_version)"
  VIBETERM_INSTALL_TMP="$(mktemp -d "${TMPDIR:-/tmp}/vibeterm-install.XXXXXX")"
  trap vibeterm_cleanup_tmp EXIT
  tgz="${VIBETERM_INSTALL_TMP}/package.tgz"
  vibeterm_download_cli "$version" "$tgz"
  vibeterm_verify_cli_tarball "$version" "$VIBETERM_CLI_ASSET" "$tgz" "$allow_unverified"
  tar -xzf "$tgz" -C "$VIBETERM_INSTALL_TMP"
  pkg_dir="${VIBETERM_INSTALL_TMP}/package"
  if [ ! -f "${pkg_dir}/bin/vibeterm.js" ] && [ ! -f "${pkg_dir}/bin/tmex.js" ]; then
    vibeterm_die "tarball is missing package/bin/vibeterm.js"
  fi
  init_log="${VIBETERM_INSTALL_TMP}/init.log"
  VIBETERM_INIT_LOG="$init_log"
  vibeterm_invoke_init "$pkg_dir" "$@"
  echo
  echo "vibeterm install: done. The vibeterm command is installed to ~/.local/bin/vibeterm"
  if vibeterm_init_role_is_relay "$@"; then
    vibeterm_print_relay_turn_firewall_hint "$(cat "$init_log" 2>/dev/null || true)"
  fi
  vibeterm_print_path_hint
}
vibeterm_init_role_is_relay() {
  local prev="" arg
  for arg in "$@"; do
    if [ "$prev" = "--role" ]; then
      case "$arg" in
        relay | relay,node) return 0 ;;
      esac
    fi
    prev="$arg"
  done
  return 1
}
# 数字来自 CLI `init` 打印的 formatPortList，禁止在此写死 3478。
vibeterm_extract_port_list() {
  printf '%s' "$1" | grep -oE '[0-9]+(-[0-9]+)?/(tcp|udp)(, [0-9]+(-[0-9]+)?/(tcp|udp))+' | tail -n 1
}
vibeterm_print_relay_turn_firewall_hint() {
  local list control range
  list="$(vibeterm_extract_port_list "${1:-}")"
  [ -n "$list" ] || return 0
  control="$(printf '%s' "$list" | grep -oE '(^|, )[0-9]+/udp' | head -n 1 | grep -oE '[0-9]+')"
  range="$(printf '%s' "$list" | grep -oE '[0-9]+-[0-9]+/udp' | head -n 1 | cut -d/ -f1)"
  [ -n "$control" ] && [ -n "$range" ] || return 0
  echo "open UDP ${control} and UDP ${range} on the cloud security group / ufw"
}
case "${1:-}" in
  --print-latest)
    set -eu
    vibeterm_print_latest
    exit 0
    ;;
esac
# 单测以 VIBETERM_INSTALL_LIB=1 source 本文件，只取函数定义。
[ -n "${VIBETERM_INSTALL_LIB:-}" ] && return 0
vibeterm_install "$@"
