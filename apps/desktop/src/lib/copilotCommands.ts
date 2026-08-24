/**
 * Slash-command catalog for the copilot composer (revision 2026-08-24).
 *
 * Commands are localized PROMPT TEMPLATES, nothing more: selecting one
 * replaces the draft so the user can review/edit before the turn starts
 * (turns are slow subprocesses — never fire a template unreviewed). The
 * "propose first, execute only the certain ones" phrasing mirrors spec §11:
 * vault writes follow the chosen agent's approval policy.
 */
import type { Dict } from "./i18n";

export type CopilotCommandId = "summary" | "tags" | "tidy" | "find" | "new";

export interface CopilotCommandMeta {
  id: CopilotCommandId;
  label: string;
  desc: string;
}

export function commandList(t: Dict): CopilotCommandMeta[] {
  return [
    { id: "summary", label: t.copilot_cmd_summary_label, desc: t.copilot_cmd_summary_desc },
    { id: "tags", label: t.copilot_cmd_tags_label, desc: t.copilot_cmd_tags_desc },
    { id: "tidy", label: t.copilot_cmd_tidy_label, desc: t.copilot_cmd_tidy_desc },
    { id: "find", label: t.copilot_cmd_find_label, desc: t.copilot_cmd_find_desc },
    { id: "new", label: t.copilot_cmd_new_label, desc: t.copilot_cmd_new_desc },
  ];
}

/** Prompt template for a command. `/find` and `/new` end with ": " — the
 * cursor lands there and the user completes the sentence. */
export function expandCommand(
  id: CopilotCommandId,
  ctx: { hasActiveMemo: boolean; t: Dict },
): string {
  const { t } = ctx;
  switch (id) {
    case "summary":
      return ctx.hasActiveMemo ? t.copilot_cmd_summary_active : t.copilot_cmd_summary_none;
    case "tags":
      return ctx.hasActiveMemo ? t.copilot_cmd_tags_active : t.copilot_cmd_tags_none;
    case "tidy":
      return t.copilot_cmd_tidy_template;
    case "find":
      return t.copilot_cmd_find_template;
    case "new":
      return t.copilot_cmd_new_template;
  }
}

/** Case-insensitive substring filter over label+desc; empty query = all. */
export function filterCommands(
  query: string,
  list: CopilotCommandMeta[],
): CopilotCommandMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (c) => c.label.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q),
  );
}
