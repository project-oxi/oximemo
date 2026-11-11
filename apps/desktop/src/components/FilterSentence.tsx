/**
 * 조건 문장 (FilterSentence, 2026-11-11) — 쿼리 뷰 결과 바로 위에 걸린 조건을
 * 「폴더가 책 · 상태가 완료 아님 · 태그에 #2026」처럼 한 문장으로 늘 보여 준다.
 *
 * 전에는 어떤 조건이 걸렸는지 필터 팝오버를 열어야 보여서, 결과와 조건을 견주며
 * 고칠 수 없었다. 여기서는 밑줄 친 값을 누르면 그 자리에서 그 조건 한 줄만 고친다.
 * - 한 줄 편집기는 FilterBuilder 의 RowEditor 를 그대로 쓴다 — 연산자 규칙이 둘로
 *   갈라지면 같은 필드에서 두 편집기가 다른 연산자를 내놓는다.
 * - 고친 조건은 그 조건이 온 범위(쿼리 전체 · 이 뷰)에 저장한다. 새 조건은 「이 뷰」에
 *   더한다(FilterBuilder 의 기본 범위와 같다).
 * - 문장으로 풀 수 없는 OR · NOT · 고급 식은 「고급 조건 N」으로 접고 FilterBuilder 를 연다.
 * - 읽기 전용(인라인 쿼리)은 문장만 보이고 누를 곳을 두지 않는다.
 * 문장 조각 만들기는 lib/filterSentence.ts (순수 · 시험 있음).
 */
import { Popover } from "@base-ui-components/react";
import { Plus } from "lucide-react";
import { Fragment, useState, type ReactElement } from "react";
import { useI18n, type Dict } from "../lib/i18n";
import type { FilterNode } from "../lib/filterTree";
import {
  appendCond, buildSentence, phraseClause, replaceAt,
  type CondNode, type Scope, type SentenceStrings, type TagStrings,
} from "../lib/filterSentence";
import { RowEditor, emptyCond, useFieldCatalog } from "./FilterBuilder";
import "./FilterSentence.css";

interface Props {
  baseNode: FilterNode | null;
  viewNode: FilterNode | null;
  readOnly: boolean;
  fieldLabel: (ident: string) => string;
  /** FilterBuilder 와 같은 저장 길 — 범위 하나의 트리를 통째로 넘긴다(null 은 지움). */
  onSave: (scope: Scope, node: FilterNode | null) => void;
  /** 「고급 조건 N」: 그 조건이 있는 범위로 FilterBuilder 를 연다. */
  onOpenAdvanced: (scope: Scope) => void;
}

export function sentenceStrings(t: Dict): SentenceStrings {
  return {
    eq: t.query_sentence_eq,
    ne: t.query_sentence_ne,
    gt: t.query_sentence_gt,
    gte: t.query_sentence_gte,
    lt: t.query_sentence_lt,
    lte: t.query_sentence_lte,
    contains: t.query_sentence_contains,
    startsWith: t.query_sentence_starts_with,
    endsWith: t.query_sentence_ends_with,
    empty: t.query_sentence_empty,
    notEmpty: t.query_sentence_not_empty,
    yes: t.query_sentence_yes,
    no: t.query_sentence_no,
  };
}

export function tagStrings(t: Dict): TagStrings & { yes: string; no: string } {
  return {
    "==": t.query_tag_eq,
    "!=": t.query_tag_ne,
    ">": t.query_tag_gt,
    ">=": t.query_tag_gte,
    "<": t.query_tag_lt,
    "<=": t.query_tag_lte,
    contains: t.query_tag_contains,
    startsWith: t.query_tag_starts_with,
    endsWith: t.query_tag_ends_with,
    empty: t.query_sentence_empty,
    notEmpty: t.query_sentence_not_empty,
    yes: t.query_sentence_yes,
    no: t.query_sentence_no,
  };
}

export function FilterSentence({ baseNode, viewNode, readOnly, fieldLabel, onSave, onOpenAdvanced }: Props) {
  const { t } = useI18n();
  const strings = sentenceStrings(t);
  const { clauses, advanced } = buildSentence(baseNode, viewNode);
  const rootOf = (scope: Scope) => (scope === "base" ? baseNode : viewNode);
  const scopeLabel = (scope: Scope) => (scope === "base" ? t.query_filter_base : t.query_filter_this_view);

  // 필터가 없고 고칠 수도 없으면 줄 자체를 그리지 않는다 — 빈 자리를 남길 까닭이 없다.
  if (readOnly && clauses.length === 0 && advanced.length === 0) return null;

  return (
    <div role="group" aria-label={t.query_sentence_label} className="filter-sentence px-4 pb-2">
      {clauses.map((c, i) => {
        const field = fieldLabel(c.node.ident);
        return (
          <Fragment key={`${c.scope}:${c.path.join(".")}`}>
            {i > 0 && <span className="filter-sentence-sep" aria-hidden>·</span>}
            <span className="filter-sentence-clause" title={scopeLabel(c.scope)}>
              {phraseClause(c.node, strings, field).map((p, j) =>
                p.kind === "text" ? (
                  <span key={j}>{p.text}</span>
                ) : readOnly ? (
                  <span key={j} className="filter-sentence-value">{p.text}</span>
                ) : (
                  <CondPopover
                    key={j}
                    initial={c.node}
                    trigger={
                      <button
                        type="button"
                        className="filter-sentence-value"
                        aria-label={`${t.query_sentence_edit.replace("{field}", field)} · ${scopeLabel(c.scope)}`}
                      >
                        {p.text}
                      </button>
                    }
                    onSave={(next) => onSave(c.scope, replaceAt(rootOf(c.scope), c.path, next))}
                    onRemove={() => onSave(c.scope, replaceAt(rootOf(c.scope), c.path, null))}
                  />
                ),
              )}
            </span>
          </Fragment>
        );
      })}
      {advanced.length > 0 && (
        <>
          {clauses.length > 0 && <span className="filter-sentence-sep" aria-hidden>·</span>}
          {readOnly ? (
            <span className="filter-sentence-action" data-kind="advanced">
              {t.query_sentence_advanced_n.replace("{n}", String(advanced.length))}
            </span>
          ) : (
            <button
              type="button"
              className="filter-sentence-action"
              data-kind="advanced"
              aria-haspopup="dialog"
              onClick={() => onOpenAdvanced(advanced[0].scope)}
            >
              {t.query_sentence_advanced_n.replace("{n}", String(advanced.length))}
            </button>
          )}
        </>
      )}
      {!readOnly && (
        <CondPopover
          initial={emptyCond() as CondNode}
          trigger={
            <button type="button" className="filter-sentence-action" aria-label={t.query_builder_add_condition}>
              <Plus size={10} aria-hidden /> {t.query_sentence_add}
            </button>
          }
          onSave={(next) => onSave("view", appendCond(viewNode, next))}
        />
      )}
    </div>
  );
}

/** 조건 한 줄 편집 팝오버. 열릴 때마다 초안을 새로 뜬다 — 닫았다 다시 열었을 때
 *  저장하지 않은 지난 초안이 남아 있으면 지금 걸린 조건과 다른 것을 보게 된다. */
function CondPopover({
  initial,
  trigger,
  onSave,
  onRemove,
}: {
  initial: CondNode;
  trigger: ReactElement<Record<string, unknown>>;
  onSave: (next: CondNode) => void;
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger render={trigger} />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={4} collisionPadding={12} className="z-[80]">
          <Popover.Popup
            data-table-portal
            className="viewport-popup w-[26rem] max-w-[calc(100vw-24px)] rounded-[var(--popover-radius)] border border-line bg-surface-raised p-2 shadow-lg animate-popover-in"
          >
            {open && (
              <CondForm
                initial={initial}
                onSave={(next) => {
                  onSave(next);
                  setOpen(false);
                }}
                onRemove={() => {
                  onRemove?.();
                  setOpen(false);
                }}
                onCancel={() => setOpen(false)}
              />
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function CondForm({
  initial,
  onSave,
  onRemove,
  onCancel,
}: {
  initial: CondNode;
  onSave: (next: CondNode) => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const catalog = useFieldCatalog();
  const [draft, setDraft] = useState<CondNode>(() => structuredClone(initial));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft);
      }}
      className="flex flex-col gap-2"
    >
      <RowEditor
        node={draft}
        onChange={(next) => {
          if (next.kind === "cond") setDraft(next);
        }}
        onRemove={onRemove}
        typesOf={catalog.typesOf}
        optionsOf={catalog.optionsOf}
      />
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-[var(--button-radius)] border border-line px-2 py-1 text-[11px] text-text-muted"
        >
          {t.capture_cancel}
        </button>
        <button
          type="submit"
          className="rounded-[var(--button-radius)] bg-interactive-primary px-2.5 py-1 text-[11px] font-medium text-interactive-primary-foreground"
        >
          {t.capture_save}
        </button>
      </div>
    </form>
  );
}
