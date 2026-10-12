# Garden CLI

Install the local command once from the framework checkout:

```sh
bun run cli:install
garden --help
```

This links `~/.local/bin/garden` to this checkout. The installer refuses to
replace an unrelated command and reports if the directory is outside `PATH`.
Use `garden install --bin-dir <directory>` for another executable directory.
No package publication or global npm dependency is required.

## Everyday commands

```sh
garden new my-app                         # desktop, with dependencies
garden new my-worker --template service   # Bun service
cd my-app
garden dev --web                          # browser preview
garden dev                                # native desktop, or service process
garden doctor
garden build
garden test
```

`new` derives application metadata from the directory name. `--name` overrides
that name. The target must not exist. Use `--no-install` to scaffold without
running Bun, or `--offline` to install from its local cache. A failed dependency
installation retains the generated project; retry with `garden deps`.
Native desktop execution requires the pinned Rust toolchain and platform build
tools. Browser preview uses the same shared UI without launching a native window.

## Existing apps

From the existing app directory:

```sh
garden init --dry-run
garden init
garden deps
```

`garden migrate` is an alias for `init`. Use `--template desktop|service` when
project detection is ambiguous; use `--install` to install dependencies during
adoption. Initial adoption installs the framework snapshot, manifest, package
integration and generated agent routing. It preserves domain source and existing
configuration, retains previous agent instructions, and writes a migration report
with the remaining app-specific integration and doctor findings. It does not
rewrite a React tree, port native code, or convert user documents automatically.
The Garden plugin's skill completes that semantic migration against the actual
app, using the selected contracts and running-path verification.

Adoption can succeed while the report still lists native/configuration work.
Resolve that work before claiming the app conforms. Existing adopted projects
use `update`; rerunning `init` does not reset their managed hashes.

## Updates

```sh
garden update --dry-run
garden update --install
```

The installed command's framework checkout is the default source. Use
`--source <path>` or `GARDEN_SOURCE` for another local snapshot. `garden source
--json` reports the selected source and version. App commands resolve the
nearest parent `garden.json`, so they also work from source subdirectories.

Updates compare source contents as well as versions, including changed personal
development snapshots that still have the same version number. Unchanged
snapshots are a no-op. Downgrades and modified managed files are rejected.
The updater retains the previous snapshot for recovery and archives older
recovery copies when updating again. Operational failure restores the previous
framework and affected manifests. Review the migration notes, reinstall changed
dependencies and adapt application code when an API changes.

`sync` regenerates bindings and routing; it does not adopt a new version or reset
managed-file hashes. App changes belong outside `vendor/garden`. Framework changes
belong in the source checkout, followed by `garden update` in each consuming app.

## Command reference

| Command | Purpose |
| --- | --- |
| `new <path> [--template desktop\|service]` | Create an app; desktop is the default |
| `init [path]` / `migrate [path]` | Prepare existing-app adoption and its integration report |
| `update [path] [--source path]` | Apply a local snapshot, retaining recovery copies |
| `doctor [path]` | Check contracts, configuration, pins and snapshot integrity |
| `sync [path]` | Regenerate tokens, native/schema bindings and thin AGENTS.md |
| `dev [path] [--web]` | Run native desktop/service, or a browser preview |
| `build [path]` / `test [path]` | Run the app's package scripts |
| `deps [path] [--offline]` | Install app dependencies with Bun |
| `source [--json]` | Show active source and version |
| `install [--bin-dir path]` | Install the local executable |

`new`, `init` and `update` accept `--dry-run`. Source selection applies to those
operations and `source`. Legacy `new desktop <path>`, `new service <path>` and
`update <path> <source>` remain supported. Legacy creation skips dependency
installation unless `--install` is supplied, preserving automation compatibility.

## Codex Desktop and OMP plugin

`bun run plugin:build` produces a self-contained Garden plugin with its skill and
framework snapshot. The maintained source lives in `integrations/codex/garden`.
The skill uses the installed CLI when available and the bundled CLI otherwise.
Install the package through a personal Codex marketplace to use it across apps.
A new chat can invoke the Garden skill for new products, existing-app migration,
updates, and standards alignment.

The same package also supports OMP through its private `package.json` manifest
and shared `skills/garden/SKILL.md`. Once the built package is in a stable local
directory, link it with `omp plugin link /absolute/path/to/garden`. Check
`omp plugin list --json` and `omp read skill://garden` to confirm discovery.
No npm publication, duplicate skill, or extra model service is needed.

For the personal installation at `~/plugins/garden`, Codex uses
`garden@personal` and OMP uses `@garden/framework-plugin`. Start a new chat or
OMP session after installing. Ask either agent to use the Garden skill to create
an app or migrate the current project. The CLI remains directly usable from
either agent's terminal.

## Verification boundary

Doctor validates the selected personal framework profile and narrow exceptions,
applicable stack/adoption/native settings, dependency pins, generated output,
managed hashes, locale keys and required documents. It does not prove semantic
copy quality, visual conformity, native execution, or complete document-reader
capability. Exceptions name one overridable rule, a concrete reason and a real
local Markdown decision in `docs/decisions`. The standard's running-app and
review obligations still apply.
