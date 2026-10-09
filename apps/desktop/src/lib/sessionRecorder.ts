import { invoke } from "./tauri";

export type SessionPolicy = "automatic" | "review" | "capture_only";

export interface SessionPolicyState {
  mode: SessionPolicy;
  retention_days: number | null;
  retention_applied: boolean;
}

export interface SessionImportReceipt {
  session_id: string;
  source_kind: string;
  external_id: string;
  source_revision: string;
  state: string;
  duplicate: boolean;
  payload_digest: string;
}

export interface SessionRecordStatus {
  record_id: string;
  kind: string;
  title: string;
  path: string;
  intent: string;
  revision: string;
  status: string;
  source_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface SessionStatus {
  session_id: string;
  source_kind: string;
  external_id: string;
  title: string;
  occurred_at: string;
  source_revision: string;
  complete: boolean;
  state: string;
  message_count: number;
  payload_digest: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  records: SessionRecordStatus[];
}

export interface SessionProcessResult {
  session_id: string;
  state: string;
  records: SessionRecordStatus[];
  skipped: string | null;
  error: string | null;
}

export interface SessionProcessReport {
  mode: SessionPolicy;
  processed: SessionProcessResult[];
  remaining: number;
  skipped: string | null;
}

export interface QuarantineEntry {
  session_id: string;
  source_kind: string;
  external_id: string;
  title: string;
  source_revision: string;
  payload_digest: string;
  created_at: string;
  reason: string;
}

export interface SessionSourceRegistration {
  id: string;
  path: string;
  enabled: boolean;
  last_error: string | null;
  created_at: string;
}

export interface SessionSourcePreviewItem {
  source_id: string;
  file_name: string;
  source_digest: string | null;
  state: string;
  source_kind: string | null;
  external_id: string | null;
  title: string | null;
  source_revision: string | null;
  message_count: number | null;
  import_state: string | null;
  error: string | null;
}

export interface SessionSourcePreviewReport {
  scanned: number;
  ready: number;
  duplicates: number;
  unchanged: number;
  conflicts: number;
  failed: number;
  items: SessionSourcePreviewItem[];
}

export interface SessionSourceSelection {
  source_id: string;
  file_name: string;
  source_digest: string;
}

export interface SessionSourceImportItem {
  file_name: string;
  state: string;
  import: SessionImportReceipt | null;
  error: string | null;
}

export interface SessionSourceImportReport {
  scanned: number;
  imported: number;
  duplicates: number;
  failed: number;
  items: SessionSourceImportItem[];
}
export interface SessionSourceCollectionReport {
  preview: SessionSourcePreviewReport;
  import: SessionSourceImportReport;
}

export interface SessionRunReport extends SessionProcessReport {
  collection: SessionSourceCollectionReport | null;
  git_scan?: SessionGitScanReport | null;
}

export interface SessionActivityEvent {
  activity_id: string;
  source_kind: string;
  source_key: string;
  external_id: string;
  title: string;
  occurred_at: string;
  payload_digest: string;
  state: string;
  metadata: unknown | null;
  created_at: string;
}

export interface SessionGitSource {
  path: string;
  enabled: boolean;
  last_error: string | null;
  created_at: string;
  cursor: string | null;
}

export interface SessionGitScanItem {
  path: string;
  scanned: number;
  captured: number;
  duplicates: number;
  error: string | null;
}

export interface SessionGitScanReport {
  scanned: number;
  captured: number;
  duplicates: number;
  failed: number;
  items: SessionGitScanItem[];
}


export interface SessionRevision {
  record_id: string;
  revision: string;
  created_at: string;
  reason: string;
  source: string;
  source_ids: string[];
}

export const sessionImportFile = (path: string) =>
  invoke<SessionImportReceipt>("session_import_file", { path });
export const sessionList = (limit = 100) =>
  invoke<SessionStatus[]>("session_list", { limit });
export const sessionProcess = (limit = 10, confirmExternal = false) =>
  invoke<SessionRunReport>("session_process", { limit, confirmExternal });
export const sessionPolicy = () =>
  invoke<SessionPolicyState>("session_policy");
export const sessionSetPolicy = (mode: SessionPolicy, retentionDays: number | null) =>
  invoke<SessionPolicyState>("session_set_policy", { mode, retentionDays });
export const sessionSourceAdd = (path: string, enabled = true) =>
  invoke<SessionSourceRegistration>("session_source_add", { path, enabled });
export const sessionSourceList = () =>
  invoke<SessionSourceRegistration[]>("session_source_list");
export const sessionSourceSetEnabled = (sourceId: string, enabled: boolean) =>
  invoke<SessionSourceRegistration>("session_source_set_enabled", { sourceId, enabled });
export const sessionSourceRemove = (sourceId: string) =>
  invoke<boolean>("session_source_remove", { sourceId });
export const sessionSourcePreview = () =>
  invoke<SessionSourcePreviewReport>("session_source_preview");
export const sessionSourceImport = (selections: SessionSourceSelection[]) =>
  invoke<SessionSourceImportReport>("session_source_import", { selections });
export const sessionActivityList = (limit = 100) =>
  invoke<SessionActivityEvent[]>("session_activity_list", { limit });
export const sessionActivityDiscard = (activityId: string) =>
  invoke<void>("session_activity_discard", { activityId });
export const sessionGitSourceAdd = (path: string) =>
  invoke<SessionGitSource>("session_git_source_add", { path });
export const sessionGitSourceList = () =>
  invoke<SessionGitSource[]>("session_git_source_list");
export const sessionGitSourceSetEnabled = (path: string, enabled: boolean) =>
  invoke<SessionGitSource>("session_git_source_set_enabled", { path, enabled });
export const sessionGitSourceRemove = (path: string) =>
  invoke<boolean>("session_git_source_remove", { path });
export const sessionGitScan = (limit = 100) =>
  invoke<SessionGitScanReport>("session_git_scan", { limit });
export const sessionCodexHookStatus = () =>
  invoke<boolean>("session_codex_hook_status");
export const sessionCodexHookInstall = () =>
  invoke<string>("session_codex_hook_install");
export const sessionCodexHookUninstall = () =>
  invoke<string>("session_codex_hook_uninstall");
export const sessionQuarantineList = () =>
  invoke<QuarantineEntry[]>("session_quarantine_list");
export const sessionQuarantineApplyFile = (sessionId: string, path: string) =>
  invoke<SessionImportReceipt>("session_quarantine_apply_file", { sessionId, path });
export const sessionQuarantineDiscard = (sessionId: string) =>
  invoke<void>("session_quarantine_discard", { sessionId });
export const sessionReviewAccept = (recordId: string, expectedSha256: string) =>
  invoke<SessionRecordStatus>("session_review_accept", { recordId, expectedSha256 });
export const sessionHistory = (recordId: string) =>
  invoke<SessionRevision[]>("session_history", { recordId });
export const sessionRollback = (
  recordId: string,
  targetRevision: string,
  baseRevision: string,
  requestKey: string,
) =>
  invoke<SessionRecordStatus>("session_rollback", {
    recordId,
    targetRevision,
    baseRevision,
    requestKey,
  });
