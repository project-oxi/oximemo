# Agents

Status: normative

AGENTS.md MUST be generated and thin. If garden.json exists, first read contracts/framework/README.md and contract.json, including the declared profile and any local exceptions, then the adopted contracts and this playbook. Task routes: UI → ui-spec and behavior; document data → markdown; daemon → daemon-protocol; all code → testing, architecture, language, i18n; releases → git and docs. Adopted projects resolve these paths within vendor/garden. Adopters vendor their contracts, playbook, packages, and generators so personal apps remain self-contained. Local instructions append in AGENTS.local.md, never overwrite generated policy. Deviations use the manifest's rule-specific exception and local ADR mechanism; do not silently replace framework defaults.
