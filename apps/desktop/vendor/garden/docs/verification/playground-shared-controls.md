# Playground shared controls

Verified on 2026-09-27 against the running Vite playground.

The component catalog now consumes Input, Label, Button, Badge, and EmptyState from @garden/ui. Query controls consume SelectField, Checkbox, Label, and Textarea. Removed app-level field and category-button recipes so the shared controls own appearance and focus.

Validation:
- Playground TypeScript check and production build passed.
- Catalog search with no matches displayed EmptyState and Reset filters.
- Reset filters restored all 45 demos; selecting UI primitives selected the 16-demo category.
- Disabling query evaluation displayed the disabled state; enabling restored results.
- Selecting List view displayed the two framework notes.
- Editing query source updated the rendered view heading to Verification.
- Restoring All documents displayed the shared controls and results in the dark theme.

Screenshot: [Query controls](renders/playground-shared-controls.jpg).

Vite reports the existing large JavaScript chunk warning.
