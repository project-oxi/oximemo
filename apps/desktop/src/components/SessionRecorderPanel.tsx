import { open } from "@tauri-apps/plugin-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FolderPlus, GitBranch, History, Play, ScanSearch, Trash2, Upload } from "lucide-react";
import { useEffect, useState } from "react";

import { getConfig } from "../lib/api";
import { listen, invoke } from "../lib/tauri";
import { useI18n, type Dict } from "../lib/i18n";
import type { PdcSourceFile } from "../lib/pdcInventory";
import { RowsSkeleton } from "./Skeletons";
import "./SessionRecorderPanel.css";
import {
  sessionActivityDiscard,
  sessionActivityList,
  sessionGitScan,
  sessionGitSourceAdd,
  sessionGitSourceList,
  sessionGitSourceRemove,
  sessionGitSourceSetEnabled,
  sessionHistory,
  sessionImportFile,
  sessionList,
  sessionPolicy,
  sessionProcess,
  sessionQuarantineApplyFile,
  sessionQuarantineDiscard,
  sessionQuarantineList,
  sessionReviewAccept,
  sessionRollback,
  sessionSetPolicy,
  sessionSourceAdd,
  sessionSourceImport,
  sessionSourceList,
  sessionSourceRemove,
  sessionSourceSetEnabled,
  sessionSourcePreview,
  type SessionActivityEvent,
  type SessionPolicy,
  type SessionRecordStatus,
  type SessionRevision,
  type SessionSourcePreviewReport,
  type SessionSourceSelection,
} from "../lib/sessionRecorder";

/** 처리 레일의 단계. 데이터 원천이 있는 것만 둔다. */
type IntakeStage = "collected" | "review" | "quarantine" | "saved";

function fmt(n: number, pattern: string): string {
  return pattern.replace("{n}", String(n));
}

/** Activity-row tail: the full metadata JSON when present, otherwise the
 *  quarantined hint. Early returns keep the branch chain flat (project
 *  rule: no nested ternaries). */
function ActivityDetail({ event, t }: { event: SessionActivityEvent; t: Dict }) {
  if (event.metadata) {
    return (
      <details className="mt-1">
        <summary className="cursor-pointer text-[10px] text-text-subtle">{t.session_activity_metadata}</summary>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-surface px-2 py-1 font-mono text-[9px] text-text-subtle">
          {JSON.stringify(event.metadata, null, 2)}
        </pre>
      </details>
    );
  }
  if (event.state === "quarantined") {
    return <p className="mt-1 text-[10px] text-status-warning">{t.session_activity_quarantined}</p>;
  }
  return null;
}

export function SessionRecorderPanel() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ["session-status"], queryFn: () => sessionList(200) });
  const sources = useQuery({ queryKey: ["session-sources"], queryFn: sessionSourceList });
  const gitSources = useQuery({ queryKey: ["session-git-sources"], queryFn: sessionGitSourceList });
  const activity = useQuery({
    queryKey: ["session-activity"],
    queryFn: () => sessionActivityList(100),
    refetchInterval: 60_000,
  });
  const quarantine = useQuery({ queryKey: ["session-quarantine"], queryFn: sessionQuarantineList });
  const policy = useQuery({ queryKey: ["session-policy"], queryFn: sessionPolicy });
  const provider = useQuery({ queryKey: ["config"], queryFn: getConfig });
  const [working, setWorking] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [armedDiscard, setArmedDiscard] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<SessionRevision[]>([]);
  const [confirmExternal, setConfirmExternal] = useState(false);
  const [sourcePreview, setSourcePreview] = useState<SessionSourcePreviewReport | null>(null);
  const [picked, setPicked] = useState<IntakeStage | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["session-status"] });
    void qc.invalidateQueries({ queryKey: ["session-sources"] });
    void qc.invalidateQueries({ queryKey: ["session-git-sources"] });
    void qc.invalidateQueries({ queryKey: ["session-activity"] });
    void qc.invalidateQueries({ queryKey: ["session-quarantine"] });
    void qc.invalidateQueries({ queryKey: ["session-policy"] });
    void qc.invalidateQueries({ queryKey: ["pdc-inventory"] });
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    // A late-resolved listen() after unmount must unregister immediately
    // instead of leaking an extra refresh() per event (queryEmbeds
    // pattern).
    let disposed = false;
    void listen("sessions:changed", refresh).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [qc]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setWorking(key);
    setError(null);
    try {
      const result = await action();
      setLastResult(JSON.stringify(result) ?? "ok");
      refresh();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setWorking(null);
    }
  };

  const importFile = async () => {
    const selected = await open({
      multiple: false,
      title: t.session_import,
      filters: [{ name: "Cassette session export", extensions: ["json"] }],
    });
    if (typeof selected !== "string") return;
    await run("import", () => sessionImportFile(selected));
  };

  const addSource = async () => {
    const selected = await open({ directory: true, multiple: false, title: t.session_add_source });
    if (typeof selected !== "string") return;
    setSourcePreview(null);
    await run("source-add", () => sessionSourceAdd(selected, true));
  };
  const addGitSource = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t.session_add_git_source,
    });
    if (typeof selected !== "string") return;
    await run("git-source-add", () => sessionGitSourceAdd(selected));
  };

  const scanGitSources = () => run("git-scan", () => sessionGitScan(100));
  const toggleGitSource = (sourcePath: string, enabled: boolean) =>
    run("git-source-toggle", () => sessionGitSourceSetEnabled(sourcePath, enabled));
  const removeGitSource = (sourcePath: string) =>
    run("git-source-remove", () => sessionGitSourceRemove(sourcePath));
  const toggleSource = (sourceId: string, enabled: boolean) => {
    setSourcePreview(null);
    return run("source-toggle", () => sessionSourceSetEnabled(sourceId, enabled));
  };
  const removeSource = (sourceId: string) => {
    setSourcePreview(null);
    return run("source-remove", () => sessionSourceRemove(sourceId));
  };
  const discardActivity = (event: SessionActivityEvent) => {
    if (armedDiscard !== event.activity_id) {
      setArmedDiscard(event.activity_id);
      return;
    }
    setArmedDiscard(null);
    void run(`activity-discard:${event.activity_id}`, () =>
      sessionActivityDiscard(event.activity_id),
    );
  };

  const previewSources = () => run("preview", async () => {
    const report = await sessionSourcePreview();
    setSourcePreview(report);
    return {
      scanned: report.scanned,
      ready: report.ready,
      duplicates: report.duplicates,
      unchanged: report.unchanged,
      conflicts: report.conflicts,
      failed: report.failed,
    };
  });

  const importPreview = () => {
    const selections: SessionSourceSelection[] = (sourcePreview?.items ?? []).flatMap((item) =>
      item.state === "ready" && item.source_digest
        ? [{ source_id: item.source_id, file_name: item.file_name, source_digest: item.source_digest }]
        : [],
    );
    if (selections.length === 0) return;
    void run("source-import", async () => {
      const report = await sessionSourceImport(selections);
      setSourcePreview(null);
      return {
        scanned: report.scanned,
        imported: report.imported,
        duplicates: report.duplicates,
        failed: report.failed,
      };
    });
  };

  const chooseRedacted = async (sessionId: string) => {
    const selected = await open({
      multiple: false,
      title: t.session_apply_redaction,
      filters: [{ name: "Cassette session export", extensions: ["json"] }],
    });
    if (typeof selected !== "string") return;
    await run(`redact:${sessionId}`, () => sessionQuarantineApplyFile(sessionId, selected));
  };

  const setMode = (mode: SessionPolicy) => run("policy", () =>
    sessionSetPolicy(mode, policy.data?.retention_days ?? null),
  );

  const showHistory = async (record: SessionRecordStatus) => {
    setHistoryFor(record.record_id);
    // Only revisions fetched for the current `historyFor` may render —
    // never the previous record's list (open or failed fetch).
    setHistory([]);
    setError(null);
    try {
      setHistory(await sessionHistory(record.record_id));
    } catch (caught) {
      setHistory([]);
      setError(String(caught));
    }
  };

  const restore = (record: SessionRecordStatus, revision: SessionRevision) => {
    const requestKey = `rollback-${record.record_id}-${revision.revision}-${record.revision}`;
    return run(`rollback:${record.record_id}`, () =>
      sessionRollback(record.record_id, revision.revision, record.revision, requestKey),
    );
  };

  const providerConfigured = Boolean(
    provider.data?.session?.endpoint?.trim() && provider.data?.session?.model?.trim(),
  );
  const process = () => {
    if (provider.data?.session?.allow_external) {
      setConfirmExternal(true);
    } else {
      void run("process", () => sessionProcess(10));
    }
  };
  const reviewRecords = (sessions.data ?? []).flatMap((session) => session.records)
    .filter((record) => record.status === "review");

  // Sessions section body as early returns — no nested ternaries
  // (project rule).
  const sessionsList = () => {
    if (sessions.isLoading) {
      return <RowsSkeleton rows={4} />;
    }
    if ((sessions.data ?? []).length === 0) {
      return (
        <p className="rounded-lg bg-surface px-3 py-4 text-center text-xs text-text-subtle">
          {t.session_no_sessions}
        </p>
      );
    }
    return (
      <ul className="space-y-2">
        {sessions.data?.map((session) => (
          <li key={session.session_id} className="rounded-lg border border-line bg-surface p-3">
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-text">{session.title || session.external_id}</p>
                <p className="mt-0.5 font-mono text-[10px] text-text-subtle">
                  {session.source_kind} · {session.state} · {fmt(session.message_count, t.session_messages)}
                </p>
              </div>
              <span className="font-mono text-[9px] text-text-subtle">{session.payload_digest.slice(0, 19)}</span>
            </div>
            {session.last_error && <p className="mt-1 text-[10px] text-status-error">{session.last_error}</p>}
            {session.records.length > 0 && (
              <ul className="mt-2 space-y-1 border-t border-line pt-2">
                {session.records.map((record) => (
                  <RecordRow
                    key={record.record_id}
                    record={record}
                    t={t}
                    working={working}
                    onAccept={() => void run(`accept:${record.record_id}`, () =>
                      sessionReviewAccept(record.record_id, record.revision))}
                    onHistory={() => void showHistory(record)}
                  />
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    );
  };

  // 처리 레일 「IntakeRail」 (2026-11-11): 같은 크기 카드 일곱 장을 쌓던 것을
  // 단계 레일 + 고른 단계의 목록 하나로 바꿨다. 카드가 같은 무게라 「지금 내가
  // 처리할 것(검토 대기 · 격리)」이 설정 카드에 묻혔기 때문이다.
  // 단계 = 수집(활동) → 검토 대기(검토 상태 기록) → 격리(비밀 의심) → 저장(가져온 세션).
  // name 은 레일의 짧은 이름, title 은 아래 목록 구역의 이름(예전 카드 제목).
  const stages: Array<{ id: IntakeStage; name: string; title: string; count: number; human: boolean }> = [
    { id: "collected", name: t.session_stage_collected, title: t.session_activity, count: activity.data?.length ?? 0, human: false },
    { id: "review", name: t.session_review, title: t.session_review, count: reviewRecords.length, human: true },
    { id: "quarantine", name: t.session_stage_quarantine, title: t.session_quarantine, count: quarantine.data?.length ?? 0, human: true },
    { id: "saved", name: t.session_stage_saved, title: t.session_sessions, count: sessions.data?.length ?? 0, human: false },
  ];
  // 사용자가 고르기 전에는 사람 손이 필요한 단계를 먼저 연다. 데이터가 늦게 와도
  // 따라가도록 고른 값(picked)과 자동 값을 나눠 둔다.
  const autoStage: IntakeStage =
    stages.find((stage) => stage.human && stage.count > 0)?.id ?? "saved";
  const stage = picked ?? autoStage;
  const policyLabels: Record<SessionPolicy, string> = {
    automatic: t.session_policy_automatic,
    review: t.session_policy_review,
    capture_only: t.session_policy_capture_only,
  };

  // Stage body as early returns — no nested ternaries (project rule).
  const stageBody = () => {
    if (stage === "collected") {
      if ((activity.data ?? []).length === 0) {
        return <p className="text-[11px] text-text-subtle">{t.session_activity_empty}</p>;
      }
      return (
        <ul className="space-y-2">
          {activity.data?.map((event) => (
            <li key={event.activity_id} className="rounded bg-surface-muted px-2 py-1.5">
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] font-medium text-text">{event.title}</p>
                  <p className="font-mono text-[9px] text-text-subtle">
                    {event.source_kind} · {event.state} · {event.occurred_at}
                  </p>
                  {event.source_key && (
                    <p className="truncate font-mono text-[9px] text-text-subtle">{event.source_key}</p>
                  )}
                </div>
                <button
                  type="button"
                  disabled={working !== null}
                  onClick={() => discardActivity(event)}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-status-error hover:bg-surface disabled:opacity-50"
                >
                  <Trash2 size={11} aria-hidden />
                  {armedDiscard === event.activity_id ? t.session_confirm_discard : t.session_activity_discard}
                </button>
              </div>
              <ActivityDetail event={event} t={t} />
            </li>
          ))}
        </ul>
      );
    }
    if (stage === "review") {
      if (reviewRecords.length === 0) {
        return <p className="text-[11px] text-text-subtle">{t.session_review_empty}</p>;
      }
      return (
        <ul className="space-y-2">
          {sessions.data?.filter((session) => session.records.some((record) => record.status === "review"))
            .map((session) => (
              <li key={session.session_id} className="rounded-lg border border-line bg-surface p-3">
                <p className="truncate text-xs font-medium text-text">{session.title || session.external_id}</p>
                <ul className="mt-2 space-y-1 border-t border-line pt-2">
                  {session.records.filter((record) => record.status === "review").map((record) => (
                    <RecordRow
                      key={record.record_id}
                      record={record}
                      t={t}
                      working={working}
                      onAccept={() => void run(`accept:${record.record_id}`, () =>
                        sessionReviewAccept(record.record_id, record.revision))}
                      onHistory={() => void showHistory(record)}
                    />
                  ))}
                </ul>
              </li>
            ))}
        </ul>
      );
    }
    if (stage === "quarantine") {
      return (
        <>
          <p className="mt-1 text-[10px] leading-relaxed text-text-subtle">{t.session_quarantine_hint}</p>
          {(quarantine.data ?? []).length === 0 ? (
            <p className="mt-2 text-[11px] text-text-subtle">{t.session_quarantine_empty}</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {quarantine.data?.map((entry) => (
                <li key={entry.session_id} className="rounded border border-line bg-surface p-2">
                  <p className="truncate text-[11px] font-medium text-text">{entry.title || entry.external_id}</p>
                  <p className="mt-0.5 font-mono text-[9px] text-text-subtle">{entry.source_kind} · {entry.payload_digest.slice(0, 19)}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      disabled={working !== null}
                      onClick={() => void chooseRedacted(entry.session_id)}
                      className="rounded bg-surface-muted px-2 py-1 text-[10px] text-text hover:bg-surface-raised disabled:opacity-50"
                    >{t.session_apply_redaction}</button>
                    <button
                      type="button"
                      disabled={working !== null}
                      onClick={() => {
                        if (armedDiscard === entry.session_id) {
                          setArmedDiscard(null);
                          void run(`discard:${entry.session_id}`, () => sessionQuarantineDiscard(entry.session_id));
                        } else {
                          setArmedDiscard(entry.session_id);
                        }
                      }}
                      className="rounded bg-status-error/10 px-2 py-1 text-[10px] text-status-error hover:bg-status-error/15 disabled:opacity-50"
                    >{armedDiscard === entry.session_id ? t.session_confirm_discard : t.session_discard}</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      );
    }
    return sessionsList();
  };

  const readyPreviewCount = sourcePreview?.items.filter(
    (item) => item.state === "ready" && item.source_digest !== null,
  ).length ?? 0;
  return (
    <div className="space-y-4" data-session-recorder="">
      <div className="intake-rail" role="group" aria-label={t.session_rail_label}>
        {stages.map((item) => (
          <button
            key={item.id}
            type="button"
            className="intake-rail-stage"
            data-human={item.human ? "" : undefined}
            aria-pressed={stage === item.id}
            aria-label={(item.human && item.count > 0 ? t.session_stage_needs_you : t.session_stage_count)
              .replace("{name}", item.name)
              .replace("{n}", String(item.count))}
            onClick={() => setPicked(item.id)}
          >
            <span className="intake-rail-name">{item.name}</span>
            <span className="intake-rail-count">{item.count}</span>
          </button>
        ))}
      </div>

      <section aria-label={stages.find((item) => item.id === stage)?.title}>
        {stageBody()}
      </section>

      {historyFor && (
        <section className="rounded-lg border border-line bg-surface p-3">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-1 text-xs font-semibold text-text"><History size={12} aria-hidden />{t.session_history}</h2>
            <button type="button" onClick={() => setHistoryFor(null)} className="text-[10px] text-text-subtle hover:text-text">×</button>
          </div>
          <ul className="mt-2 space-y-1.5">
            {history.map((revision) => {
              const record = sessions.data?.flatMap((session) => session.records)
                .find((item) => item.record_id === historyFor);
              return (
                <li key={revision.revision} className="flex flex-wrap items-center gap-2 rounded bg-surface-sunken px-2 py-1.5">
                  <code className="min-w-0 flex-1 truncate text-[9px] text-text-subtle" title={revision.revision}>
                    {revision.revision} · {revision.reason}
                  </code>
                  {record && record.revision !== revision.revision && (
                    <button
                      type="button"
                      disabled={working !== null}
                      onClick={() => void restore(record, revision)}
                      className="rounded px-2 py-1 text-[10px] text-hue-blue hover:bg-hue-blue/10 disabled:opacity-50"
                    >{t.session_rollback}</button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* 가져오기 · 정책 · 등록 폴더 · Git 은 한 번 정하면 잘 바뀌지 않는 설정이라 맨 아래 한 줄로 접는다.
          펼치면 예전 컨트롤이 그대로 나온다. */}
      <details className="intake-setup" open={setupOpen} onToggle={(event) => setSetupOpen(event.currentTarget.open)}>
        <summary className="intake-setup-summary">
          {t.session_setup_summary
            .replace("{folders}", String(sources.data?.length ?? 0))
            .replace("{git}", String(gitSources.data?.length ?? 0))
            .replace("{policy}", policyLabels[policy.data?.mode ?? "automatic"])}
          <span className="intake-setup-chevron" aria-hidden>›</span>
        </summary>
        <div className="mt-3 space-y-4">
          <section className="rounded-lg border border-line bg-surface p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 className="text-xs font-semibold text-text">{t.session_import}</h2>
                <p className="mt-1 text-[11px] leading-relaxed text-text-subtle">{t.session_import_hint}</p>
              </div>
              <button
                type="button"
                disabled={working !== null}
                onClick={() => void importFile()}
                className="flex items-center gap-1.5 rounded bg-hue-blue/15 px-2.5 py-1.5 text-xs font-medium text-hue-blue hover:bg-hue-blue/20 disabled:opacity-50"
              >
                <Upload size={13} aria-hidden />{t.session_import}
              </button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-[11px] text-text-muted">
                {t.session_policy}
                <select
                  aria-label={t.session_policy}
                  value={policy.data?.mode ?? "automatic"}
                  disabled={working !== null || policy.isLoading}
                  onChange={(event) => void setMode(event.target.value as SessionPolicy)}
                  className="rounded border border-line bg-surface px-2 py-1 text-[11px] text-text"
                >
                  <option value="automatic">{t.session_policy_automatic}</option>
                  <option value="review">{t.session_policy_review}</option>
                  <option value="capture_only">{t.session_policy_capture_only}</option>
                </select>
              </label>
              <button
                type="button"
                disabled={working !== null || !providerConfigured}
                onClick={process}
                className="flex items-center gap-1.5 rounded bg-hue-green/15 px-2.5 py-1.5 text-xs font-medium text-hue-green hover:bg-hue-green/20 disabled:opacity-50"
              >
                <Play size={12} aria-hidden />{working === "process" ? t.session_processing : t.session_process}
              </button>
              {!providerConfigured && <span className="text-[11px] text-text-subtle">{t.session_provider_missing}</span>}
              {policy.data?.retention_days !== null && (
                <span className="text-[10px] text-text-subtle">{t.session_retention_label}</span>
              )}
            </div>
            {confirmExternal && (
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded border border-hue-orange/30 bg-hue-orange/5 p-2">
                <p className="min-w-0 flex-1 text-[11px] text-text">{t.session_external_confirm}</p>
                <button
                  type="button"
                  disabled={working !== null}
                  onClick={() => {
                    setConfirmExternal(false);
                    void run("process", () => sessionProcess(10, true));
                  }}
                  className="rounded bg-hue-orange/15 px-2.5 py-1.5 text-xs font-medium text-hue-orange hover:bg-hue-orange/20 disabled:opacity-50"
                >{t.session_process}</button>
                <button
                  type="button"
                  onClick={() => setConfirmExternal(false)}
                  className="rounded px-2.5 py-1.5 text-xs text-text-muted hover:bg-surface-muted"
                >{t.pdc_cancel}</button>
              </div>
            )}
          </section>

          <section className="rounded-lg border border-line bg-surface p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xs font-semibold text-text">{t.session_sources}</h2>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  disabled={working !== null}
                  onClick={() => void addSource()}
                  className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-text-muted hover:bg-surface-muted hover:text-text disabled:opacity-50"
                ><FolderPlus size={12} aria-hidden />{t.session_add_source}</button>
                <button
                  type="button"
                  disabled={working !== null || (sources.data?.length ?? 0) === 0}
                  onClick={() => void previewSources()}
                  className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-text-muted hover:bg-surface-muted hover:text-text disabled:opacity-50"
                ><ScanSearch size={12} aria-hidden />{t.session_preview_sources}</button>
                {sourcePreview && (
                  <button
                    type="button"
                    disabled={working !== null || readyPreviewCount === 0}
                    onClick={importPreview}
                    className="flex items-center gap-1 rounded bg-hue-blue/15 px-2 py-1 text-[11px] font-medium text-hue-blue hover:bg-hue-blue/20 disabled:opacity-50"
                  ><Upload size={12} aria-hidden />{t.session_import_preview.replace("{n}", String(readyPreviewCount))}</button>
                )}
              </div>
            </div>
            {(sources.data ?? []).length === 0 ? (
              <p className="text-[11px] text-text-subtle">{t.session_no_sources}</p>
            ) : (
              <ul className="space-y-1">
                {sources.data?.map((source) => (
                  <li key={source.id} className="rounded bg-surface-muted px-2 py-1.5">
                    <p className="truncate font-mono text-[10px] text-text-subtle" title={source.path}>
                      {source.enabled ? "●" : "○"} {source.path}
                    </p>
                    {source.last_error && <p className="text-[10px] text-status-error">{source.last_error}</p>}
                    <div className="mt-1 flex gap-1.5">
                      <button
                        type="button"
                        disabled={working !== null}
                        onClick={() => void toggleSource(source.id, !source.enabled)}
                        className="rounded px-1.5 py-0.5 text-[10px] text-text-muted hover:bg-surface hover:text-text disabled:opacity-50"
                      >{source.enabled ? t.session_source_disable : t.session_source_enable}</button>
                      <button
                        type="button"
                        disabled={working !== null}
                        onClick={() => void removeSource(source.id)}
                        className="rounded px-1.5 py-0.5 text-[10px] text-status-error hover:bg-surface disabled:opacity-50"
                      >{t.session_source_remove}</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {sourcePreview && (
              <div className="mt-3 border-t border-line pt-2">
                <p className="text-[10px] text-text-subtle">
                  {t.session_preview_result
                    .replace("{scanned}", String(sourcePreview.scanned))
                    .replace("{ready}", String(sourcePreview.ready))
                    .replace("{duplicates}", String(sourcePreview.duplicates))
                    .replace("{unchanged}", String(sourcePreview.unchanged))
                    .replace("{conflicts}", String(sourcePreview.conflicts))
                    .replace("{failed}", String(sourcePreview.failed))}
                </p>
                {sourcePreview.items.length > 0 && (
                  <ul className="mt-2 max-h-56 space-y-1 overflow-auto">
                    {sourcePreview.items.map((item) => (
                      <li key={`${item.source_id}/${item.file_name}`} className="rounded bg-surface-muted px-2 py-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-[11px] text-text">{item.title || item.file_name}</span>
                          <span className="text-[10px] text-text-subtle">{item.state}{item.import_state ? ` · ${item.import_state}` : ""}</span>
                        </div>
                        <p className="truncate font-mono text-[9px] text-text-subtle">{item.file_name}{item.source_kind ? ` · ${item.source_kind}` : ""}{item.message_count !== null ? ` · ${fmt(item.message_count, t.session_messages)}` : ""}</p>
                        {item.error && <p className="text-[10px] text-status-error">{item.error}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
          <section className="rounded-lg border border-line bg-surface p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-1.5 text-xs font-semibold text-text">
                <GitBranch size={13} aria-hidden />{t.session_git_sources}
              </h2>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  disabled={working !== null}
                  onClick={() => void addGitSource()}
                  className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-text-muted hover:bg-surface-muted hover:text-text disabled:opacity-50"
                ><FolderPlus size={12} aria-hidden />{t.session_add_git_source}</button>
                <button
                  type="button"
                  disabled={working !== null || (gitSources.data?.length ?? 0) === 0}
                  onClick={scanGitSources}
                  className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-text-muted hover:bg-surface-muted hover:text-text disabled:opacity-50"
                ><ScanSearch size={12} aria-hidden />{t.session_scan_git_sources}</button>
              </div>
            </div>
            <p className="mb-2 text-[10px] leading-relaxed text-text-subtle">{t.session_git_metadata_hint}</p>
            {(gitSources.data ?? []).length === 0 ? (
              <p className="text-[11px] text-text-subtle">{t.session_no_git_sources}</p>
            ) : (
              <ul className="space-y-1">
                {gitSources.data?.map((source) => (
                  <li key={source.path} className="rounded bg-surface-muted px-2 py-1.5">
                    <p className="truncate font-mono text-[10px] text-text-subtle" title={source.path}>
                      {source.enabled ? "●" : "○"} {source.path}
                    </p>
                    {source.last_error && <p className="text-[10px] text-status-error">{source.last_error}</p>}
                    <div className="mt-1 flex gap-1.5">
                      <button
                        type="button"
                        disabled={working !== null}
                        onClick={() => void toggleGitSource(source.path, !source.enabled)}
                        className="rounded px-1.5 py-0.5 text-[10px] text-text-muted hover:bg-surface hover:text-text disabled:opacity-50"
                      >{source.enabled ? t.session_source_disable : t.session_source_enable}</button>
                      <button
                        type="button"
                        disabled={working !== null}
                        onClick={() => void removeGitSource(source.path)}
                        className="rounded px-1.5 py-0.5 text-[10px] text-status-error hover:bg-surface"
                      >{t.session_source_remove}</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </details>

      {lastResult && <p className="break-all rounded bg-surface-sunken px-3 py-2 text-[10px] text-text-subtle">{t.session_last_result}: {lastResult}</p>}
      {error && <p role="alert" className="break-all rounded bg-status-error/10 px-3 py-2 text-[11px] text-status-error">{error}</p>}
    </div>
  );
}

function RecordRow({
  record,
  t,
  working,
  onAccept,
  onHistory,
}: {
  record: SessionRecordStatus;
  t: Dict;
  working: string | null;
  onAccept: () => void;
  onHistory: () => void;
}) {
  const [source, setSource] = useState<PdcSourceFile | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);

  useEffect(() => {
    setSource(null);
    setShowSource(false);
    setSourceError(null);
  }, [record.path, record.revision]);

  const viewSource = async () => {
    if (showSource) {
      setShowSource(false);
      return;
    }
    if (source) {
      setShowSource(true);
      return;
    }
    try {
      setSource(await invoke<PdcSourceFile>("pdc_read_source", { path: record.path }));
      setShowSource(true);
    } catch (caught) {
      setSourceError(String(caught));
    }
  };

  return (
    <li className="space-y-2 text-[10px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-text-muted">{record.kind}: {record.title} · {record.status}</span>
        {record.status === "review" && (
          <>
            <button
              type="button"
              disabled={working !== null}
              onClick={() => void viewSource()}
              className="rounded px-2 py-1 text-text-subtle hover:bg-surface-muted hover:text-text disabled:opacity-50"
            >{t.session_view_record}</button>
            <button
              type="button"
              disabled={working !== null}
              onClick={onAccept}
              className="flex items-center gap-1 rounded bg-hue-green/10 px-2 py-1 text-hue-green hover:bg-hue-green/15 disabled:opacity-50"
            ><Check size={11} aria-hidden />{t.session_accept}</button>
          </>
        )}
        <button
          type="button"
          disabled={working !== null}
          onClick={onHistory}
          className="rounded px-2 py-1 text-text-subtle hover:bg-surface-muted hover:text-text disabled:opacity-50"
        >{t.session_history}</button>
      </div>
      {sourceError && <p className="text-hue-red">{sourceError}</p>}
      {showSource && source && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-line bg-surface-muted p-2 text-[10px] text-text">{source.content}</pre>
      )}
    </li>
  );
}
