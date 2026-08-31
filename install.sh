#!/usr/bin/env bash
# tmex installer: download the CLI tarball from GitHub Releases and run `init`.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/12dora/tmex-enhanced/main/install.sh | bash
#   bash install.sh [init flags...]
# Env:
#   TMEX_VERSION  pin a release (with or without leading v)

TMEX_RELEASE_REPO='12dora/tmex-enhanced'
TMEX_MIN_BUN_VERSION='1.3.0'

tmex_parse_tag_name() {
  printf '%s' "$1" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

tmex_version_from_tag() {
  local tag="$1"
  tag="${tag#v}"
  tag="${tag#V}"
  printf '%s' "$tag"
}

tmex_is_semver() {
  printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
}

tmex_tag_from_location_headers() {
  local headers="$1"
  local location
  location="$(printf '%s' "$headers" | grep -i '^location:' | head -n 1 | tr -d '\r')"
  location="${location#*:}"
  location="${location#"${location%%[![:space:]]*}"}"
  location="${location%"${location##*[![:space:]]}"}"
  [ -n "$location" ] || return 1
  location="${location%/}"
  local tag="${location##*/}"
  [ -n "$tag" ] || return 1
  printf '%s' "$tag"
}

# Compare dotted versions. Returns 0 if $1 >= $2.
tmex_version_ge() {
  local IFS=.
  # shellcheck disable=SC2206
  local a=($1) b=($2)
  local i x y
  for i in 0 1 2; do
    x="${a[$i]:-0}"
    y="${b[$i]:-0}"
    x="${x%%[^0-9]*}"
    y="${y%%[^0-9]*}"
    x="${x:-0}"
    y="${y:-0}"
    if [ "$x" -gt "$y" ]; then
      return 0
    fi
    if [ "$x" -lt "$y" ]; then
      return 1
    fi
  done
  return 0
}

tmex_node_version_ok() {
  local ver="${1:-}"
  local major="${ver#v}"
  major="${major%%.*}"
  case "$major" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$major" -ge 20 ]
}

tmex_dir_on_path() {
  local needle="${1%/}"
  local IFS=:
  local entry
  for entry in ${PATH:-}; do
    if [ "${entry%/}" = "$needle" ]; then
      return 0
    fi
  done
  return 1
}

tmex_need_cmd() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "tmex install: missing required command: $name" >&2
    exit 1
  fi
}

tmex_detect_os() {
  local os
  os="$(uname -s 2>/dev/null || true)"
  case "$os" in
    Darwin | Linux) ;;
    *)
      echo "tmex install: unsupported OS: ${os:-unknown} (need macOS or Linux)" >&2
      exit 1
      ;;
  esac
}

tmex_ensure_bun() {
  export PATH="${HOME}/.bun/bin:${PATH:-}"
  if command -v bun >/dev/null 2>&1; then
    local ver
    ver="$(bun --version 2>/dev/null || true)"
    if [ -n "$ver" ] && tmex_version_ge "$ver" "$TMEX_MIN_BUN_VERSION"; then
      return 0
    fi
    echo "tmex install: Bun ${ver:-unknown} is older than ${TMEX_MIN_BUN_VERSION}; installing a newer Bun"
  else
    echo "tmex install: Bun not found; installing via bun.sh"
  fi
  curl -fsSL https://bun.sh/install | bash
  export PATH="${HOME}/.bun/bin:${PATH:-}"
  if ! command -v bun >/dev/null 2>&1; then
    echo "tmex install: Bun install failed" >&2
    exit 1
  fi
  local ver
  ver="$(bun --version 2>/dev/null || true)"
  if [ -z "$ver" ] || ! tmex_version_ge "$ver" "$TMEX_MIN_BUN_VERSION"; then
    echo "tmex install: Bun ${ver:-unknown} is still older than ${TMEX_MIN_BUN_VERSION}" >&2
    exit 1
  fi
}

tmex_github_json() {
  local url="$1"
  curl -fsSL \
    -H 'Accept: application/vnd.github+json' \
    -H 'User-Agent: tmex-install' \
    "$url"
}

tmex_tag_from_latest_redirect() {
  local headers
  headers="$(curl -sI -H 'User-Agent: tmex-install' "https://github.com/${TMEX_RELEASE_REPO}/releases/latest")" || return 1
  tmex_tag_from_location_headers "$headers"
}

tmex_resolve_version() {
  if [ -n "${TMEX_VERSION:-}" ]; then
    local pinned
    pinned="$(tmex_version_from_tag "$TMEX_VERSION")"
    if ! tmex_is_semver "$pinned"; then
      echo "tmex install: invalid TMEX_VERSION: ${TMEX_VERSION}" >&2
      exit 1
    fi
    printf '%s' "$pinned"
    return 0
  fi
  local tag version
  tag="$(tmex_tag_from_latest_redirect 2>/dev/null || true)"
  if [ -z "$tag" ]; then
    local json
    json="$(tmex_github_json "https://api.github.com/repos/${TMEX_RELEASE_REPO}/releases/latest")" || {
      echo "tmex install: failed to query GitHub Releases" >&2
      exit 1
    }
    tag="$(tmex_parse_tag_name "$json")"
  fi
  version="$(tmex_version_from_tag "$tag")"
  if [ -z "$version" ]; then
    echo "tmex install: latest release is missing a tag" >&2
    exit 1
  fi
  printf '%s' "$version"
}

tmex_print_latest() {
  tmex_resolve_version
  printf '\n'
}

tmex_run_init() {
  local pkg_dir="$1"
  shift
  local cli_js="${pkg_dir}/bin/tmex.js"
  if command -v node >/dev/null 2>&1 && tmex_node_version_ok "$(node --version 2>/dev/null || true)"; then
    node "$cli_js" init "$@"
  else
    bun "$cli_js" init "$@"
  fi
}

TMEX_INSTALL_TMP=

tmex_cleanup_tmp() {
  if [ -n "${TMEX_INSTALL_TMP:-}" ] && [ -d "$TMEX_INSTALL_TMP" ]; then
    rm -rf "$TMEX_INSTALL_TMP"
    TMEX_INSTALL_TMP=
  fi
}

tmex_print_path_hint() {
  local local_bin="${HOME}/.local/bin"
  local bun_bin="${HOME}/.bun/bin"
  if tmex_dir_on_path "$local_bin"; then
    return 0
  fi
  if { [ -L "${bun_bin}/tmex" ] || [ -f "${bun_bin}/tmex" ]; } && tmex_dir_on_path "$bun_bin"; then
    return 0
  fi
  echo "If 'tmex' is not found, add ~/.local/bin to PATH:"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
}

tmex_install() {
  set -euo pipefail

  tmex_need_cmd curl
  tmex_need_cmd tar
  tmex_detect_os
  tmex_ensure_bun

  local version tarball_url tgz
  version="$(tmex_resolve_version)"
  tarball_url="https://github.com/${TMEX_RELEASE_REPO}/releases/download/v${version}/tmex-cli-${version}.tgz"
  echo "tmex install: downloading ${tarball_url}"

  TMEX_INSTALL_TMP="$(mktemp -d "${TMPDIR:-/tmp}/tmex-install.XXXXXX")"
  trap tmex_cleanup_tmp EXIT
  tgz="${TMEX_INSTALL_TMP}/tmex-cli-${version}.tgz"

  if ! curl -fsSL -o "$tgz" -H 'User-Agent: tmex-install' "$tarball_url"; then
    echo "tmex install: failed to download ${tarball_url} (version not found or network error)" >&2
    exit 1
  fi

  tar -xzf "$tgz" -C "$TMEX_INSTALL_TMP"
  local pkg_dir="${TMEX_INSTALL_TMP}/package"
  if [ ! -f "${pkg_dir}/bin/tmex.js" ]; then
    echo "tmex install: tarball is missing package/bin/tmex.js" >&2
    exit 1
  fi

  local -a init_args
  init_args=("$@")
  if [ ! -t 0 ]; then
    if exec 3</dev/tty 2>/dev/null; then
      echo "tmex install: stdin is not a TTY; attaching /dev/tty for prompts"
      tmex_run_init "$pkg_dir" "${init_args[@]+"${init_args[@]}"}" <&3
      exec 3<&-
    else
      echo "tmex install: no TTY; passing --no-interactive"
      tmex_run_init "$pkg_dir" "${init_args[@]+"${init_args[@]}"}" --no-interactive
    fi
  else
    tmex_run_init "$pkg_dir" "${init_args[@]+"${init_args[@]}"}"
  fi

  echo
  echo "tmex install: done. The tmex command is installed to ~/.local/bin/tmex"
  tmex_print_path_hint
}

# When sourced (unit tests), functions stay defined and main does not run.
if [[ "${1:-}" == "--print-latest" ]]; then
  set -euo pipefail
  tmex_print_latest
  exit 0
fi

return 0 2>/dev/null || tmex_install "$@"
