export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type MarkdownDiagnosticCode =
  | "invalid_transport"
  | "invalid_envelope"
  | "invalid_query"
  | "legacy_html"
  | "legacy_markdown"
  | "legacy_document_version"
  | "unsupported_document_version"
  | "unsupported_body_version"
  | "invalid_document_id"
  | "duplicate_document_id"
  | "duplicate_block_id"
  | "document_too_large"
  | "document_too_complex"
  | "missing_asset"
  | "asset_digest_mismatch"
  | "unsafe_content"
  | "unsupported_lossless_edit"
  | "external_change_conflict"
  | "unsupported_query_construct";

export interface MarkdownDiagnostic {
  code: MarkdownDiagnosticCode;
  message: string;
  line?: number;
  column?: number;
}

export interface MarkdownEnvelope extends JsonObject {
  format: "pdc-document/2";
  body: "pdc-markdown/1";
  id: string;
  created: string;
  updated: string;
  title: string;
}

export interface MarkdownDocument {
  kind: "markdown";
  profile: "pdc-markdown/1";
  version: 2;
  envelope: MarkdownEnvelope;
  body: string;
  source: string;
  editable: true;
}

export interface LegacyDocument {
  kind: "legacy";
  profile: string | null;
  version: 1 | null;
  body: string;
  source: string;
  editable: false;
  diagnostic: MarkdownDiagnostic;
}

export interface ReadOnlyPdcDocument {
  kind: "read_only";
  profile: "pdc-html/1" | "pdc-djot/1";
  version: 1 | 2;
  envelope: JsonObject;
  body: string;
  source: string;
  editable: false;
  diagnostic: MarkdownDiagnostic;
}

export interface InvalidDocument {
  kind: "invalid";
  source: string;
  editable: false;
  diagnostic: MarkdownDiagnostic;
}

export type MarkdownReadResult = MarkdownDocument | ReadOnlyPdcDocument | LegacyDocument | InvalidDocument;

export class MarkdownContractError extends Error {
  readonly diagnostic: MarkdownDiagnostic;

  constructor(diagnostic: MarkdownDiagnostic) {
    super(diagnostic.message);
    this.name = "MarkdownContractError";
    this.diagnostic = diagnostic;
  }
}
