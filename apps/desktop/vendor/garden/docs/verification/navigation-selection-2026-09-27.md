# Shared navigation selection — 2026-09-27

Settings tabs and document sidebar buttons now use the shared `g-navigation-item` class. The app-specific button rule excludes this class, so framework geometry owns both paths. Selection retains the existing appropriate aria-selected/aria-current semantics. Search fields and icon-only rail controls are unchanged.

Running-app checks confirmed all document links and settings tabs measure 32px high, with 5px/10px padding and a 9999px pill radius. Keyboard activation of Component guide updates aria-current. UI and playground builds and git diff whitespace checks passed. No document data behavior changed.
