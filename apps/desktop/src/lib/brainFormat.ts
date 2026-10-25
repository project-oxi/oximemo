import type { BrainContradictionItem } from "./api";

/** Surface text of one statement endpoint: a plain string, `{surface}`, or
 *  "" when the brain omitted it. The shape crosses a brain version
 *  boundary, so it is defended here (mirrors the ContextDock recall guards). */
function endpointSurface(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "surface" in value) {
    const surface = value.surface;
    if (typeof surface === "string") return surface;
  }
  return "";
}

/** Best-effort one-line rendering of a contradicted statement as
 *  "subject · predicate · object"; "" when nothing usable remains. */
export function formatContradiction(item: BrainContradictionItem): string {
  const statement = item?.statement;
  if (!statement || typeof statement !== "object") return "";
  const subject = endpointSurface(statement.subject);
  const predicate = typeof statement.predicate === "string" ? statement.predicate : "";
  const object = endpointSurface(statement.object);
  return [subject, predicate, object].filter(Boolean).join(" · ");
}
