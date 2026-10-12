# Desktop and playground verification

Observed on 2026-09-27 on macOS. Final executable sources are preserved in the independently generated `.verification/v0-desktop` project. Its vendored packages, contracts, CLI, and templates were compared byte-for-byte with the framework source after the final query safety change; no differences remained.

```sh
node cli/garden.mjs new desktop .verification/v0-desktop
cd .verification/v0-desktop
bun install
bun run test
bun run doctor
CARGO_TARGET_DIR=../../templates/desktop/src-tauri/target bunx tauri build --debug --bundles app
```

The generated project installed independently, passed 68 document/editor tests, passed doctor, and built both the Vite frontend and the Tauri debug executable/app bundle. The shared Cargo target directory only reuses compiled dependencies; application source and bundled frontend came from the generated project. The unsigned app bundle is `templates/desktop/src-tauri/target/debug/bundle/macos/Garden Desktop.app`.

The actual native app was launched and inspected through macOS accessibility and screenshots. Native close/minimize/fullscreen controls appeared in the accessibility tree. The outer corners were rounded by the system frame. Meta+P opened the command palette; Return opened the separate Settings webview at `index.html?view=settings`. Settings displayed its section tabs and theme control without the primary navigation sidebar. Minimizing Settings, then invoking Settings from the primary window, restored the existing window. Changing the theme updated the primary window through the native event bridge. Closing Settings returned to the primary window. Titlebar drag gestures were exercised; no automated screen-coordinate displacement assertion is claimed.

The browser playground separately exercised palette filtering, Return selection, Escape/close, settings keyboard navigation, and the actual CodeMirror editing path. Computed styles on the focused composer and editor showed `outline-style: none` and `box-shadow: none`; editor text used Garden foreground instead of Atomic's dark-theme fallback. Keyboard actions retain a neutral focus cue.

Final captures are under `renders/`: native primary light/dark PNGs at 2400×1600, playground light/dark PNGs at 1200×800, plus palette and settings captures. Each theme pair includes a PNG difference image and JSON changed-pixel report. These establish different theme output, not equality against an approved baseline. Native captures can include the macOS screen-capture status badge; it is system UI, not a Garden component. Reference-app document content was not copied into these artifacts.

The Vite build warns about bundle size (the playground includes the preserved component gallery and editor). The native bundle is for local verification and is not signed/notarized for distribution. Windows and Linux native packaging were not exercised.
