/**
 * PDC inventory and guarded-source DTOs shared with the Tauri host.
 * Canonical PDC 2 sources expose digest-guarded source editing and creation.
 */

export type PdcDiagnostic = {
  code: string;
  message: string;
  line?: number | null;
};

export type PdcInventoryEntry = {
  /** Vault-relative forward-slash path. */
  path: string;
  /** snake_case classification (canonical, legacy, invalid, query, …). */
  class: string;
  document_id?: string | null;
  title?: string | null;
  body_profile?: string | null;
  size_bytes: number;
  diagnostic?: PdcDiagnostic | null;
  /** `pdc://document/<uuid>` targets not present in the inventory. */
  broken_document_links: string[];
  /** `pdc://asset/sha256/<digest>` digests missing from `.pdc/assets`. */
  missing_assets: string[];
};

export type PdcDuplicateId = {
  document_id: string;
  paths: string[];
};

export type PdcInventory = {
  query_enabled: boolean;
  manifest_diagnostic: PdcDiagnostic | null;
  duplicate_ids: PdcDuplicateId[];
  items: PdcInventoryEntry[];
};

export type PdcSourceFile = {
  path: string;
  content: string;
  sha256: string;
  document_id?: string;
  editable_body?: string;
  title?: string;
  body_profile?: string;
};

export type PdcWriteReceipt = {
  path: string;
  document_id: string;
  sha256: string;
};

/** 문서 하나에 고칠 거리가 있는가 — 진단 · 깨진 링크 · 빠진 자산 · 겹친 id. */
export function pdcEntryHasProblem(entry: PdcInventoryEntry, duplicatePaths: ReadonlySet<string>): boolean {
  return (
    Boolean(entry.diagnostic) ||
    entry.broken_document_links.length > 0 ||
    entry.missing_assets.length > 0 ||
    duplicatePaths.has(entry.path)
  );
}

export type PdcClassSegment = { class: string; count: number };

export type PdcIssueSummary = {
  /** 문제 있는 문서의 경로. 비율 띠의 빗금 칸과 위쪽 문제 목록이 같은 집합을 본다. */
  problemPaths: Set<string>;
  /** 정상 문서만 분류별로 센 칸 — 큰 순, 같으면 분류 이름 순. 문제 문서는 빗금 칸 하나로 따로 센다
   *  (같은 문서를 두 칸에 세면 띠 길이의 합이 문서 수와 어긋난다). */
  segments: PdcClassSegment[];
};

/** IssueFirst(2026-11-11) 화면의 비율 띠와 문제 목록이 쓰는 요약. */
export function summarizePdcIssues(items: PdcInventoryEntry[], duplicates: PdcDuplicateId[]): PdcIssueSummary {
  const duplicatePaths = new Set(duplicates.flatMap((d) => d.paths));
  const problemPaths = new Set<string>();
  const counts = new Map<string, number>();
  for (const entry of items) {
    if (pdcEntryHasProblem(entry, duplicatePaths)) {
      problemPaths.add(entry.path);
      continue;
    }
    counts.set(entry.class, (counts.get(entry.class) ?? 0) + 1);
  }
  const segments = [...counts.entries()]
    .map(([cls, count]) => ({ class: cls, count }))
    .sort((a, b) => b.count - a.count || a.class.localeCompare(b.class));
  return { problemPaths, segments };
}
