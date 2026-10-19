# Testing

Status: normative

Every feature MUST have one happy path exercised against a running app or process. Before committing, execute the changed path and record the observed result. Prefer E2E coverage. Unit tests cover pure-logic boundaries: state transitions, precedence, and edge values. Do not add wiring assertions, mock echoes, tautologies, or source-string inspection tests. Generated outputs are checked by deterministic regeneration, not tests that search implementation text.
