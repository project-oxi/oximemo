# Verification evidence

This directory records observed runs, not normative rules. Regenerate the evidence when changing the corresponding path. A screenshot establishes visible layout only; keyboard interaction, process protocol, durability boundaries, and template independence require separate executable checks.

Commands for the framework:

```sh
bun install --frozen-lockfile
bun run sync
bun run build
bun run test
bun run doctor
```

Template validation creates fresh projects through the CLI, installs them independently, builds the React app and Tauri executable, and starts the Bun service as a separate process. Deliberate doctor violations are restored after verification. Native daemon probing uses the desktop executable's `--daemon-probe` mode with an app-owned `GARDEN_DAEMON_SOCKET` endpoint.

Light/dark capture comparison uses scripts/verification/compare-renders.py. The pixel difference demonstrates theme changes; it is not a claim that two different themes should be identical. Screenshots are reviewed for clipping, contrast, titlebar insets, and modal placement.
