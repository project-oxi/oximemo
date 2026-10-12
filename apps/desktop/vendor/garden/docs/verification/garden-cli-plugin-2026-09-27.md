# Garden CLI and agent plugin verification

Date: 2026-09-27

## CLI and framework

- Installed `~/.local/bin/garden` as a link to this checkout's executable. From
  outside the checkout, `garden --version` reported `0.1.0` and `garden source
  --json` resolved this framework.
- Created a service in `/private/tmp/garden-cli-live-service-20260927` with
  `garden new <path> --template service --offline`. Default dependency installation,
  `garden build`, `garden doctor`, and `garden test` succeeded. Service execution
  tests exercised real process/socket/database paths: 10 tests, 46 assertions.
- Created a desktop app in `/private/tmp/garden-cli-live-desktop-20260927` with
  `garden new <path> --offline --name 'Garden 작업실'`. Dependency installation,
  TypeScript/Vite build and doctor succeeded. Native Rust compilation and a native
  window launch were not repeated in this CLI task.
- Updated the earlier service fixture with the installed command, including
  dry-run, same-version changed contents, and a second unchanged update. Doctor
  passed and the last update was a no-op. The previous snapshot was retained.
- Full package run: `bun test cli/tests packages/markdown/tests
  packages/editor/tests packages/daemon-kit/tests packages/ui/tests` passed
  201 tests with 988 assertions. A subsequent locked-legacy-builder compatibility
  fix was validated by the complete CLI suite: 26 tests, 207 assertions. The real
  fixture update above then passed with that final fix.
- Root doctor and `git diff --check` passed.

## Shared plugin installation

- Built `/private/tmp/garden-plugin-final-20260927/garden` with the skill, private
  OMP package manifest, Codex manifest and bundled framework. Both host manifests
  take their version from the bundled framework pin.
- Official `plugin-creator` and `skill-creator` validators passed using locally
  cached PyYAML through `uv run --offline --with pyyaml`.
- Installed the package at `/Users/garden/plugins/garden` through the personal
  marketplace scaffold and `codex plugin add garden@personal --json`.
  `codex plugin list --marketplace personal --json` reported installed and enabled,
  version `0.1.0`. Its cache is
  `/Users/garden/.codex/plugins/cache/personal/garden/0.1.0`.
- Linked that same package with `omp plugin link /Users/garden/plugins/garden`.
  OMP 18.3.4 lists `@garden/framework-plugin` as enabled, and
  `omp read skill://garden` returned the installed skill successfully.
- The source, shared installed package and Codex cached skill have identical
  SHA-256 hashes. The Codex cache's bundled CLI independently resolved its own
  framework with `source --json`.
- An independent agent followed the skill's bundled-CLI fallback from a separate
  build in `/private/tmp/garden-forward-run.6Vg1er/garden-inbox`. Offline dependency
  installation, sync, doctor, build and 10 service tests (46 assertions) passed.
  The generated package name was `garden-inbox`; the service's runtime example
  remains `garden-service` until application-specific implementation.

Codex Desktop picks up the plugin in a new chat; OMP should start a new session.
Installation and skill discovery are verified. An LLM-driven product migration
inside a fresh interactive session is not claimed by these checks. The CLI's
adoption command prepares infrastructure and reports the remaining work; the
skill must complete the actual application integration.
