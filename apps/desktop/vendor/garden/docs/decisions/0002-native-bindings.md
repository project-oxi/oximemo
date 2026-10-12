# ADR 0002: native bindings and release pins

Status: accepted

React and React DOM use exact versions. Rust uses rust-toolchain.toml; native crates use exact Tauri pins and Cargo.lock. Bun is the service runtime.

The v0 native command surface is deliberately small. JSON contracts drive a local deterministic TypeScript binding generator. The Rust supervisor separately validates protocol, request identity, response status, and frame bounds at runtime. This is the regression fallback for a future Specta adoption. Specta is not required merely to bridge two commands: when introduced, pin its release candidate exactly, preserve generated output fixtures, and compare both generators before switching. No unpinned release candidate may become the sole recovery path.

Tauri crate, build helper, JavaScript API, and CLI have independent release numbers; pin each verified available release rather than assuming their numbers match.

Verification on 2026-09-27: direct inspection of the official [2.12.0 release](https://github.com/tauri-apps/tauri/releases/tag/tauri-v2.12.0) confirms the requested Tauri 2.12 line. Search summaries and the local 2.11.6 cache were stale; the release page takes precedence. Pin Rust tauri to 2.12.0. Registry resolution confirmed npm API and CLI 2.12.0. Cargo resolved tauri-build 2.7.0 as the required build helper; it is pinned independently.
