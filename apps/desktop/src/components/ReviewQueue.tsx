/**
 * Review queue (design 2026-08-23 §7.3): notes whose review property is
 * one of the schema's `due_values`, oldest-first by `order_by` (falling
 * back to core `updated` when the date property is missing). Two
 * actions per item by default — "설명 가능함" reasserts the same value
 * (backend `on="write"` rule stamps the review date) and "막힘"
 * transitions to `decay_to` (the max-merge rule preserves `peak_status`).
 *
 * When the schema declares `[review.promote]` (ideas → knowledge, spec
 * §2.3), the queue swaps to a promote/archive pair: `archive` is the
 * decay transition; `promote` is a folder move + kind stamp + initial
 * status — a clean cutover between presets with no backend primitive
 * beyond existing move_note + update_memo props diff.
 *
 * 2026.11.11 : 목록 → 「한 장 넘기기」(RecallCard). 대기열을 한꺼번에 펼치면
 * 제목과 함께 답이 다 보여 스스로 떠올려 보는 일이 일어나지 않았다. 한 번에 한 장,
 * 본문은 Space 로 펼치기 전까지 가린다. 판정은 1 · 2, 노트 열기는 E.
 *
 * 목차
 *   - 대기열 받기 (페이지 50개씩 · 끝에 가까우면 다음 페이지)
 *   - 판정 (act · promote) — 먼저 넘기고, 실패하면 장을 되돌리고 「다시 시도」를 띄운다
 *   - 단축키 (리뷰 화면에 포커스가 있을 때만 · 입력 중 · IME 조합 중엔 무시)
 *   - 그리기: 진행 칸 · 장 · 끝 · 빈 대기열 · 오류
 */
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Check, PenLine, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getMemo, moveNote, queryNotes, updateMemo } from "../lib/api";
import { isComposingKey } from "../lib/editorKeys";
import { useFolderNames } from "../lib/folders";
import { useI18n } from "../lib/i18n";
import { previewExcerpt, renderPreviewMarkdown } from "../lib/markdownPreview";
import { propValueLabel } from "../lib/propDisplay";
import { pendingIds, reviewProgress } from "../lib/reviewProgress";
import type { MemoSummary, PropValue, SchemaReviewDef } from "../lib/types";
import { useUI } from "../stores/ui";
import "./ReviewQueue.css";

function first(v: PropValue | undefined): string | undefined {
  if (!v) return undefined;
  if ("Str" in v) return v.Str;
  if ("List" in v) return v.List[0];
  return String((v as { Bool: boolean }).Bool);
}

/** 남은 장이 이만큼이면 다음 페이지를 미리 받는다 — 마지막 장에서 기다리지 않게. */
const PREFETCH_AT = 3;

/** 리뷰 단축키 판정. 글자 입력 칸 · 조합 중 · 수식 키가 있으면 null.
 *  `code` 를 먼저 본다 — 한글 자판에서는 E 가 「ㄷ」로 들어온다. */
type ReviewKey = "reveal" | "pass" | "fail" | "edit";
function reviewKeyOf(e: KeyboardEvent): ReviewKey | null {
  if (e.defaultPrevented || e.repeat || isComposingKey(e)) return null;
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const el = e.target as HTMLElement | null;
  if (el?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return null;
  if (e.code === "Space" || e.key === " ") return "reveal";
  if (e.code === "Digit1" || e.code === "Numpad1" || e.key === "1") return "pass";
  if (e.code === "Digit2" || e.code === "Numpad2" || e.key === "2") return "fail";
  if (e.code === "KeyE" || e.key === "e" || e.key === "E") return "edit";
  return null;
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="recall-kbd" aria-hidden>
      {children}
    </kbd>
  );
}

export function ReviewQueue({
  folder,
  review,
  preset,
}: {
  folder: string;
  review: SchemaReviewDef;
  /** Folder preset id — the review property's values are per-collection
   *  vocabulary (idea 미처리/보관, book 완독…). */
  preset?: string;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { displayName } = useFolderNames();
  const select = useUI((s) => s.select);
  const selectedId = useUI((s) => s.selectedId);
  const setReviewMode = useUI((s) => s.setReviewMode);
  const list = useInfiniteQuery({
    queryKey: ["review", folder, review.property],
    queryFn: ({ pageParam }) =>
      queryNotes({
        folder,
        props: [
          { key: review.property, op: "In", values: review.due_values },
        ],
        sort: review.order_by
          ? { PropAsc: review.order_by }
          : "UpdatedAsc",
        offset: pageParam as number,
        limit: 50,
      }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });

  // 오류는 삼키지 않고 위로 던진다 — 장을 되돌리고 「다시 시도」를 띄우는 judge 가 받는다.
  const act = async (id: string, value: string) => {
    await updateMemo(id, null, null, { sets: [[review.property, { Str: value }]], removes: [] });
    await qc.invalidateQueries({ queryKey: ["review"] });
    await qc.invalidateQueries({ queryKey: ["memos"] });
  };

  const promote = async (id: string) => {
    const p = review.promote;
    if (!p) return;
    // Folder move first; the stamp runs after so the destination's
    // schema sees the props at evaluation time (knowledge stamp_date
    await moveNote(id, p.into);
    await updateMemo(id, null, null, {

      sets: [
        ["kind", { Str: p.kind } as PropValue],
        ...(p.start_status
          ? ([["status", { Str: p.start_status } as PropValue]] as [string, PropValue][])
          : []),
      ],
      removes: ["source"],
    });
    await qc.invalidateQueries({ queryKey: ["review"] });
    await qc.invalidateQueries({ queryKey: ["memos"] });
    await qc.invalidateQueries({ queryKey: ["folder-schema"] });
    await qc.invalidateQueries({ queryKey: ["folderChildren"] });
  };

  // 이번 판에 판정한 id. 「설명 가능함」은 값이 그대로라 메모가 대기열 끝에 다시
  // 나온다 — 서버 순번이 아니라 이 집합으로 다음 장을 고른다 (lib/reviewProgress).
  const [doneIds, setDoneIds] = useState<ReadonlySet<string>>(() => new Set());
  const [revealed, setRevealed] = useState(false);
  const [failure, setFailure] = useState<{ message: string; retry: () => void } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDoneIds(new Set());
    setFailure(null);
  }, [folder, review.property]);

  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const total = list.data?.pages.at(-1)?.total ?? 0;
  const loadedIds = useMemo(() => items.map((n) => n.id), [items]);
  const pending = useMemo(() => pendingIds(loadedIds, doneIds), [loadedIds, doneIds]);
  const progress = reviewProgress(loadedIds, doneIds, total);
  const current: MemoSummary | undefined = items.find((n) => n.id === pending[0]);

  // 장이 바뀌면 다시 가린다 — 다음 장의 답이 펼쳐진 채로 나오면 떠올려 볼 틈이 없다.
  useEffect(() => setRevealed(false), [current?.id]);

  // 리뷰 화면에 들어오면 바로 키를 받도록 포커스를 가져온다.
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = list;
  useEffect(() => {
    if (pending.length <= PREFETCH_AT && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) {
      void fetchNextPage();
    }
  }, [pending.length, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  // act · promote 는 렌더마다 새로 만들어지므로 최신 것을 ref 로 읽는다 —
  // judge 를 안정시켜 두어야 아래 keydown 구독이 렌더마다 다시 걸리지 않는다.
  const opsRef = useRef({ act, promote });
  opsRef.current = { act, promote };

  const judge = useCallback(
    (n: MemoSummary, which: "pass" | "fail") => {
      const { act: doAct, promote: doPromote } = opsRef.current;
      const op =
        which === "fail"
          ? () => doAct(n.id, review.decay_to)
          : review.promote
            ? () => doPromote(n.id)
            : () => doAct(n.id, first(n.props?.[review.property]) ?? review.due_values[0]);
      const run = () => {
        setFailure(null);
        // 먼저 넘긴다 — 저장 왕복을 기다리면 하루 수십 장 넘기는 손이 멈춘다.
        setDoneIds((prev) => new Set(prev).add(n.id));
        rootRef.current?.focus({ preventScroll: true });
        op().catch((e: unknown) => {
          setDoneIds((prev) => {
            const next = new Set(prev);
            next.delete(n.id);
            return next;
          });
          setFailure({ message: String(e).split("\n")[0], retry: run });
        });
      };
      run();
    },
    [review],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || !current) return;
      // 리뷰 화면 안에 포커스가 있을 때만. 시트가 닫혀 포커스가 body 로 떨어진
      // 경우도 받는다 — E 로 연 시트를 닫고 돌아오면 그 자리가 body 다.
      const active = document.activeElement;
      const inside = active !== null && root.contains(active);
      if (!inside && !(active === document.body && selectedId === null)) return;
      const k = reviewKeyOf(e);
      if (!k) return;
      if (k === "reveal") {
        // 버튼에 포커스가 있으면 Space 는 그 버튼을 누르는 브라우저 기본 동작에 맡긴다.
        if ((e.target as HTMLElement | null)?.tagName === "BUTTON") return;
        e.preventDefault();
        setRevealed((r) => !r);
        return;
      }
      e.preventDefault();
      if (k === "edit") select(current.id);
      else judge(current, k);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, judge, select, selectedId]);

  const memo = useQuery({
    queryKey: ["memo", current?.id ?? null],
    queryFn: () => getMemo(current!.id),
    enabled: current !== undefined,
    refetchOnWindowFocus: false,
  });
  // 본문은 전체를 받아 보여 준다. 받는 중이거나 실패하면 목록의 미리보기로 대신한다.
  // HTML 노트는 본문이 마크업이라 미리보기(평문)를 쓴다.
  const bodyHtml = useMemo(() => {
    if (!current) return "";
    const full =
      memo.data && memo.data.id === current.id && memo.data.format === "markdown" ? memo.data.body : null;
    const src = full ?? current.preview;
    if (!src) return "";
    return renderPreviewMarkdown(previewExcerpt(src, current.title, current.path), full ? 6000 : 320, {
      thisId: current.id,
      resultsN: t.query_embed_results_n,
    });
  }, [current, memo.data, t.query_embed_results_n]);

  const progressLabel = t.review_progress_label
    .replace("{n}", String(progress.position))
    .replace("{m}", String(progress.total));
  const folderLabel = displayName(folder);
  const waitingForPage = !current && (list.isLoading || (hasNextPage && !isFetchNextPageError));
  const finished = !current && !waitingForPage && !list.isError && progress.done > 0;
  const empty = !current && !waitingForPage && !list.isError && progress.done === 0;
  const loadFailed = list.isError || isFetchNextPageError;

  const btn =
    "inline-flex items-center gap-1.5 rounded-[var(--button-radius)] px-3 py-1.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";
  const btnPrimary = `${btn} bg-interactive-primary text-interactive-primary-foreground hover:bg-interactive-primary/90`;
  const btnPlain = `${btn} border border-line bg-surface text-text-muted hover:bg-surface-muted hover:text-text`;

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-10 pt-4 outline-none"
    >
      <div className="flex w-full max-w-xl flex-col gap-3">
        {progress.total > 0 && (
          <div className="flex items-center gap-3">
            <div
              role="progressbar"
              aria-label={progressLabel}
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.done}
              className="min-w-0 flex-1"
            >
              {progress.cells ? (
                <div className="recall-cells">
                  {progress.cells.map((c, i) => (
                    <i key={i} data-state={c} />
                  ))}
                </div>
              ) : (
                <span className="recall-bar">
                  <span style={{ width: `${(progress.done / progress.total) * 100}%` }} />
                </span>
              )}
            </div>
            <span
              className="shrink-0 text-xs font-medium tabular-nums text-text-subtle"
              title={t.review_due_count.replace("{n}", String(progress.total - progress.done))}
            >
              {t.review_progress.replace("{n}", String(progress.position)).replace("{m}", String(progress.total))}
            </span>
          </div>
        )}

        {failure && (
          <div role="alert" className="flex items-center gap-2 text-xs text-text">
            <span className="font-medium">{t.review_action_error}</span>
            <span className="min-w-0 flex-1 truncate text-text-subtle" title={failure.message}>
              {failure.message}
            </span>
            <button type="button" onClick={failure.retry} className={btnPlain}>
              {t.retry}
            </button>
          </div>
        )}

        {loadFailed && (
          <div role="alert" className="flex items-center gap-2 text-xs text-text">
            <span className="font-medium">{t.review_load_error}</span>
            <span className="min-w-0 flex-1 truncate text-text-subtle">{String(list.error).split("\n")[0]}</span>
            <button
              type="button"
              onClick={() => void (isFetchNextPageError ? fetchNextPage() : list.refetch())}
              className={btnPlain}
            >
              {t.retry}
            </button>
          </div>
        )}

        {current && (
          <article
            key={current.id}
            aria-labelledby="recall-title"
            className="recall-card rounded-[var(--card-radius)] border border-line bg-surface px-6 py-5"
          >
            <div className="text-[11px] text-text-subtle">
              {folderLabel && <>{folderLabel} · </>}
              {propValueLabel(review.property, first(current.props?.[review.property]) ?? "", t, preset)}
            </div>
            <h2 id="recall-title" className="mt-1 break-words text-xl font-semibold leading-snug text-text">
              {current.title ?? current.path}
            </h2>

            {revealed ? (
              <div className="mt-4">
                {bodyHtml ? (
                  <div
                    className="md-preview max-h-[50vh] overflow-y-auto text-sm leading-relaxed text-text-muted"
                    dangerouslySetInnerHTML={{ __html: bodyHtml }}
                  />
                ) : (
                  <p className="text-sm text-text-subtle">{t.empty_memo}</p>
                )}
                <button
                  type="button"
                  aria-expanded
                  onClick={() => {
                    setRevealed(false);
                    rootRef.current?.focus({ preventScroll: true });
                  }}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-sm text-[11px] text-text-subtle hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                >
                  <Kbd>Space</Kbd> {t.review_conceal}
                </button>
              </div>
            ) : (
              <button
                type="button"
                aria-expanded={false}
                onClick={() => {
                  setRevealed(true);
                  rootRef.current?.focus({ preventScroll: true });
                }}
                className="recall-veil mt-4 flex h-24 w-full items-center justify-center gap-2 rounded-[var(--card-radius)] text-xs text-text-subtle transition-colors duration-150 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              >
                <Kbd>Space</Kbd> {t.review_reveal}
              </button>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-2">
              {review.promote ? (
                <>
                  <button
                    type="button"
                    onClick={() => judge(current, "pass")}
                    className={btnPrimary}
                    title={t.review_promote_to.replace("{folder}", review.promote.into)}
                    aria-keyshortcuts="1"
                  >
                    <Kbd>1</Kbd>
                    <ArrowUpRight size={12} aria-hidden />
                    {t.review_promote}
                  </button>
                  <button
                    type="button"
                    onClick={() => judge(current, "fail")}
                    className={btnPlain}
                    title={t.review_still_valid}
                    aria-keyshortcuts="2"
                  >
                    <Kbd>2</Kbd>
                    <X size={12} aria-hidden />
                    {t.review_archive}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => judge(current, "pass")}
                    className={btnPrimary}
                    title={t.review_still_valid}
                    aria-keyshortcuts="1"
                  >
                    <Kbd>1</Kbd>
                    <Check size={12} aria-hidden />
                    {t.review_pass}
                  </button>
                  <button
                    type="button"
                    onClick={() => judge(current, "fail")}
                    className={btnPlain}
                    aria-keyshortcuts="2"
                  >
                    <Kbd>2</Kbd>
                    <X size={12} aria-hidden />
                    {t.review_fail}
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => select(current.id)}
                className={`${btnPlain} ml-auto`}
                aria-keyshortcuts="E"
              >
                <Kbd>E</Kbd>
                <PenLine size={12} aria-hidden />
                {t.review_edit}
              </button>
            </div>
          </article>
        )}

        {finished && (
          <div className="recall-card mt-8 flex flex-col items-center gap-3 text-center">
            <p className="text-lg font-semibold text-text">
              {t.review_done_today.replace("{n}", String(progress.done))}
            </p>
            <button type="button" onClick={() => setReviewMode(false)} className={btnPlain}>
              {t.review_back_to_folder}
            </button>
          </div>
        )}

        {empty && (
          <div className="mt-24 flex items-center justify-center text-sm text-text-subtle">
            {t.review_empty}
          </div>
        )}
      </div>
    </div>
  );
}
