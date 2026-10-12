import {
  MarkdownContractError,
  parseMarkdownDocument,
  patchMarkdownEnvelope,
  type JsonValue,
  type MarkdownDiagnostic,
  type MarkdownDocument,
  type MarkdownReadResult,
} from '@garden/markdown';

export type DocumentPropertyKind = 'string' | 'number' | 'boolean' | 'string-list' | 'json';
export type EditableDocumentPropertyKind = 'text' | 'number' | 'boolean' | 'list';

export type DocumentSourceModel =
  | { editable: true; document: MarkdownDocument; prefix: string; lineSeparator: '\n' | '\r\n' }
  | { editable: false; result: MarkdownReadResult; diagnostic: MarkdownDiagnostic };

function lineSeparatorOf(source: string): '\n' | '\r\n' | null {
  const hasCrLf = source.includes('\r\n');
  const hasLf = /(^|[^\r])\n/.test(source);
  if (/\r(?!\n)/.test(source) || (hasCrLf && hasLf)) return null;
  return hasCrLf ? '\r\n' : '\n';
}

export function parseDocumentSource(source: string): DocumentSourceModel {
  const lineSeparator = lineSeparatorOf(source);
  const result = parseMarkdownDocument(source);
  if (lineSeparator === null) {
    return {
      editable: false,
      result,
      diagnostic: {
        code: 'invalid_transport',
        message: 'Mixed or isolated carriage-return line endings are read-only so edits cannot normalize the source.',
      },
    };
  }
  if (result.kind !== 'markdown') {
    return { editable: false, result, diagnostic: result.diagnostic };
  }
  return {
    editable: true,
    document: result,
    prefix: source.slice(0, source.length - result.body.length),
    lineSeparator,
  };
}

function requireEditable(source: string): MarkdownDocument {
  const model = parseDocumentSource(source);
  if (!model.editable) throw new MarkdownContractError(model.diagnostic);
  return model.document;
}

function changedTimestamp(previous: string, now: Date): string {
  const previousTime = Date.parse(previous);
  const nextTime = Math.max(now.getTime(), Number.isFinite(previousTime) ? previousTime + 1 : 0);
  return new Date(nextTime).toISOString();
}

export function patchDocumentProperty(
  source: string,
  key: string,
  value: JsonValue | undefined,
  now = new Date(),
): string {
  const document = requireEditable(source);
  if (key === 'format' || key === 'body' || key === 'id' || key === 'created' || key === 'updated' || key === 'deleted' || key === 'deleted_at') {
    throw new MarkdownContractError({
      code: 'unsupported_lossless_edit',
      message: `The ${key} field is managed as a technical field and cannot be changed in the property editor.`,
    });
  }
  if (key === '__proto__') {
    throw new MarkdownContractError({
      code: 'unsupported_lossless_edit',
      message: `The ${key} property cannot be edited safely through the property editor.`,
    });
  }
  if (JSON.stringify(document.envelope[key]) === JSON.stringify(value)) return source;
  return patchMarkdownEnvelope(source, {
    [key]: value,
    updated: changedTimestamp(document.envelope.updated, now),
  }, source);
}

export function patchDocumentBody(source: string, body: string, now = new Date()): string {
  const model = parseDocumentSource(source);
  if (!model.editable) throw new MarkdownContractError(model.diagnostic);
  if (body === model.document.body) return source;
  const updatedSource = patchMarkdownEnvelope(source, {
    updated: changedTimestamp(model.document.envelope.updated, now),
  }, source);
  const prefix = updatedSource.slice(0, updatedSource.length - model.document.body.length);
  const nextSource = `${prefix}${body}`;
  if (lineSeparatorOf(nextSource) !== model.lineSeparator) {
    throw new MarkdownContractError({
      code: 'invalid_transport',
      message: 'The edit introduced mixed line endings; the source was left unchanged.',
    });
  }
  const next = parseMarkdownDocument(nextSource);
  if (next.kind !== 'markdown') throw new MarkdownContractError(next.diagnostic);
  return nextSource;
}

export function documentPropertyKind(value: JsonValue): DocumentPropertyKind {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return 'string-list';
  return 'json';
}

export function editableDocumentPropertyKind(value: JsonValue): EditableDocumentPropertyKind | null {
  switch (documentPropertyKind(value)) {
    case 'string': return 'text';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'string-list': return 'list';
    case 'json': return null;
  }
}

function unsupportedConversion(value: JsonValue, target: EditableDocumentPropertyKind): never {
  throw new MarkdownContractError({
    code: 'unsupported_lossless_edit',
    message: `This value cannot be converted to ${target} without losing information.`,
  });
}

/**
 * Convert a scalar or string-list property only when its value has a clear,
 * reversible representation in the requested editor type. The caller must
 * make the type change explicit; structured JSON remains a read-only fallback.
 */
export function convertDocumentProperty(
  value: JsonValue,
  target: EditableDocumentPropertyKind,
): JsonValue {
  const current = editableDocumentPropertyKind(value);
  if (current === null) return unsupportedConversion(value, target);
  if (current === target) return value;

  if (target === 'text') {
    if (typeof value === 'number') {
      if (Object.is(value, -0)) return unsupportedConversion(value, target);
      return String(value);
    }
    if (typeof value === 'boolean') return String(value);
    if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') return value[0];
    return unsupportedConversion(value, target);
  }

  if (target === 'number' && typeof value === 'string') {
    const parsed = Number(value);
    if (value.trim() !== '' && Number.isFinite(parsed) && String(parsed) === value) return parsed;
    return unsupportedConversion(value, target);
  }

  if (target === 'boolean' && typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return unsupportedConversion(value, target);
  }

  if (target === 'list' && typeof value === 'string') return [value];
  return unsupportedConversion(value, target);
}

export function initialDocumentPropertyValue(kind: EditableDocumentPropertyKind): JsonValue {
  switch (kind) {
    case 'text': return '';
    case 'number': return 0;
    case 'boolean': return false;
    case 'list': return [];
  }
}

export function removeDocumentProperty(source: string, key: string, now = new Date()): string {
  const document = requireEditable(source);
  if (key === 'format' || key === 'body' || key === 'id' || key === 'created' || key === 'updated' || key === 'deleted' || key === 'deleted_at') {
    throw new MarkdownContractError({
      code: 'unsupported_lossless_edit',
      message: `The ${key} field is managed as a technical field and cannot be removed in the property editor.`,
    });
  }
  if (!Object.prototype.hasOwnProperty.call(document.envelope, key)) return source;
  return patchMarkdownEnvelope(source, {
    [key]: undefined,
    updated: changedTimestamp(document.envelope.updated, now),
  }, source);
}
