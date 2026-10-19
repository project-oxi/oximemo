# Architecture

Status: normative

The personal framework standard (contracts/framework) is authoritative for stack and composition; adopted contracts define their detailed semantics. Dependency direction is app → framework packages → contracts. React, TypeScript, Vite and Garden's shadcn/Radix control layer are the UI standard. GAppShell supplies the application frame and controls. UI MUST NOT import daemon implementation or native APIs; host adapters own native integration. Rust/Tauri 2 owns desktop hosting and supervision; Bun services implement the daemon protocol. Markdown syntax, document editing, properties and queries use their shared public APIs. Pure decisions are separated from IO. Generated files carry DO NOT EDIT and are regenerated from contracts. Preserve the three token vocabularies and the blue --accent meaning. Record allowed deviations by rule ID in garden.json and a local ADR.
