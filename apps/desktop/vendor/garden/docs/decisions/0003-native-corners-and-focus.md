# ADR 0003: native window curvature and quiet focus

Status: accepted, 2026-09-27

The owner requested macOS-standard window corners and removal of blue field-focus borders during v0 verification. This supersedes the original `decorations: false` setting on macOS only. Primary and Settings windows retain an AppKit-managed frame using Tauri's decorated `Overlay` titlebar with hidden title. AppKit owns the outer corner mask, shadow, native traffic lights, resizing, and fullscreen geometry. Garden does not publish a guessed pixel radius for macOS windows or fake the outer mask with a CSS rounded rectangle. Other desktop platforms retain the undecorated template fallback.

The titlebar remains a 46-point React surface with draggable empty regions and an 80-point leading control inset. Native traffic lights use a configured logical position inside that reserved area. Internal cards and overlays continue to use the existing token radius scale; supported engines may enhance curvature without changing fallback geometry.

Text editors and fields use a visible caret plus a neutral focused surface, without a blue outline or glow. Keyboard-operated buttons and navigation retain a visible monochrome focus cue. The immutable token source and its blue `--accent` meaning remain intact for links and selection; this decision changes component behavior, not color-token identity.

Apple's [Windows guidance](https://developer.apple.com/design/human-interface-guidelines/windows) delegates native window behavior to system elements. Its [Focus and selection guidance](https://developer.apple.com/design/human-interface-guidelines/focus-and-selection) still requires understandable focus states. [WCAG Focus Visible](https://www.w3.org/WAI/WCAG21/Understanding/focus-visible) requires visible keyboard focus, but does not mandate a blue border. These sources do not establish that modern software universally avoids focus borders; the quiet monochrome treatment is Garden's deliberate preference.
