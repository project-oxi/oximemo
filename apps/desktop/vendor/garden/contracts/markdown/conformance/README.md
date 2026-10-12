# Portable Document Contract conformance corpus

`corpus.json` is the machine-readable index. Paths are relative to this directory.

Each implementation should copy a file or set case into an isolated temporary vault and assert the listed result. Operation cases apply the described deterministic action and compare bytes or diagnostics. A test is incomplete if it only parses the body; it must validate the profile-specific transport, shared envelope, body semantics, and expected diagnostic. Set cases are evaluated together in one vault.

Corpus format `pdc-document-conformance/2`, revision 2, is a bootstrap, not an exhaustive test suite. It covers Reader classification and Writer/Mutator preservation laws for `pdc-markdown/1` and `pdc-html/1`, the `pdc-query/1` cases, and — mandatorily — legacy `pdc-document/1` readability: valid v1 Djot and HTML documents MUST classify as `legacy_valid` (readable legacy), and v1 diagnostic cases MUST keep their v1 results. Legacy documents are never auto-converted. Implementations must also test every normative requirement for their claimed role and body capability. Add a shared regression fixture whenever implementations disagree. A behavior-changing fixture update must accompany the normative specification change that justifies it.

Expectation values:

- `valid` — a canonical document that parses, validates, and safely presents.
- `legacy_valid` — a readable `pdc-document/1` legacy document, never auto-converted.
- `legacy_html` / `legacy_markdown` — visible legacy items without a PDC envelope.
- `valid_unexecuted` — a query whose unknown constructs are preserved and shown but not executed.
- diagnostic names (`invalid_transport`, `invalid_envelope`, `invalid_query`, `unsafe_content`, `duplicate_block_id`, `duplicate_document_id`, `document_too_large`, `document_too_complex`, `unsupported_document_version`, `unsupported_body_version`, `invalid_document_id`, `external_change_conflict`) — visible diagnostics.
- `byte-identical` — operation cases whose output must equal the input or expected file byte-for-byte.
