## Summary

<!-- What does this change do, and why? Reference any relevant design-doc
     sections (doc/DESIGN.md) or issues. -->

## Checklist

- [ ] `cargo fmt --all -- --check`
- [ ] `cargo clippy -p oxinot-core -p oxinot-cli -p oxinot-capture --all-targets -- -D warnings`
- [ ] `cargo test -p oxinot-core -p oxinot-cli -p oxinot-capture`
- [ ] `cd apps/desktop && bun run build` (if the frontend was touched)
- [ ] Updated `doc/DESIGN.md` and `skills/oxinot/SKILL.md` if the CLI surface or data model changed
- [ ] Added or updated tests for new behavior

## Related issues

<!-- e.g. Closes #123 -->
