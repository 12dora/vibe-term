#!/usr/bin/env bash
# VibeTerm installer: download the CLI tarball from GitHub Releases and run `init`.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/12dora/vibe-term/main/install.sh | bash
#   bash install.sh [init flags...]
#   bash install.sh --allow-unverified [init flags...]  # checksum skip, versions < 1.1.4 only
# Env:
#   VIBETERM_VERSION  pin a release (with or without leading v); TMEX_VERSION is accepted as an alias

VIBETERM_RELEASE_REPO='12dora/vibe-term'
VIBETERM_MIN_BUN_VERSION='1.3.0'

vibeterm_parse_tag_name() {
  printf '%s' "$1" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

vibeterm_version_from_tag() {
  local tag="$1"
  tag="${tag#v}"
  tag="${tag#V}"
  printf '%s' "$tag"
}

vibeterm_classify_checksum_http() {
  case "$1" in
    404) printf '%s' 'missing' ;;
    200) printf '%s' 'ok' ;;
    *) printf '%s' 'error' ;;
  esac
}

# Print the hex for a filename field that is EXACTLY $2 (no directories, no *).
# Rejects path-qualified entries such as /tmp/foo.tgz or ../foo.tgz.
vibeterm_sha256sums_hex_for() {
  local sums_file="$1"
  local want="$2"
  awk -v want="$want" '
    $1 ~ /^[a-fA-F0-9]{64}$/ {
      name = $2
      sub(/^\*/, "", name)
      if (name == want) {
        print tolower($1)
        found = 1
        exit 0
      }
    }
    END { if (!found) exit 1 }
  ' "$sums_file"
}

vibeterm_is_semver() {
  printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
}

vibeterm_tag_from_location_headers() {
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
vibeterm_version_ge() {
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

vibeterm_node_version_ok() {
  local ver="${1:-}"
  local major="${ver#v}"
  major="${major%%.*}"
  case "$major" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$major" -ge 20 ]
}

vibeterm_dir_on_path() {
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

vibeterm_need_cmd() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "vibeterm install: missing required command: $name" >&2
    exit 1
  fi
}

vibeterm_detect_os() {
  local os
  os="$(uname -s 2>/dev/null || true)"
  case "$os" in
    Darwin | Linux) ;;
    *)
      echo "vibeterm install: unsupported OS: ${os:-unknown} (need macOS or Linux)" >&2
      exit 1
      ;;
  esac
}

vibeterm_ensure_bun() {
  export PATH="${HOME}/.bun/bin:${PATH:-}"
  if command -v bun >/dev/null 2>&1; then
    local ver
    ver="$(bun --version 2>/dev/null || true)"
    if [ -n "$ver" ] && vibeterm_version_ge "$ver" "$VIBETERM_MIN_BUN_VERSION"; then
      return 0
    fi
    echo "vibeterm install: Bun ${ver:-unknown} is older than ${VIBETERM_MIN_BUN_VERSION}; installing a newer Bun"
  else
    echo "vibeterm install: Bun not found; installing via bun.sh"
  fi
  curl -fsSL https://bun.sh/install | bash
  export PATH="${HOME}/.bun/bin:${PATH:-}"
  if ! command -v bun >/dev/null 2>&1; then
    echo "vibeterm install: Bun install failed" >&2
    exit 1
  fi
  local ver
  ver="$(bun --version 2>/dev/null || true)"
  if [ -z "$ver" ] || ! vibeterm_version_ge "$ver" "$VIBETERM_MIN_BUN_VERSION"; then
    echo "vibeterm install: Bun ${ver:-unknown} is still older than ${VIBETERM_MIN_BUN_VERSION}" >&2
    exit 1
  fi
}

vibeterm_github_json() {
  local url="$1"
  curl -fsSL \
    -H 'Accept: application/vnd.github+json' \
    -H 'User-Agent: vibeterm-install' \
    "$url"
}

vibeterm_tag_from_latest_redirect() {
  local headers
  headers="$(curl -sI -H 'User-Agent: vibeterm-install' "https://github.com/${VIBETERM_RELEASE_REPO}/releases/latest")" || return 1
  vibeterm_tag_from_location_headers "$headers"
}

vibeterm_release_asset_url() {
  printf '%s' "https://github.com/${VIBETERM_RELEASE_REPO}/releases/download/v${1}/${2}"
}

vibeterm_resolve_version() {
  # 改名前的变量名继续接受，老脚本 / 老文档里写的是 TMEX_VERSION。
  local requested="${VIBETERM_VERSION:-${TMEX_VERSION:-}}"
  if [ -n "$requested" ]; then
    local pinned
    pinned="$(vibeterm_version_from_tag "$requested")"
    if ! vibeterm_is_semver "$pinned"; then
      echo "vibeterm install: invalid VIBETERM_VERSION: ${requested}" >&2
      exit 1
    fi
    printf '%s' "$pinned"
    return 0
  fi
  local tag version
  tag="$(vibeterm_tag_from_latest_redirect 2>/dev/null || true)"
  if [ -z "$tag" ]; then
    local json
    json="$(vibeterm_github_json "https://api.github.com/repos/${VIBETERM_RELEASE_REPO}/releases/latest")" || {
      echo "vibeterm install: failed to query GitHub Releases" >&2
      exit 1
    }
    tag="$(vibeterm_parse_tag_name "$json")"
  fi
  version="$(vibeterm_version_from_tag "$tag")"
  if [ -z "$version" ]; then
    echo "vibeterm install: latest release is missing a tag" >&2
    exit 1
  fi
  printf '%s' "$version"
}

vibeterm_print_latest() {
  vibeterm_resolve_version
  printf '\n'
}

vibeterm_run_init() {
  local pkg_dir="$1"
  shift
  local cli_js="${pkg_dir}/bin/vibeterm.js"
  [ -f "$cli_js" ] || cli_js="${pkg_dir}/bin/tmex.js"
  if command -v node >/dev/null 2>&1 && vibeterm_node_version_ok "$(node --version 2>/dev/null || true)"; then
    node "$cli_js" init "$@"
  else
    bun "$cli_js" init "$@"
  fi
}

VIBETERM_INSTALL_TMP=

vibeterm_cleanup_tmp() {
  if [ -n "${VIBETERM_INSTALL_TMP:-}" ] && [ -d "$VIBETERM_INSTALL_TMP" ]; then
    rm -rf "$VIBETERM_INSTALL_TMP"
    VIBETERM_INSTALL_TMP=
  fi
}

vibeterm_print_path_hint() {
  local local_bin="${HOME}/.local/bin"
  local bun_bin="${HOME}/.bun/bin"
  if vibeterm_dir_on_path "$local_bin"; then
    return 0
  fi
  if { [ -L "${bun_bin}/vibeterm" ] || [ -f "${bun_bin}/vibeterm" ]; } && vibeterm_dir_on_path "$bun_bin"; then
    return 0
  fi
  echo "If 'vibeterm' is not found, add ~/.local/bin to PATH:"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
}

vibeterm_install() {
  set -euo pipefail

  local allow_unverified=0
  local -a init_args=()
  local arg
  for arg in "$@"; do
    if [ "$arg" = "--allow-unverified" ]; then
      allow_unverified=1
    else
      init_args+=("$arg")
    fi
  done

  vibeterm_need_cmd curl
  vibeterm_need_cmd tar
  vibeterm_detect_os
  vibeterm_ensure_bun

  local version asset tarball_url tgz
  version="$(vibeterm_resolve_version)"
  asset="vibeterm-cli-${version}.tgz"

  VIBETERM_INSTALL_TMP="$(mktemp -d "${TMPDIR:-/tmp}/vibeterm-install.XXXXXX")"
  trap vibeterm_cleanup_tmp EXIT
  tgz="${VIBETERM_INSTALL_TMP}/package.tgz"

  tarball_url="$(vibeterm_release_asset_url "$version" "$asset")"
  echo "vibeterm install: downloading ${tarball_url}"
  if ! curl -fsSL -o "$tgz" -H 'User-Agent: vibeterm-install' "$tarball_url"; then
    # 桥接期：只发了改名前资产名的 release
    asset="tmex-cli-${version}.tgz"
    tarball_url="$(vibeterm_release_asset_url "$version" "$asset")"
    echo "vibeterm install: retrying with ${tarball_url}"
    if ! curl -fsSL -o "$tgz" -H 'User-Agent: vibeterm-install' "$tarball_url"; then
      echo "vibeterm install: failed to download ${asset} (version not found or network error)" >&2
      exit 1
    fi
  fi

  local sums_url="https://github.com/${VIBETERM_RELEASE_REPO}/releases/download/v${version}/SHA256SUMS"
  local sums_file="${VIBETERM_INSTALL_TMP}/SHA256SUMS"
  local sums_code
  sums_code="$(curl -sS -L -o "$sums_file" -w '%{http_code}' -H 'User-Agent: vibeterm-install' "$sums_url")" || {
    echo "vibeterm install: failed to fetch SHA256SUMS (network error)" >&2
    exit 1
  }
  local sums_class
  sums_class="$(vibeterm_classify_checksum_http "$sums_code")"
  if [ "$sums_class" = "missing" ]; then
    if vibeterm_version_ge "$version" "1.1.4"; then
      echo "vibeterm install: Release ${version} requires SHA256SUMS (HTTP 200, matching digest). Refusing to continue." >&2
      exit 1
    fi
    if [ "$allow_unverified" -ne 1 ]; then
      echo "vibeterm install: Release ${version} has no SHA256SUMS. Re-run with --allow-unverified to proceed." >&2
      exit 1
    fi
    echo "vibeterm install: SHA256SUMS not found; tarball integrity is unverified"
  elif [ "$sums_class" != "ok" ]; then
    echo "vibeterm install: failed to fetch SHA256SUMS (HTTP ${sums_code})" >&2
    exit 1
  else
    local expected_hex actual_hex
    if ! expected_hex="$(vibeterm_sha256sums_hex_for "$sums_file" "$asset")"; then
      if ! expected_hex="$(vibeterm_sha256sums_hex_for "$sums_file" "tmex-cli-${version}.tgz")"; then
        echo "vibeterm install: SHA256SUMS does not list ${asset}" >&2
        exit 1
      fi
    fi
    if command -v shasum >/dev/null 2>&1; then
      actual_hex="$(shasum -a 256 "$tgz" | awk '{print $1}')"
    else
      actual_hex="$(sha256sum "$tgz" | awk '{print $1}')"
    fi
    expected_hex="$(printf '%s' "$expected_hex" | tr 'A-F' 'a-f')"
    actual_hex="$(printf '%s' "$actual_hex" | tr 'A-F' 'a-f')"
    if [ "$actual_hex" != "$expected_hex" ]; then
      echo "vibeterm install: Release tarball sha256 mismatch for ${asset}" >&2
      exit 1
    fi
  fi

  tar -xzf "$tgz" -C "$VIBETERM_INSTALL_TMP"
  local pkg_dir="${VIBETERM_INSTALL_TMP}/package"
  if [ ! -f "${pkg_dir}/bin/vibeterm.js" ] && [ ! -f "${pkg_dir}/bin/tmex.js" ]; then
    echo "vibeterm install: tarball is missing package/bin/vibeterm.js" >&2
    exit 1
  fi

  if [ ! -t 0 ]; then
    if { exec 3</dev/tty; } 2>/dev/null; then
      echo "vibeterm install: stdin is not a TTY; attaching /dev/tty for prompts"
      vibeterm_run_init "$pkg_dir" "${init_args[@]+"${init_args[@]}"}" <&3
      exec 3<&-
    else
      echo "vibeterm install: no TTY; passing --no-interactive"
      vibeterm_run_init "$pkg_dir" "${init_args[@]+"${init_args[@]}"}" --no-interactive
    fi
  else
    vibeterm_run_init "$pkg_dir" "${init_args[@]+"${init_args[@]}"}"
  fi

  echo
  echo "vibeterm install: done. The vibeterm command is installed to ~/.local/bin/vibeterm"
  vibeterm_print_path_hint
}

# When sourced (unit tests), functions stay defined and main does not run.
if [[ "${1:-}" == "--print-latest" ]]; then
  set -euo pipefail
  vibeterm_print_latest
  exit 0
fi

return 0 2>/dev/null || vibeterm_install "$@"
