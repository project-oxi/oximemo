# Editor browser verification

Observed on 2026-09-27 in the running Vite playground through the in-app browser.

The primary playground mounted the real `@garden/editor` CodeMirror view. Typing `sample ` changed the controlled source; removing only that inserted text from the observed source yielded the exact original document, including frontmatter and unsupported wiki-link syntax. Reload restored the fixture.

The separate verification fixture at `/tests/editor.html` starts with `# CRLF document\r\n\r\nKeep **source** unchanged.\r\n`. Clicking its real editor, pressing Meta+A, and typing `Replacement` yielded exactly `"Replacement"` in the controlled source output. Meta+Z restored the original string with all three CRLF separators intact and the fixture's exact-equality status returned true. This exercises React, CodeMirror history, and the adapter's controlled-value callback together.

This regression caught and fixed an editor remount when deletion removed the last newline. The source separator now stays stable for the current document identity. Atomic's theme variables are mapped to Garden colors so light-mode Markdown does not inherit Atomic's dark default foreground. Field focus uses the caret and a neutral surface change rather than a blue perimeter ring.
