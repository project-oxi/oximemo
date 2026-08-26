#!/bin/sh
# oximemo CLI installer (curl | sh).
#
#   curl -fsSL https://github.com/project-oxi/oximemo/releases/latest/download/install.sh | sh
#
# Options (env or flags):
#   PREFIX=/custom/bin     install directory      (default: /usr/local/bin)
#   VERSION=v0.10.0        pin a release          (default: latest)
#
# macOS Apple Silicon only — that's the only target the release builds.
# The desktop app (.dmg) is a drag-install, not scriptable: its URL is
# printed at the end.
set -euo pipefail

REPO="project-oxi/oximemo"
TARGET="aarch64-apple-darwin"
PREFIX="${PREFIX:-/usr/local/bin}"
VERSION="${VERSION:-latest}"

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

say() { printf '\033[1;32m==>\033[0m %s\n' "$1"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "unsupported OS: $(uname -s) — releases target macOS only."
[ "$(uname -m)" = "arm64" ] || die "unsupported arch: $(uname -m) — releases target Apple Silicon (arm64) only."
command -v shasum >/dev/null 2>&1 || die "shasum not found (macOS ships it; is this a stock system?)"

if [ "$VERSION" = "latest" ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/$VERSION"
fi

TARBALL="oximemo-$TARGET.tar.gz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "downloading $TARBALL ($VERSION)"
curl -fsSL --retry 3 -o "$TMP/$TARBALL" "$BASE/$TARBALL" || die "download failed — does release $VERSION exist?"
curl -fsSL --retry 3 -o "$TMP/$TARBALL.sha256" "$BASE/$TARBALL.sha256" || die "checksum download failed"

say "verifying sha256"
expected="$(awk '{print $1}' "$TMP/$TARBALL.sha256")"
actual="$(shasum -a 256 "$TMP/$TARBALL" | awk '{print $1}')"
[ "$expected" = "$actual" ] || die "checksum mismatch — expected $expected, got $actual"

say "installing to $PREFIX"
mkdir -p "$PREFIX"
tar -xzf "$TMP/$TARBALL" -C "$TMP"
if [ -w "$PREFIX" ]; then
  install -m 0755 "$TMP/oximemo" "$PREFIX/oximemo"
else
  command -v sudo >/dev/null 2>&1 || die "$PREFIX is not writable and sudo is unavailable — rerun with PREFIX=~/.local/bin"
  sudo install -m 0755 "$TMP/oximemo" "$PREFIX/oximemo"
fi

installed="$("$PREFIX/oximemo" --version 2>/dev/null || true)"
say "done: $PREFIX/oximemo ${installed:+($installed)}"

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo "note: $PREFIX is not on your PATH — add it to use 'oximemo' directly." ;;
esac
echo
echo "Desktop app (.dmg, drag-install):"
if [ "$VERSION" = "latest" ]; then
  echo "  https://github.com/$REPO/releases/latest"
else
  echo "  $BASE/OxiMemo_${VERSION#v}_aarch64.dmg"
fi
