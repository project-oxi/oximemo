/**
 * External-change detection for pending saves (PDC 10.3): before
 * replacing a file, a Writer MUST compare the current bytes with the
 * snapshot its edit began from.
 */

export type ExternalChangeConflict = { diagnostic: "external_change_conflict" };

export function saveGuarded(
  snapshot: Uint8Array,
  current: Uint8Array,
  next: Uint8Array,
): Uint8Array {
  const identical =
    snapshot.length === current.length && snapshot.every((byte, i) => byte === current[i]);
  if (!identical) {
    throw { diagnostic: "external_change_conflict" } satisfies ExternalChangeConflict;
  }
  return next;
}
