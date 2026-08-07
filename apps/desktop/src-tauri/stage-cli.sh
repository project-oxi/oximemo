#!/usr/bin/env bash
# Stage the `oximemo` CLI binary as a Tauri externalBin sidecar so the desktop
# app bundle ships a signed, runnable `oximemo` command. Settings →
# "Install command" symlinks it onto PATH at runtime.
#
# Run once before a LOCAL `cargo tauri build`. The release workflow stages the
# sidecar itself; `cargo tauri dev` does not need the real binary (build.rs
# drops a placeholder), but this replaces it for a genuine bundle.
set -euo pipefail
cd "$(dirname "$0")"            # apps/desktop/src-tauri/

TRIPLE=$(rustc -vV | sed -n 's/^host: //p')
ROOT="$(cd "../../../" && pwd)" # workspace root (holds the shared target/)

cargo build --release -p oximemo-cli
mkdir -p binaries
cp "$ROOT/target/release/oximemo" "binaries/oximemo-${TRIPLE}"
chmod +x "binaries/oximemo-${TRIPLE}"
echo "staged binaries/oximemo-${TRIPLE}"
