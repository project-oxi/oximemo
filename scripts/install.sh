#!/bin/sh
# oximemo installer (curl | sh).
#
#   curl -fsSL https://github.com/project-oxi/oximemo/releases/latest/download/install.sh | sh
#
# Installs the CLI binary. Add --app to also install/replace the desktop
# app in /Applications (download dmg → verify sha256 → mount → copy).
#
# Options (env or flags):
#   PREFIX=/custom/bin     CLI install directory   (default: /usr/local/bin)
#   APPS_DIR=/Applications desktop app destination (default: /Applications)
#   VERSION=v0.10.0        pin a release           (default: latest)
#
# macOS Apple Silicon only — that's the only target the release builds.
# No com.apple.quarantine is set on curl downloads, so Gatekeeper never
# prompts; for a signed/notarized build it wouldn't anyway.
set -euo pipefail

REPO="project-oxi/oximemo"
TARGET="aarch64-apple-darwin"
PREFIX="${PREFIX:-/usr/local/bin}"
APPS_DIR="${APPS_DIR:-/Applications}"
VERSION="${VERSION:-latest}"
WANT_APP=0

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      cat <<'USAGE'
install oximemo (CLI, and the desktop app with --app)

  curl -fsSL .../install.sh | sh                  # CLI -> /usr/local/bin
  curl -fsSL .../install.sh | sh -s -- --app      # + /Applications app

env/flags: PREFIX=<dir> APPS_DIR=<dir> VERSION=<vX.Y.Z> --app
USAGE
      exit 0 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --apps-dir) APPS_DIR="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --app) WANT_APP=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

say() { printf '\033[1;32m==>\033[0m %s\n' "$1"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "unsupported OS: $(uname -s) — releases target macOS only."
[ "$(uname -m)" = "arm64" ] || die "unsupported arch: $(uname -m) — releases target Apple Silicon (arm64) only."
command -v shasum >/dev/null 2>&1 || die "shasum not found (macOS ships it; is this a stock system?)"

# Resolve the tag up front: the dmg filename embeds the version, so
# "latest" must become vX.Y.Z before any asset URL is built. The
# releases/latest page redirects to /tag/<tag>.
if [ "$VERSION" = "latest" ]; then
  TAG="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" \
    | sed 's|.*/tag/||')"
  [ -n "$TAG" ] || die "could not resolve the latest release tag."
else
  TAG="$VERSION"
fi
BASE="https://github.com/$REPO/releases/download/$TAG"
VER_NUM="${TAG#v}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch_verified() {
  # fetch_verified <asset-name> — downloads <name> + <name>.sha256 and
  # verifies the digest before returning.
  name="$1"
  say "downloading $name"
  curl -fsSL --retry 3 -o "$TMP/$name" "$BASE/$name" || die "download failed — is $TAG a real release?"
  curl -fsSL --retry 3 -o "$TMP/$name.sha256" "$BASE/$name.sha256" || die "checksum download failed"
  expected="$(awk '{print $1}' "$TMP/$name.sha256")"
  actual="$(shasum -a 256 "$TMP/$name" | awk '{print $1}')"
  [ "$expected" = "$actual" ] || die "checksum mismatch for $name — expected $expected, got $actual"
}

TARBALL="oximemo-$TARGET.tar.gz"
fetch_verified "$TARBALL"

say "installing CLI to $PREFIX"
mkdir -p "$PREFIX"
tar -xzf "$TMP/$TARBALL" -C "$TMP"
if [ -w "$PREFIX" ]; then
  install -m 0755 "$TMP/oximemo" "$PREFIX/oximemo"
else
  command -v sudo >/dev/null 2>&1 || die "$PREFIX is not writable and sudo is unavailable — rerun with PREFIX=~/.local/bin"
  sudo install -m 0755 "$TMP/oximemo" "$PREFIX/oximemo"
fi

installed="$("$PREFIX/oximemo" --version 2>/dev/null || true)"
say "CLI done: $PREFIX/oximemo ${installed:+($installed)}"

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo "note: $PREFIX is not on your PATH — add it to use 'oximemo' directly." ;;
esac

if [ "$WANT_APP" -eq 1 ]; then
  APP_NAME="OxiMemo.app"
  DMG="OxiMemo_${VER_NUM}_aarch64.dmg"

  if pgrep -f "$APP_NAME/Contents/MacOS" >/dev/null 2>&1; then
    die "OxiMemo is running — quit it first (or use its in-app updater)."
  fi

  fetch_verified "$DMG"

  say "mounting $DMG"
  # hdiutil can transiently fail right after a previous detach settles;
  # retry once before giving up. stderr stays in mount.txt for the error.
  mounted=0
  for attempt in 1 2; do
    if hdiutil attach -nobrowse -readonly "$TMP/$DMG" > "$TMP/mount.txt" 2>&1; then
      mounted=1
      break
    fi
    [ "$attempt" = 1 ] && sleep 2
  done
  [ "$mounted" = 1 ] || { cat "$TMP/mount.txt" >&2; die "could not mount the dmg."; }
  # hdiutil prints tab-separated columns ending in the mount point;
  # volume names may contain spaces ("OxiMemo 2" when one is already
  # mounted), so split on tabs, not whitespace.
  MOUNT="$(awk -F'\t' '/\/Volumes\// {print $NF}' "$TMP/mount.txt" | tail -1)"
  [ -n "$MOUNT" ] && [ -d "$MOUNT/$APP_NAME" ] || {
    hdiutil detach "$MOUNT" >/dev/null 2>&1 || true
    die "app bundle not found inside the dmg."
  }

  had_old=0
  if [ -d "$APPS_DIR/$APP_NAME" ]; then
    say "replacing existing $APPS_DIR/$APP_NAME"
    mv "$APPS_DIR/$APP_NAME" "$TMP/old.app"
    had_old=1
  fi
  if [ -w "$APPS_DIR" ]; then
    cp -R "$MOUNT/$APP_NAME" "$APPS_DIR/" || { [ "$had_old" = 1 ] && mv "$TMP/old.app" "$APPS_DIR/$APP_NAME"; die "copy failed."; }
  else
    command -v sudo >/dev/null 2>&1 || { [ "$had_old" = 1 ] && mv "$TMP/old.app" "$APPS_DIR/$APP_NAME"; die "$APPS_DIR is not writable and sudo is unavailable."; }
    sudo cp -R "$MOUNT/$APP_NAME" "$APPS_DIR/" || { [ "$had_old" = 1 ] && mv "$TMP/old.app" "$APPS_DIR/$APP_NAME"; die "copy failed."; }
  fi
  hdiutil detach -quiet "$MOUNT" >/dev/null 2>&1 || true

  app_ver="$(defaults read "$APPS_DIR/$APP_NAME/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo '?')"
  say "app done: $APPS_DIR/$APP_NAME ($app_ver)"
fi

echo
echo "Installed from $TAG. Desktop app alone (dmg, drag-install):"
echo "  $BASE/OxiMemo_${VER_NUM}_aarch64.dmg"
