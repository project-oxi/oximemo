import { useEffect, useRef, useState } from 'react';
import type { MarkdownDiagnostic } from '@garden/markdown';
import { MarkdownContractError } from '@garden/markdown';
import { GMarkdownEditor } from './GMarkdownEditor.js';
import type { EmbedResource } from './embed-preview.js';
import type { SlashCommandLabels } from './slash-commands.js';
import type { MarkdownNavigationTarget } from './wiki-navigation.js';
import { GDocumentProperties } from './GDocumentProperties.js';
import type { GDocumentPropertiesStrings } from './GDocumentProperties.js';
import { parseDocumentSource, patchDocumentBody } from './document-model.js';

export interface GDocumentEditorStrings extends GDocumentPropertiesStrings {
  technicalFields: string;
  documentId: string;
  format: string;
  bodyProfile: string;
  created: string;
  updated: string;
  deleted: string;
  deletedAt: string;
  completeSource: string;
  body: string;
  embedEdit?: string;
  embedMissing?: string;
  codeEdit?: string;
  codeCopy?: string;
  codeCopied?: string;
  taskTodo?: string;
  taskDone?: string;
  taskToggle?: string;
  tablePreviewLabel?: string;
  slashCommands?: SlashCommandLabels;
  wikiFootnote?: string;
  wikiBacklink?: string;
}

export interface GDocumentEditorProps {
  value: string;
  onChange: (source: string) => void;
  label: string;
  strings: GDocumentEditorStrings;
  documentId?: string;
  onLinkOpen?: (url: string) => void;
  resolveEmbed?: (reference: string) => EmbedResource | undefined;
  navigationTarget?: MarkdownNavigationTarget;
}

function diagnosticPosition(diagnostic: MarkdownDiagnostic): string {
  return diagnostic.line === undefined ? '' : ' (' + diagnostic.line + ':' + (diagnostic.column ?? 1) + ')';
}

function ReadonlyProperty({ label, value }: { label: string; value: string }) {
  return <div className="garden-document-technical-row">
    <dt>{label}</dt>
    <dd>{value}</dd>
  </div>;
}

export function GDocumentEditor({
  value,
  onChange,
  label,
  strings,
  documentId,
  onLinkOpen,
  resolveEmbed,
  navigationTarget,
}: GDocumentEditorProps) {
  const sourceRef = useRef(value);
  sourceRef.current = value;
  const [editDiagnostic, setEditDiagnostic] = useState<MarkdownDiagnostic | null>(null);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const model = parseDocumentSource(value);
  const documentIdentity = documentId ?? (model.editable ? model.document.envelope.id : value);

  useEffect(() => {
    setEditDiagnostic(null);
  }, [documentIdentity]);

  const publish = (next: string): boolean => {
    if (next === sourceRef.current) return true;
    sourceRef.current = next;
    setEditDiagnostic(null);
    onChange(next);
    return true;
  };

  const reportError = (error: unknown) => {
    const diagnostic = error instanceof MarkdownContractError
      ? error.diagnostic
      : { code: 'unsupported_lossless_edit' as const, message: error instanceof Error ? error.message : String(error) };
    setEditDiagnostic(diagnostic);
    return diagnostic;
  };

  if (!model.editable) {
    const stateLabel = model.result.kind === 'legacy'
      ? strings.legacySource
      : model.result.kind === 'read_only'
        ? strings.unsupportedSource
        : strings.invalidSource;
    return <section className="garden-document-editor" aria-label={label}>
      <p className="garden-document-diagnostic" role="status">
        {stateLabel} <span>{strings.diagnostic}: <code>{model.diagnostic.code}</code>{diagnosticPosition(model.diagnostic)}</span>
      </p>
      <pre className="garden-document-source-readonly"><code>{value}</code></pre>
    </section>;
  }

  const envelope = model.document.envelope;
  const showDiagnostic = (diagnostic: MarkdownDiagnostic | null) => {
    if (!diagnostic) return null;
    return <p className="garden-document-diagnostic garden-document-edit-error" role="alert">
      {strings.propertyEditError} <span>{strings.diagnostic}: <code>{diagnostic.code}</code>{diagnosticPosition(diagnostic)}</span>
    </p>;
  };

  return <section className="garden-document-editor" aria-label={label}>
    <div className="garden-document-content">
      <GDocumentProperties
        value={value}
        onChange={publish}
        strings={strings}
        documentId={documentIdentity}
      />

      {showDiagnostic(editDiagnostic)}

      <div className="garden-document-body">
        <GMarkdownEditor
          key={documentIdentity + '-' + editorEpoch}
          value={model.document.body}
          onChange={(body) => {
            try {
              publish(patchDocumentBody(sourceRef.current, body));
            } catch (error) {
              reportError(error);
              setEditorEpoch((epoch) => epoch + 1);
            }
          }}
          label={strings.body}
          documentId={documentIdentity}
          onLinkOpen={onLinkOpen}
          resolveEmbed={resolveEmbed}
          navigationTarget={navigationTarget}
          embedLabels={{ edit: strings.embedEdit, missing: strings.embedMissing }}
          slashLabels={strings.slashCommands}
          wikiLabels={{ footnote: strings.wikiFootnote, backlink: strings.wikiBacklink }}
          codeLabels={{ edit: strings.codeEdit, copy: strings.codeCopy, copied: strings.codeCopied }}
          unsupportedLabel={strings.unsupportedSource}
          lineSeparator={model.lineSeparator}
          tablePreviewLabel={strings.tablePreviewLabel}
          taskLabels={strings.taskTodo && strings.taskDone && strings.taskToggle
            ? { todo: strings.taskTodo, done: strings.taskDone, toggle: strings.taskToggle }
            : undefined}
        />
      </div>

      <details className="garden-document-disclosure">
        <summary>{strings.technicalFields}</summary>
        <dl>
          <ReadonlyProperty label={strings.format} value={envelope.format} />
          <ReadonlyProperty label={strings.bodyProfile} value={envelope.body} />
          <ReadonlyProperty label={strings.documentId} value={envelope.id} />
          <ReadonlyProperty label={strings.created} value={envelope.created} />
          <ReadonlyProperty label={strings.updated} value={envelope.updated} />
          {envelope.deleted !== undefined && <ReadonlyProperty label={strings.deleted} value={String(envelope.deleted)} />}
          {envelope.deleted_at !== undefined && <ReadonlyProperty label={strings.deletedAt} value={envelope.deleted_at as string} />}
        </dl>
      </details>

      <details className="garden-document-disclosure garden-document-source-disclosure">
        <summary>{strings.completeSource}</summary>
        <pre><code>{value}</code></pre>
      </details>
    </div>
  </section>;
}
