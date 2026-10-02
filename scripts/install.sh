#!/bin/sh
# Installs the Cate runtime on this machine (architecture 7.1):
#
#   curl -fsSL https://github.com/0-AI-UG/cate/releases/latest/download/install.sh | sh
#
# Downloads the release tarball for this platform, checks it against its
# published SHA-256, installs it into ~/.cate/runtime/<build>/ (the layout the
# desktop app installs too), makes it the current install and puts a `cate`
# launcher in ~/.local/bin. The launcher runs whatever install
# ~/.cate/runtime/current names, so a `runtime.update` carries it along.
# Then `cate serve [path] [--connect]` serves a workspace to paired devices.
#
# CATE_VERSION=2.0.4 picks a release (default: the latest). CATE_BIN_DIR picks
# where the `cate` launcher goes (default: ~/.local/bin).
#
# Names must match src/runtime/daemon/contract/install.ts (tarballName,
# releaseUrl, checksumUrl, installLayout, INSTALL_MARKER, BUILD_FILE,
# CURRENT_FILE).

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
runtime_dir="$HOME/.cate/runtime"
bin_dir="${CATE_BIN_DIR:-$HOME/.local/bin}"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else fail "sha256sum or shasum is required"
  fi
}

mkdir -p "$runtime_dir"
chmod 700 "$HOME/.cate"
tmp=$(mktemp -d "$runtime_dir/.install-$$-XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM
echo "Downloading $tarball"
curl -fL --progress-bar -o "$tmp/$tarball" "$url" || fail "download failed: $url"
curl -fsSL -o "$tmp/$tarball.sha256" "$url.sha256" || fail "download failed: $url.sha256"
[ "$(sha256 "$tmp/$tarball")" = "$(cut -d' ' -f1 "$tmp/$tarball.sha256")" ] \
  || fail "$tarball does not match its published checksum"
mkdir -p "$tmp/stage"
tar -xzf "$tmp/$tarball" -C "$tmp/stage" || fail "could not unpack $tarball"
[ -f "$tmp/stage/runtime.cjs" ] && [ -x "$tmp/stage/runtime/bin/node" ] && [ -f "$tmp/stage/BUILD" ] \
  || fail "$tarball is incomplete"
build=$(tr -d '[:space:]' <"$tmp/stage/BUILD")
case "$build" in
  "$version"+*) ;;
  *) fail "$tarball has an unexpected build id $build" ;;
esac
install_dir="$runtime_dir/$build"

if [ -f "$install_dir/.ok" ]; then
  echo "Cate runtime $build is already installed in $install_dir"
else
  printf '%s' "$build" >"$tmp/stage/.ok"
  rm -rf "$install_dir"
  mv "$tmp/stage" "$install_dir"
  echo "Installed the Cate runtime $build in $install_dir"
fi
printf '%s\n' "$build" >"$runtime_dir/current"

# A launcher, not a symlink: it follows ~/.cate/runtime/current, and the
# install's shim finds its Node relative to its own path.
mkdir -p "$bin_dir"
rm -f "$bin_dir/cate"
cat >"$bin_dir/cate" <<'LAUNCHER'
#!/bin/sh
dir="$HOME/.cate/runtime"
build=$(tr -d "[:space:]" 2>/dev/null <"$dir/current") || build=
[ -n "$build" ] && [ -x "$dir/$build/cate/bin/cate" ] || {
  echo "cate: no Cate runtime is installed; run the install script again" >&2
  exit 1
}
exec "$dir/$build/cate/bin/cate" "$@"
LAUNCHER
chmod 755 "$bin_dir/cate"
echo "Installed $bin_dir/cate"

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "Add $bin_dir to your PATH, for example: echo 'export PATH=\"$bin_dir:\$PATH\"' >> ~/.profile" ;;
esac
echo "Serve a workspace with: cate serve [path] [--connect]"
