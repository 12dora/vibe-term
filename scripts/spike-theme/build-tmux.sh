#!/bin/bash
# 本机源码构建多版本 tmux 到指定前缀（阶段 1.5，供真 TUI 交叉实测）
set -eu
PREFIX_ROOT=${1:?用法: build-tmux.sh <安装根目录> [版本...]}
shift
VERSIONS=${*:-3.2a 3.7b}

BREW_PREFIX=$(brew --prefix)
export CPPFLAGS="-I$BREW_PREFIX/opt/libevent/include -I$BREW_PREFIX/opt/ncurses/include -I$BREW_PREFIX/opt/utf8proc/include"
export LDFLAGS="-L$BREW_PREFIX/opt/libevent/lib -L$BREW_PREFIX/opt/ncurses/lib -L$BREW_PREFIX/opt/utf8proc/lib"
export PKG_CONFIG_PATH="$BREW_PREFIX/opt/libevent/lib/pkgconfig:$BREW_PREFIX/opt/ncurses/lib/pkgconfig"

mkdir -p "$PREFIX_ROOT/src"
for v in $VERSIONS; do
  dest="$PREFIX_ROOT/tmux-$v"
  if [ -x "$dest/bin/tmux" ]; then
    echo "[skip] $($dest/bin/tmux -V) 已存在"
    continue
  fi
  cd "$PREFIX_ROOT/src"
  tarball="tmux-$v.tar.gz"
  [ -f "$tarball" ] || curl -fsSL -o "$tarball" "https://github.com/tmux/tmux/releases/download/$v/tmux-$v.tar.gz"
  rm -rf "tmux-$v"
  tar xzf "$tarball"
  cd "tmux-$v"
  ./configure --prefix="$dest" --enable-utf8proc >/dev/null
  make -j8 >/dev/null
  make install >/dev/null
  echo "[built] $($dest/bin/tmux -V)"
done
