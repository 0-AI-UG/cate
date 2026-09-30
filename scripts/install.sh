#!/bin/sh
# Installs the Cate runtime on this machine (architecture 7.1):
#
#   curl -fsSL https://github.com/0-AI-UG/cate/releases/latest/download/install.sh | sh
#
# Downloads the release tarball for this platform into ~/.cate/runtime/<version>/
# (the layout the desktop app installs too) and puts a `cate` launcher in
# ~/.local/bin.
# Then `cate serve [path] [--connect]` serves a workspace to paired devices.
#
# CATE_VERSION=2.0.4 picks a release (default: the latest). CATE_BIN_DIR picks
# where the `cate` launcher goes (default: ~/.local/bin).
#
# Names must match src/runtime/daemon/contract/install.ts (tarballName,
# releaseUrl, installLayout, INSTALL_MARKER).

set -eu

OWNER=0-AI-UG
REPO=cate

fail() {
  echo "cate install: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

need curl
need tar
need uname

case "$(uname -s)" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) fail "unsupported system $(uname -s); on Windows, install the Cate desktop app" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac
target="$platform-$arch"
[ "$target" = darwin-x64 ] || [ "$target" = darwin-arm64 ] || [ "$target" = linux-x64 ] || [ "$target" = linux-arm64 ] \
  || fail "no runtime is built for $target"

version="${CATE_VERSION:-}"
if [ -z "$version" ]; then
  latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$OWNER/$REPO/releases/latest") \
    || fail "could not look up the latest release"
  version=${latest##*/}
fi
version=${version#v}
[ -n "$version" ] || fail "could not tell the release version"

tarball="cate-runtime-$version-$target.tgz"
url="https://github.com/$OWNER/$REPO/releases/download/v$version/$tarball"
install_dir="$HOME/.cate/runtime/$version"
bin_dir="${CATE_BIN_DIR:-$HOME/.local/bin}"

if [ -f "$install_dir/.ok" ] && [ "$(cat "$install_dir/.ok")" = "$version" ]; then
  echo "Cate runtime $version is already installed in $install_dir"
else
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/cate-install.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT INT TERM
  echo "Downloading $tarball"
  curl -fL --progress-bar -o "$tmp/$tarball" "$url" || fail "download failed: $url"
  mkdir -p "$tmp/stage"
  tar -xzf "$tmp/$tarball" -C "$tmp/stage" || fail "could not unpack $tarball"
  [ -f "$tmp/stage/runtime.cjs" ] && [ -x "$tmp/stage/runtime/bin/node" ] || fail "$tarball is incomplete"
  printf '%s' "$version" >"$tmp/stage/.ok"
  mkdir -p "$HOME/.cate/runtime"
  chmod 700 "$HOME/.cate"
  rm -rf "$install_dir"
  mv "$tmp/stage" "$install_dir"
  echo "Installed the Cate runtime $version in $install_dir"
fi

# A launcher, not a symlink: the install's shim finds its Node relative to
# its own path.
mkdir -p "$bin_dir"
rm -f "$bin_dir/cate"
printf '#!/bin/sh\nexec "%s" "$@"\n' "$install_dir/cate/bin/cate" >"$bin_dir/cate"
chmod 755 "$bin_dir/cate"
echo "Installed $bin_dir/cate"

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "Add $bin_dir to your PATH, for example: echo 'export PATH=\"$bin_dir:\$PATH\"' >> ~/.profile" ;;
esac
echo "Serve a workspace with: cate serve [path] [--connect]"
