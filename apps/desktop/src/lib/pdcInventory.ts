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
