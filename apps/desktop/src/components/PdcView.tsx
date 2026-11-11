/**
 * PDC document-plane inventory and guarded source editor. Lists visible
 * `.md`/`.html`/`.djot`/`.base` files with classification, diagnostics,
 * duplicate IDs, and broken link/asset findings. Only canonical PDC 2
 * Markdown and HTML documents can be edited; all source remains inert text.
 * Refreshes on `memos:changed` / `bases:changed`.
 */
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { FileCode2, FileText, TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";

import { invoke, listen } from "../lib/tauri";
import { useI18n } from "../lib/i18n";
import { summarizePdcIssues } from "../lib/pdcInventory";
import type { PdcDuplicateId, PdcInventory, PdcInventoryEntry, PdcSourceFile, PdcWriteReceipt } from "../lib/pdcInventory";
import { SessionRecorderPanel } from "./SessionRecorderPanel";
import { TextCtxMenu } from "./TextCtxMenu";
import { ListSkeleton } from "./Skeletons";
import { useUI } from "../stores/ui";
import "./PdcView.css";

function fmt(n: number, template: string): string {
  return template.replace("{n}", String(n));
}

/** Identity the source viewer needs, snapshotted when a document opens.
 *  Carried outside the inventory list so a rescan that drops or
 *  reclassifies the entry can never unmount the editor mid-edit. */
type OpenSource = { path: string; class: string };

function EntryIcon({ path }: { path: string }) {
  if (path.endsWith(".base")) return <DatabaseHint />;
  if (path.endsWith(".html")) return <FileCode2 size={16} aria-hidden />;
  return <FileText size={16} aria-hidden />;
}

function DatabaseHint() {
  return <span className="font-mono text-[11px] font-bold text-hue-violet">Q</span>;
}

/** 비율 띠의 빗금 칸(문제 문서) 필터 값. 실제 분류 이름과 겹치지 않게 밑줄로 시작한다. */
const PROBLEMS = "__problems";

function IssueList({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null;
  return (
    <div className="mt-1">
      <span className="text-[11px] font-medium text-status-error">{label}:</span>
      <ul className="ml-3 list-disc">
        {values.map((v) => (
          <li key={v} className="break-all font-mono text-[11px] text-status-error">
            {v}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Source-only viewer/editor. PDC bodies never render as HTML or Markdown here. */
function SourceViewer({ entry, onClose }: { entry: OpenSource; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const path = entry.path;
  const src = useQuery({
    queryKey: ["pdc-source", path],
    queryFn: () => invoke<PdcSourceFile>("pdc_read_source", { path }),
    refetchOnWindowFocus: false,
  });
  const [loadedSha, setLoadedSha] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const source = src.data;
    if (!source || source.sha256 === loadedSha) return;
    setLoadedSha(source.sha256);
    setTitle(source.title ?? "");
    setBody(source.editable_body ?? source.content);
    setSaveError(null);
  }, [src.data, loadedSha]);

  const editable =
    entry.class === "document" &&
    src.data?.editable_body !== undefined &&
    src.data.title !== undefined;
  const bodyChanged = editable && body !== src.data?.editable_body;
  const titleChanged = editable && title !== src.data?.title;
  const dirty = bodyChanged || titleChanged;

  // Two-step close: with unsaved edits the first close request arms a
  // visible discard confirmation — window.confirm no-ops in Tauri's
  // WKWebView (see SettingsMenu FoldersSection). The second request
  // commits. Arming clears as soon as there is nothing left to lose.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  useEffect(() => {
    if (!dirty) setConfirmDiscard(false);
  }, [dirty]);
  const requestClose = () => {
    if (dirty && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  const save = async () => {
    if (!src.data || !editable || !dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await invoke<PdcSourceFile>("pdc_update_document", {
        path,
        expectedSha256: src.data.sha256,
        title: titleChanged ? title : null,
        body: bodyChanged ? body : null,
      });
      qc.setQueryData(["pdc-source", path], updated);
      await qc.invalidateQueries({ queryKey: ["pdc-inventory"] });
    } catch (error) {
      setSaveError(String(error));
    } finally {
      setSaving(false);
    }
  };

  const reload = async () => {
    const latest = await src.refetch();
    if (latest.data) {
      setLoadedSha(null);
      setTitle(latest.data.title ?? "");
      setBody(latest.data.editable_body ?? latest.data.content);
      setLoadedSha(latest.data.sha256);
      setSaveError(null);
    }
  };

  // Body branches as early returns — no nested ternaries (project rule).
  const sourceBody = () => {
    if (src.isError) {
      return <p className="text-xs text-status-error">{String(src.error)}</p>;
    }
    if (editable) {
      return (
        <div className="space-y-3">
          <label className="block text-xs text-text-subtle">
            {t.pdc_title}
            <TextCtxMenu
              render={
                <input
                  aria-label={t.pdc_title}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  className="mt-1 w-full rounded border border-line bg-surface px-2 py-1.5 font-mono text-sm text-text"
                />
              }
            />
          </label>
          <label className="block text-xs text-text-subtle">
            {t.pdc_body}
            <TextCtxMenu
              render={
                <textarea
                  aria-label={t.pdc_body}
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  spellCheck={false}
                  className="mt-1 min-h-[45vh] w-full resize-y rounded border border-line bg-surface px-2 py-2 font-mono text-xs leading-relaxed text-text"
                />
              }
            />
          </label>
          {saveError && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-status-error" role="alert">
              <span>{saveError}</span>
              <button
                type="button"
                onClick={() => void reload()}
                className="rounded px-2 py-1 text-text-muted hover:bg-surface-muted hover:text-text"
              >
                {t.pdc_reload}
              </button>
            </div>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              disabled={!dirty || saving}
              onClick={() => void save()}
              className="rounded bg-interactive-primary px-3 py-1.5 text-xs font-medium text-interactive-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? t.pdc_saving : t.pdc_save}
            </button>
          </div>
        </div>
      );
    }
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-text">
        {src.data?.content}
      </pre>
    );
  };

  return (
    <div className="glass-backdrop fixed inset-0 z-[70] flex items-center justify-center p-6" onClick={requestClose}>
      <div
        className="pdc-source-sheet flex max-h-[85vh] w-full max-w-3xl flex-col border border-line bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-2">
          <div className="min-w-0">
            <p className="truncate font-mono text-xs text-text">{path}</p>
            <p className="text-[10px] uppercase tracking-wide text-text-subtle">
              {t.pdc_source_title} · {editable ? t.pdc_editable : t.pdc_read_only}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {confirmDiscard && (
              <span className="text-[10px] font-medium text-status-error" role="alert">
                {t.pdc_discard_changes}
              </span>
            )}
            <button
              type="button"
              aria-label={confirmDiscard ? t.pdc_discard_changes : t.capture_cancel}
              title={confirmDiscard ? t.pdc_discard_changes : t.capture_cancel}
              onClick={requestClose}
              className={`rounded p-1 hover:bg-surface-muted ${
                confirmDiscard ? "bg-status-error/10 text-status-error" : "text-text-subtle hover:text-text"
              }`}
            >
              <X size={16} aria-hidden />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {sourceBody()}
        </div>
      </div>
    </div>
  );
}

function CreateDocumentForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (path: string) => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [folder, setFolder] = useState("");
  const [profile, setProfile] = useState<"markdown" | "html">("markdown");
  const [tags, setTags] = useState("");
  const [body, setBody] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const receipt = await invoke<PdcWriteReceipt>("pdc_create_document", {
        request: {
          folder,
          title,
          body,
          body_profile: profile,
          tags: tags.split(/\r?\n/).map((tag) => tag.trim()).filter(Boolean),
          properties: [],
        },
      });
      onCreated(receipt.path);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setCreating(false);
    }
  };

  return (
    <form
      className="mb-4 space-y-3 rounded-lg border border-line bg-surface p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <h2 className="text-sm font-semibold text-text">{t.pdc_new}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-text-subtle">
          {t.pdc_title}
          <TextCtxMenu
            render={
              <input
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className="mt-1 w-full rounded border border-line bg-surface px-2 py-1.5 text-sm text-text"
              />
            }
          />
        </label>
        <label className="block text-xs text-text-subtle">
          {t.pdc_folder}
          <TextCtxMenu
            render={
              <input
                value={folder}
                onChange={(event) => setFolder(event.target.value)}
                className="mt-1 w-full rounded border border-line bg-surface px-2 py-1.5 font-mono text-sm text-text"
              />
            }
          />
        </label>
        <label className="block text-xs text-text-subtle">
          {t.pdc_profile}
          <select
            value={profile}
            onChange={(event) => setProfile(event.target.value as "markdown" | "html")}
            className="mt-1 w-full rounded border border-line bg-surface px-2 py-1.5 text-sm text-text"
          >
            <option value="markdown">{t.pdc_markdown}</option>
            <option value="html">{t.pdc_html}</option>
          </select>
        </label>
        <label className="block text-xs text-text-subtle">
          {t.pdc_tags_hint}
          <TextCtxMenu
            render={
              <textarea
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                rows={2}
                className="mt-1 w-full resize-y rounded border border-line bg-surface px-2 py-1.5 text-sm text-text"
              />
            }
          />
        </label>
      </div>
      <label className="block text-xs text-text-subtle">
        {t.pdc_body}
        <TextCtxMenu
          render={
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              spellCheck={false}
              className="mt-1 min-h-[24vh] w-full resize-y rounded border border-line bg-surface px-2 py-2 font-mono text-xs leading-relaxed text-text"
            />
          }
        />
      </label>
      {error && <p className="text-xs text-status-error" role="alert">{error}</p>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          disabled={creating}
          onClick={onCancel}
          className="rounded px-3 py-1.5 text-xs text-text-muted hover:bg-surface-muted hover:text-text disabled:opacity-50"
        >
          {t.pdc_cancel}
        </button>
        <button
          type="submit"
          disabled={creating}
          className="rounded bg-hue-blue/15 px-3 py-1.5 text-xs font-medium text-hue-blue disabled:opacity-50"
        >
          {creating ? t.pdc_creating : t.pdc_create}
        </button>
      </div>
    </form>
  );
}

/** One inventory row: path, class label (plain text — 2026-11-11 분류 알약
 *  9색은 무채색 규칙에서 구분되지 않아 글자로 바꿨다), title, source button,
 *  and any findings underneath. Shared by problem rows and healthy rows. */
function EntryRow({
  e,
  classLabel,
  duplicateIds,
  onOpen,
}: {
  e: PdcInventoryEntry;
  classLabel: string;
  duplicateIds: string[];
  onOpen: (source: OpenSource) => void;
}) {
  const { t } = useI18n();
  return (
    <li className="rounded-lg border border-line bg-surface px-3 py-2 transition-colors hover:bg-surface-muted">
      <div className="flex items-center gap-2">
        <EntryIcon path={e.path} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-text" title={e.path}>
          {e.path}
        </span>
        <span className="text-[10px] text-text-subtle">{classLabel}</span>
        {e.title && <span className="max-w-40 truncate text-xs text-text-subtle">{e.title}</span>}
        <button
          type="button"
          onClick={() => onOpen({ path: e.path, class: e.class })}
          className="rounded px-2 py-1 text-[11px] text-text-muted hover:bg-surface-muted hover:text-text"
        >
          {t.pdc_open_source}
        </button>
      </div>
      {(Boolean(e.diagnostic) ||
        e.broken_document_links.length > 0 ||
        e.missing_assets.length > 0 ||
        duplicateIds.length > 0) && (
        <div className="mt-1.5 border-t border-line pt-1.5">
          {e.diagnostic && (
            <p className="text-[11px] text-status-error">
              <span className="font-mono">{e.diagnostic.code}</span>
              {": "}
              {e.diagnostic.message}
              {typeof e.diagnostic.line === "number" && (
                <span className="text-text-subtle"> ({fmt(e.diagnostic.line, t.pdc_line)})</span>
              )}
            </p>
          )}
          <IssueList label={t.pdc_broken_links} values={e.broken_document_links} />
          <IssueList label={t.pdc_missing_assets} values={e.missing_assets} />
          <IssueList label={t.pdc_duplicates} values={duplicateIds} />
        </div>
      )}
    </li>
  );
}

/** 「문제 먼저」 IssueFirst (2026-11-11): 비율 띠 한 줄로 구성을 보이고, 문제
 *  문서만 펼쳐 위에 두고, 정상 문서는 접힌 한 줄로 묶는다. 정상 문서 수백 개
 *  사이에서 문제 행을 스크롤로 찾던 것을 없애려는 배치다.
 *  Loading / error / empty / list as early returns — the destination chain
 *  must stay flat and reorderable (project rule: no nested ternaries). Rows
 *  open the guarded source editor via `onOpen`. */
function InventoryResults({
  inv,
  items,
  duplicates,
  onOpen,
}: {
  inv: UseQueryResult<PdcInventory, Error>;
  items: PdcInventoryEntry[];
  duplicates: PdcDuplicateId[];
  onOpen: (source: OpenSource) => void;
}) {
  const { t } = useI18n();
  // 띠 칸을 누르면 그 분류만 본다. PROBLEMS 는 빗금 칸(문제 문서만).
  const [filter, setFilter] = useState<string | null>(null);
  const [healthyOpen, setHealthyOpen] = useState(false);
  if (inv.isLoading) {
    return (
      <div className="mt-4">
        <ListSkeleton rows={6} />
      </div>
    );
  }
  if (inv.isError) {
    return <p className="mt-16 text-center text-sm text-status-error">{String(inv.error)}</p>;
  }
  if (items.length === 0) {
    return <p className="mt-16 text-center text-sm text-text-subtle">{t.pdc_empty}</p>;
  }
  const classLabels: Record<string, string> = {
    document: t.pdc_class_document,
    legacy_document: t.pdc_class_legacy_document,
    legacy_markdown: t.pdc_class_legacy_markdown,
    legacy_html: t.pdc_class_legacy_html,
    invalid: t.pdc_class_invalid,
    unsupported: t.pdc_class_unsupported,
    query: t.pdc_class_query,
    query_valid_unexecuted: t.pdc_class_query_valid_unexecuted,
    invalid_query: t.pdc_class_invalid_query,
  };
  const labelOf = (cls: string) => classLabels[cls] ?? cls;
  const { problemPaths, segments } = summarizePdcIssues(items, duplicates);
  const dupIdsOf = (path: string) =>
    duplicates.filter((d) => d.paths.includes(path)).map((d) => d.document_id);
  // 분류 필터는 문제 행에도 걸린다 — 「이 분류에서 고칠 것」을 바로 보이게.
  const matches = (e: PdcInventoryEntry) => filter === null || filter === PROBLEMS || e.class === filter;
  const problems = items.filter((e) => problemPaths.has(e.path) && matches(e));
  const healthy = filter === PROBLEMS ? [] : items.filter((e) => !problemPaths.has(e.path) && matches(e));
  const healthyShown = healthyOpen;
  const toggleFilter = (next: string) => {
    const off = filter === next;
    setFilter(off ? null : next);
    // 분류 하나를 골랐으면 그 분류의 정상 문서를 바로 펼친다 — 누른 뒤 한 번 더 펼치게 하지 않는다.
    if (!off && next !== PROBLEMS) setHealthyOpen(true);
  };

  return (
    <div className="pdc-issue-first">
      <p className="pdc-issue-head">
        <b>{fmt(items.length, t.pdc_summary_docs)}</b>
        <span> · {fmt(problemPaths.size, t.pdc_summary_issues)}</span>
      </p>
      <div className="pdc-ratio" role="group" aria-label={t.pdc_ratio_label}>
        {segments.map((seg, i) => (
          <button
            key={seg.class}
            type="button"
            className="pdc-ratio-seg"
            data-tone={i % 2 === 0 ? "a" : "b"}
            aria-pressed={filter === seg.class}
            aria-label={t.pdc_ratio_segment.replace("{name}", labelOf(seg.class)).replace("{n}", String(seg.count))}
            title={`${labelOf(seg.class)} ${seg.count}`}
            style={{ flexGrow: seg.count }}
            onClick={() => toggleFilter(seg.class)}
          />
        ))}
        {problemPaths.size > 0 && (
          <button
            type="button"
            className="pdc-ratio-seg"
            data-tone="problem"
            aria-pressed={filter === PROBLEMS}
            aria-label={t.pdc_ratio_segment.replace("{name}", t.pdc_ratio_problems).replace("{n}", String(problemPaths.size))}
            title={`${t.pdc_ratio_problems} ${problemPaths.size}`}
            style={{ flexGrow: problemPaths.size }}
            onClick={() => toggleFilter(PROBLEMS)}
          />
        )}
      </div>
      <p className="pdc-ratio-legend">
        {segments.map((seg) => (
          <span key={seg.class} data-active={filter === seg.class ? "" : undefined}>
            {labelOf(seg.class)} {seg.count}
          </span>
        ))}
        {problemPaths.size > 0 && (
          <span data-active={filter === PROBLEMS ? "" : undefined} data-problem="">
            {t.pdc_ratio_problems} {problemPaths.size}
          </span>
        )}
        {filter !== null && (
          <button type="button" className="pdc-ratio-clear" onClick={() => setFilter(null)}>
            {t.pdc_filter_clear}
          </button>
        )}
      </p>

      {problemPaths.size === 0 && <p className="pdc-no-issues">{t.pdc_no_issues}</p>}

      {problems.length > 0 && (
        <ul className="pdc-document-list space-y-1.5">
          {problems.map((e) => (
            <EntryRow key={e.path} e={e} classLabel={labelOf(e.class)} duplicateIds={dupIdsOf(e.path)} onOpen={onOpen} />
          ))}
        </ul>
      )}

      {healthy.length > 0 && (
        <>
          <button
            type="button"
            className="pdc-healthy-toggle"
            aria-expanded={healthyShown}
            onClick={() => setHealthyOpen(!healthyShown)}
          >
            {fmt(healthy.length, t.pdc_healthy)}
            <span className="pdc-healthy-chevron" aria-hidden>›</span>
          </button>
          {healthyShown && (
            <ul className="pdc-document-list space-y-1.5">
              {healthy.map((e) => (
                <EntryRow key={e.path} e={e} classLabel={labelOf(e.class)} duplicateIds={[]} onOpen={onOpen} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export function PdcView() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  // Snapshot of the open document (see OpenSource): not derived from the
  // inventory, so a refresh that drops the entry cannot unmount the
  // editor and silently discard unsaved edits.
  const [openSource, setOpenSource] = useState<OpenSource | null>(null);
  const targetPath = useUI((s) => s.pdcTargetPath);
  const consumePdcTargetPath = useUI((s) => s.consumePdcTargetPath);
  const [activePane, setActivePane] = useState<"documents" | "sessions">("documents");
  const inv = useQuery({
    queryKey: ["pdc-inventory"],
    queryFn: () => invoke<PdcInventory>("pdc_inventory"),
  });
  useEffect(() => {
    if (!targetPath || !inv.data) return;
    const entry = inv.data.items.find((item) => item.path === targetPath);
    if (entry) setOpenSource({ path: entry.path, class: entry.class });
    consumePdcTargetPath();
  }, [targetPath, inv.data, consumePdcTargetPath]);

  // The vault watcher broadcasts both events on settled external edits;
  // mirror the CardGrid/Sidebar listeners so the inventory never goes
  // stale while this destination is open.
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    // A listen() promise may resolve after unmount (fast destination
    // switches); a late subscription unregisters immediately instead of
    // leaking (queryEmbeds pattern).
    let disposed = false;
    for (const event of ["memos:changed", "bases:changed"]) {
      void listen(event, () => {
        void qc.invalidateQueries({ queryKey: ["pdc-inventory"] });
      }).then((un) => {
        if (disposed) un();
        else unlisteners.push(un);
      });
    }
    return () => {
      disposed = true;
      unlisteners.forEach((un) => un());
    };
  }, [qc]);

  const items = inv.data?.items ?? [];
  const duplicates = inv.data?.duplicate_ids ?? [];
  // Localized vault-manifest badge (codes from the backend scan); an
  // unknown code falls back to the backend message.
  const manifestLabels: Record<string, string> = {
    missing_manifest: t.pdc_manifest_missing,
    invalid_manifest: t.pdc_manifest_invalid,
  };

  return (
    <div className="pdc-workspace" data-pdc-inventory="">
      <div className="pdc-heading"><h1>{t.pdc_documents}</h1></div>
      <div className="pdc-tabs mb-4 flex gap-1">
        {(["documents", "sessions"] as const).map((pane) => (
          <button
            key={pane}
            type="button"
            aria-pressed={activePane === pane}
            onClick={() => setActivePane(pane)}
            className={`rounded px-2.5 py-1 text-xs transition-colors ${
              activePane === pane
                ? "bg-surface-muted font-medium text-text"
                : "text-text-muted hover:bg-surface-muted/60 hover:text-text"
            }`}
          >
            {pane === "documents" ? t.session_tab_documents : t.session_tab_recorder}
          </button>
        ))}
      </div>
      {activePane === "sessions" ? <SessionRecorderPanel /> : (
        <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
            inv.data?.query_enabled ? "bg-hue-violet/15 text-hue-violet" : "bg-surface-muted text-text-muted"
          }`}
        >
          {inv.data?.query_enabled ? t.pdc_query_on : t.pdc_query_off}
        </span>
        {inv.data?.manifest_diagnostic && (
          <span className="rounded-full bg-status-error/15 px-2 py-0.5 text-[11px] font-medium text-status-error">
            {manifestLabels[inv.data.manifest_diagnostic.code] ?? inv.data.manifest_diagnostic.message}
          </span>
        )}
        <button
          type="button"
          onClick={() => setShowCreate((shown) => !shown)}
          className="rounded bg-interactive-primary px-2 py-1 text-xs text-interactive-primary-foreground hover:bg-interactive-primary/90"
        >
          {t.pdc_new}
        </button>
        <button
          type="button"
          onClick={() => inv.refetch()}
          className="ml-auto rounded px-2 py-1 text-xs text-text-muted hover:bg-surface-muted hover:text-text"
        >
          {t.pdc_retry}
        </button>
      </div>

      {showCreate && (
        <CreateDocumentForm
          onCancel={() => setShowCreate(false)}
          onCreated={(path) => {
            setShowCreate(false);
            // A fresh create is by definition a canonical document.
            setOpenSource({ path, class: "document" });
            void qc.invalidateQueries({ queryKey: ["pdc-inventory"] });
          }}
        />
      )}

      {duplicates.length > 0 && (
        <section className="mb-3 rounded-lg border border-status-error/40 bg-status-error/5 p-3">
          <h2 className="flex items-center gap-1.5 text-xs font-semibold text-status-error">
            <TriangleAlert size={14} aria-hidden />
            {t.pdc_duplicates}
          </h2>
          {duplicates.map((d) => (
            <div key={d.document_id} className="mt-1.5">
              <p className="break-all font-mono text-[11px] text-status-error">{d.document_id}</p>
              <IssueList label={t.pdc_diagnostics} values={d.paths} />
            </div>
          ))}
        </section>
      )}

      <InventoryResults inv={inv} items={items} duplicates={duplicates} onOpen={setOpenSource} />
        </>
      )}
      {/* Fixed overlay lives ABOVE the pane switch so flipping to the
          sessions pane cannot unmount the editor mid-edit. */}
      {openSource && <SourceViewer entry={openSource} onClose={() => setOpenSource(null)} />}
    </div>
  );
}
