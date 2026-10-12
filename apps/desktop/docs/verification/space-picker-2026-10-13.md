# Space picker UI verification — 2026-10-13

The installed 0.19.0 app clipped a long space name at the sidebar edge. Escape and outside clicks left the popup open. In the browser, the create-space command did not reveal a collapsed sidebar.

The repair uses the established Base UI Popover portal and collision handling, with a scrollable list and a fixed creation footer. Sidebar animation sizing accounts for the profile control's margins. Long names retain their accessible text and title while truncating visually. The current space receives initial focus. Garden Input and Button supply the creation controls. Closing the picker or sidebar clears the creation request; commands reveal the sidebar. Input validation counts Unicode scalars and Enter ignores active IME composition.

## Executed checks

- Browser: 320×360, 480×360, 768×600, 1100×720 and 1440×900. Picker/input/action bounds stayed in the viewport, with no horizontal page overflow.
- Browser: Tab/Enter into the creation form; Escape and outside click dismissal; focus return; collapsed-sidebar create command; mock creation completion and form reset.
- Browser: compact Settings → Space inputs and the existing recents and breadcrumb popups.
- Native: 480×360 and 768×600, using an isolated Oxi home with 25 spaces and a long current name. List scrolling, creation footer visibility, input focus and Escape return passed. The final 768 build focused/scrolled to the current space on open.
- Native: hide an open picker and return focus to the sidebar toggle; Cmd+K → Down/Enter → create-space while the sidebar is collapsed.
- Native: Korean/system-dark and English/light picker and creation-form layouts.
- Frontend: 664 tests passed, 3 skipped; production typecheck/build passed. Garden sync and doctor passed.
- Unsigned arm64 production Release app and bundled CLI built at version 0.19.1.

The native pass did not switch to another space or create files in the user vault. Backend restart/storage code was unchanged. Browser creation uses the existing no-vault development mock. OS IME confirmation was guarded in the input handler; a complete OS input-method session was not automated.

Before/after captures and measured browser bounds are retained in the task's local verification artifacts.
