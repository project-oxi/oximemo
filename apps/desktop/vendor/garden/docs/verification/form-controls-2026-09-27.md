# Form control refinement — 2026-09-27

Shared control styles now cover native select/checkbox adapters, Radix Select/Checkbox/Switch, and radio indicators. Settings use the exported SelectField API; document type and query controls use the shared native adapters. No document serialization behavior changed.

Running-app checks: language popup opens with Enter and closes with Escape; theme selection applies light mode and restores focus to the trigger; the settings switch toggles with Space; the document bookmark toggles with Space. The catalog shows checked, unchecked, uncontrolled indeterminate, and disabled checkboxes. Space changes indeterminate to checked, and radio controls retain the existing Radix keyboard behavior; an ArrowDown change was not confirmed through this adapter. Dark popup and light checkbox/radio screenshots were inspected. Evidence: [light controls](renders/controls-light.png).

UI, editor, and playground builds pass. Token bindings are current, garden doctor is healthy, and git diff whitespace checks pass. Vite's existing large-chunk advisory remains. Verification used semantic keyboard actions because pointer targeting through the browser adapter was unreliable. Native select popups retain OS rendering; this change does not add searchable multi-select behavior.

## Switch translation correction

The previous visual pass missed a regression: Tailwind's individual `translate: 16px` combined with the added `transform: translateX(14px)`, placing the checked thumb outside its track. Removed the obsolete utility geometry so shared CSS exclusively owns size and movement. Live browser measurements now show a 36×22px track, 18×18px thumb, 2px top/bottom inset, 2px left inset when off, and 2px right inset when on. Both light and dark states were exercised with Space. UI and playground builds passed. Evidence: [corrected light switch](renders/switch-fixed-light.png).

## Select popup correction

Removed redundant Tailwind directional translation from popup content; Popper's sideOffset exclusively owns its gap. Settings SelectField popups now align to the trigger's right edge, with viewport collision padding. The global action focus selector excludes select items so the active row uses a filled background rather than a clipped perimeter outline. Items measure 32px high. Live expanded-menu measurements: gap 5.95px (6px target), right-edge difference 0px, individual translate none, and item outline none. The expanded light popup was visually inspected. UI and playground builds and whitespace checks passed. A subsequent keyboard navigation check was interrupted by the page changing to Documents, so that check was not claimed as passed.
