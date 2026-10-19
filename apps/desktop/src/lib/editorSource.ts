/** Keep the editor's save token attached to the source its draft came from. */
export function reconcileEditorSource<T extends { id: string }>(
  current: T | null,
  incoming: T | undefined,
  selectedId: string | null,
  dirty: boolean,
  saving: boolean,
): T | null {
  if (selectedId === null) return null;
  if (!incoming || incoming.id !== selectedId) return current;
  if (current?.id !== selectedId) return incoming;
  return dirty || saving ? current : incoming;
}
