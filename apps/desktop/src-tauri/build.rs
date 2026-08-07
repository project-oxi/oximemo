// Tauri's build script validates that externalBin paths exist at compile time,
// so the `oximemo` CLI sidecar must be present even for `cargo check` /
// `tauri dev`. The release workflow stages the real binary; locally run
// `./stage-cli.sh` first. When absent (fresh clone, `cargo check`), drop a
// placeholder so the build doesn't fail — it is never executed or bundled in
// that case (only `tauri build` bundles, and that path always stages the real
// binary first).
fn main() {
    let target = std::env::var("TARGET")
        .unwrap_or_else(|_| format!("{}-apple-darwin", std::env::consts::ARCH));
    let rel = format!("binaries/oximemo-{target}");
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let path = std::path::Path::new(&manifest).join(&rel);

    if !path.exists() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(
            &path,
            b"#!/bin/sh\necho 'run apps/desktop/src-tauri/stage-cli.sh to build the real CLI' >&2\nexit 1\n",
        );
        println!(
            "cargo:warning=oximemo CLI sidecar missing — created placeholder at {}. \
             Run stage-cli.sh before `cargo tauri build` to bundle the real CLI.",
            path.display()
        );
    }
    println!("cargo:rerun-if-changed={}", path.display());

    tauri_build::build();
}
