import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import type { JsonValue, MarkdownDiagnostic } from '@garden/markdown';
import { MarkdownContractError } from '@garden/markdown';
import {
  convertDocumentProperty,
  editableDocumentPropertyKind,
  initialDocumentPropertyValue,
  parseDocumentSource,
  patchDocumentProperty,
  removeDocumentProperty,
} from './document-model.js';
import type { DocumentSourceModel, EditableDocumentPropertyKind } from './document-model.js';
import './document.css';

export interface GDocumentPropertiesStrings {
  title: string;
  titlePlaceholder: string;
  properties: string;
  tags: string;
  tagsPlaceholder: string;
  addTag: string;
  removeTag: string;
  valuePlaceholder: string;
  addValue: string;
  removeValue: string;
  aliases: string;
  aliasesPlaceholder: string;
  addAlias: string;
  removeAlias: string;
  profile: string;
  language: string;
  cssClasses: string;
  favorite: string;
  jsonValue: string;
  diagnostic: string;
  invalidSource: string;
  unsupportedSource: string;
  legacySource: string;
  propertyEditError: string;
  addProperty: string;
  propertyNamePlaceholder: string;
  propertyType: string;
  textType: string;
  numberType: string;
  booleanType: string;
  listType: string;
  createProperty: string;
  applyPropertyType: string;
  removeProperty: string;
  cancel: string;
}

export interface GDocumentPropertiesBaseProps {
  /** Canonical PDC Markdown source. */
  value: string;
  strings: GDocumentPropertiesStrings;
  /** Changing this value resets transient property-editor state. */
  documentId?: string;
}

export type GDocumentPropertiesProps = GDocumentPropertiesBaseProps & (
  | { readOnly: true; onChange?: (source: string) => void }
  | { readOnly?: false; onChange: (source: string) => void }
);

export interface GPropertyValueProps {
  /** A parsed PDC-compatible JSON value; rendering never changes the source. */
  value: JsonValue;
  strings: Pick<GDocumentPropertiesStrings, 'jsonValue'>;
  label?: string;
  /** Optional localized fallback for null, empty strings, and empty lists. */
  emptyValue?: string;
}

const TECHNICAL_FIELDS = new Set(['format', 'body', 'id', 'created', 'updated', 'deleted', 'deleted_at']);
const KNOWN_PROPERTIES = new Set([
  ...TECHNICAL_FIELDS,
  'title', 'profile', 'lang', 'tags', 'aliases', 'cssclasses', 'favorite',
]);
const OPTIONAL_PROPERTY_TYPES: Partial<Record<string, EditableDocumentPropertyKind>> = {
  profile: 'text',
  lang: 'text',
  tags: 'list',
  aliases: 'list',
  cssclasses: 'list',
  favorite: 'boolean',
};

function optionalPropertyKind(key: string): EditableDocumentPropertyKind | undefined {
  return Object.prototype.hasOwnProperty.call(OPTIONAL_PROPERTY_TYPES, key)
    ? OPTIONAL_PROPERTY_TYPES[key]
    : undefined;
}

function safeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function diagnosticPosition(diagnostic: MarkdownDiagnostic): string {
  return diagnostic.line === undefined ? '' : ` (${diagnostic.line}:${diagnostic.column ?? 1})`;
}

type PropertyIconKind = EditableDocumentPropertyKind | 'json';

function PropertyTypeIcon({ kind }: { kind: PropertyIconKind }) {
  return <svg className="garden-document-property-type-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    {kind === 'text' ? <path d="M3.5 4.25h9M8 4.25v7.5M5.75 11.75h4.5" />
      : kind === 'number' ? <path d="M4.5 4.25v7.5M3.5 6.25h2M8.5 4.25h3v3h-3v4.5h3" />
        : kind === 'boolean' ? <><rect x="3.25" y="3.25" width="9.5" height="9.5" rx="2" /><path d="m5.5 8 1.75 1.75L10.75 6" /></>
          : kind === 'list' ? <><circle cx="4" cy="5" r=".75" /><circle cx="4" cy="8" r=".75" /><circle cx="4" cy="11" r=".75" /><path d="M7 5h5.5M7 8h5.5M7 11h5.5" /></>
            : <path d="M6 3.5c-1.4 0-2 .8-2 2v1c0 .8-.35 1.25-1 1.5.65.25 1 .7 1 1.5v1c0 1.2.6 2 2 2M10 3.5c1.4 0 2 .8 2 2v1c0 .8.35 1.25 1 1.5-.65.25-1 .7-1 1.5v1c0 1.2-.6 2-2 2" />}
  </svg>;
}

function PropertyRow({
  label,
  kind,
  leading,
  children,
}: {
  label: string;
  kind: PropertyIconKind;
  leading?: ReactNode;
  children: ReactNode;
}) {
  return <div className="garden-document-property-row">
    <div className="garden-document-property-label-group">
      {leading ?? <span className="garden-document-property-static-icon"><PropertyTypeIcon kind={kind} /></span>}
      <div className="garden-document-property-label">{label}</div>
    </div>
    <div className="garden-document-property-value">{children}</div>
  </div>;
}

function StringListProperty({
  label,
  values,
  placeholder,
  removeLabel,
  onChange,
  readOnly = false,
}: {
  label?: string;
  values: string[];
  placeholder: string;
  removeLabel: string;
  onChange?: (next: string[]) => boolean;
  readOnly?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const listId = useId();
  const commitValue = () => {
    const nextValue = draft;
    if (!nextValue.trim() || values.includes(nextValue)) {
      if (nextValue || values.includes(nextValue)) setDraft('');
      return;
    }
    if (onChange?.([...values, nextValue])) setDraft('');
  };
  return <div className="garden-document-string-list" role={label ? 'group' : undefined} aria-label={label}>
    <ul className="garden-document-chips">
      {values.map((item, index) => <li key={`${item}-${index}`}>
        <span>{item}</span>
        {!readOnly && <button
          type="button"
          aria-label={`${removeLabel} ${item}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChange?.(values.filter((_, itemIndex) => itemIndex !== index))}
        >×</button>}
      </li>)}
    </ul>
    {!readOnly && <label className="garden-document-visually-hidden" htmlFor={listId}>{label}</label>}
    {!readOnly && <input
      id={listId}
      className="garden-document-string-input"
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          commitValue();
        }
      }}
      onBlur={commitValue}
    />}
  </div>;
}

function propertyTypeName(kind: EditableDocumentPropertyKind, strings: GDocumentPropertiesStrings): string {
  switch (kind) {
    case 'text': return strings.textType;
    case 'number': return strings.numberType;
    case 'boolean': return strings.booleanType;
    case 'list': return strings.listType;
  }
}

const PROPERTY_TYPE_OPTIONS: EditableDocumentPropertyKind[] = ['text', 'number', 'boolean', 'list'];

function PropertyTypePicker({
  label,
  value,
  strings,
  onChange,
  onCancel,
  pickerKey,
  activePickerKey,
  onOpen,
  onClose,
  disabled = false,
}: {
  label: string;
  value: EditableDocumentPropertyKind;
  strings: GDocumentPropertiesStrings;
  onChange: (value: EditableDocumentPropertyKind) => boolean | void;
  onCancel?: () => void;
  pickerKey: string;
  activePickerKey: string | null;
  onOpen: (pickerId: string) => void;
  onClose: () => void;
  disabled?: boolean;
}) {
  const pickerId = useId();
  const open = activePickerKey === pickerKey;
  const listboxId = `${pickerId}-options`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, PROPERTY_TYPE_OPTIONS.indexOf(value)));

  useEffect(() => {
    if (!open) return;
    setActiveIndex(Math.max(0, PROPERTY_TYPE_OPTIONS.indexOf(value)));
    listboxRef.current?.focus();
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent | FocusEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('focusin', dismissOutside);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('focusin', dismissOutside);
    };
  }, [open, onClose]);

  const close = (restoreFocus: boolean, cancelled = false) => {
    onClose();
    if (restoreFocus) triggerRef.current?.focus();
    if (cancelled) onCancel?.();
  };

  const selectKind = (kind: EditableDocumentPropertyKind) => {
    if (onChange(kind) !== false) close(true);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true, true);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((index) => (index + direction + PROPERTY_TYPE_OPTIONS.length) % PROPERTY_TYPE_OPTIONS.length);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActiveIndex(event.key === 'Home' ? 0 : PROPERTY_TYPE_OPTIONS.length - 1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectKind(PROPERTY_TYPE_OPTIONS[activeIndex]);
    }
  };

  const typeName = propertyTypeName(value, strings);

  return <div ref={pickerRef} className="garden-document-type-picker">
    <button
      ref={triggerRef}
      type="button"
      className="garden-document-property-type-toggle"
      aria-label={`${label} ${strings.propertyType}: ${typeName}`}
      aria-expanded={open}
      aria-controls={listboxId}
      aria-haspopup="listbox"
      title={`${strings.propertyType}: ${typeName}`}
      disabled={disabled}
      onClick={() => {
        if (open) close(true, true);
        else onOpen(pickerKey);
      }}
    ><PropertyTypeIcon kind={value} /></button>
    {open && <div
      id={listboxId}
      className="garden-document-type-editor"
      ref={listboxRef}
      role="listbox"
      aria-label={`${label} ${strings.propertyType}`}
      aria-activedescendant={`${pickerId}-option-${PROPERTY_TYPE_OPTIONS[activeIndex]}`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {PROPERTY_TYPE_OPTIONS.map((kind, index) => <div
        key={kind}
        id={`${pickerId}-option-${kind}`}
        className="garden-document-type-option"
        data-active={activeIndex === index ? 'true' : undefined}
        role="option"
        aria-selected={value === kind}
        onPointerMove={() => setActiveIndex(index)}
        onClick={() => selectKind(kind)}
      >
        <PropertyTypeIcon kind={kind} />
        <span>{propertyTypeName(kind, strings)}</span>
      </div>)}
    </div>}
  </div>;
}

export function GPropertyValue({ value, strings, label, emptyValue }: GPropertyValueProps) {
  if (emptyValue !== undefined
    && (value === null || value === '' || (Array.isArray(value) && value.length === 0))) {
    return <span>{emptyValue}</span>;
  }

  const kind = editableDocumentPropertyKind(value);
  if (kind === 'list') {
    return <StringListProperty
      label={label}
      values={value as string[]}
      placeholder=""
      removeLabel=""
      readOnly
    />;
  }
  if (kind !== null) return <span>{String(value)}</span>;

  return <details className="garden-document-json-disclosure">
    <summary>{strings.jsonValue}</summary>
    <pre className="garden-document-json-value"><code>{JSON.stringify(value, null, 2)}</code></pre>
  </details>;
}

function TypedPropertyEditor({
  label,
  value,
  strings,
  pickerKey,
  activePickerKey,
  onOpenPicker,
  onClosePicker,
  onChange,
  onRemove,
  onError,
  readOnly = false,
}: {
  label: string;
  value: JsonValue;
  strings: GDocumentPropertiesStrings;
  pickerKey: string;
  activePickerKey: string | null;
  onOpenPicker: (pickerId: string) => void;
  onClosePicker: () => void;
  onChange: (value: JsonValue) => boolean;
  onRemove: () => void;
  onError: (diagnostic: MarkdownDiagnostic | null) => void;
  readOnly?: boolean;
}) {
  const kind = editableDocumentPropertyKind(value);

  if (!kind) {
    return <PropertyRow label={label} kind="json">
      <GPropertyValue value={value} strings={strings} label={label} />
    </PropertyRow>;
  }

  if (readOnly) {
    return <PropertyRow label={label} kind={kind}>
      <GPropertyValue value={value} strings={strings} label={label} />
    </PropertyRow>;
  }

  return <PropertyRow
    label={label}
    kind={kind}
    leading={<PropertyTypePicker
      label={label}
      value={kind}
      strings={strings}
      pickerKey={pickerKey}
      activePickerKey={activePickerKey}
      onOpen={onOpenPicker}
      onClose={onClosePicker}
      onChange={(nextKind) => {
        try {
          const changed = onChange(convertDocumentProperty(value, nextKind));
          if (changed) onError(null);
          return changed;
        } catch (error) {
          const diagnostic = error instanceof MarkdownContractError
            ? error.diagnostic
            : { code: 'unsupported_lossless_edit' as const, message: error instanceof Error ? error.message : String(error) };
          onError(diagnostic);
          return false;
        }
      }}
      onCancel={() => onError(null)}
    />}
  >
    <div className="garden-document-typed-property">
      {kind === 'list' ? <StringListProperty
        label={label}
        values={value as string[]}
        placeholder={strings.valuePlaceholder}
        removeLabel={strings.removeValue}
        onChange={onChange}
      /> : kind === 'boolean' ? <input
        type="checkbox" data-slot="native-checkbox"
        aria-label={label}
        checked={value as boolean}
        onChange={(event) => onChange(event.currentTarget.checked)}
      /> : kind === 'number' ? <EditableNumber
        label={label}
        value={value as number}
        onChange={onChange}
        onError={onError}
      /> : <EditableString
        label={label}
        value={value as string}
        onChange={onChange}
        onError={onError}
      />}
      <div className="garden-document-property-tools">
        {kind ? <button
          type="button"
          className="garden-document-property-remove"
          aria-label={`${strings.removeProperty} ${label}`}
          title={strings.removeProperty}
          onClick={onRemove}
        >×</button> : null}
      </div>
    </div>
  </PropertyRow>;
}

function EditableString({
  label,
  value,
  onChange,
  onError,
  validateOnBlur = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => boolean;
  onError: (diagnostic: MarkdownDiagnostic | null) => void;
  validateOnBlur?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <input
    aria-label={label}
    value={draft}
    onChange={(event) => {
      const next = event.currentTarget.value;
      setDraft(next);
      onError(null);
      if (!validateOnBlur && !onChange(next)) setDraft(value);
    }}
    onBlur={() => {
      if (validateOnBlur && draft !== value && !onChange(draft)) setDraft(value);
    }}
  />;
}

function EditableNumber({
  label,
  value,
  onChange,
  onError,
}: {
  label: string;
  value: number;
  onChange: (value: number) => boolean;
  onError: (diagnostic: MarkdownDiagnostic | null) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <input
    aria-label={label}
    type="text"
    inputMode="decimal"
    value={draft}
    onChange={(event) => {
      setDraft(event.currentTarget.value);
      onError(null);
    }}
    onBlur={() => {
      if (!draft.trim()) {
        setDraft(String(value));
        onError({ code: 'invalid_envelope', message: 'A number is required.' });
        return;
      }
      const parsed = Number(draft);
      if (!Number.isFinite(parsed)) {
        setDraft(String(value));
        onError({ code: 'invalid_envelope', message: 'Enter a finite number.' });
        return;
      }
      if (parsed !== value && !onChange(parsed)) setDraft(String(value));
    }}
  />;
}

export function GDocumentProperties({
  value,
  onChange,
  strings,
  documentId,
  readOnly = false,
}: GDocumentPropertiesProps) {
  const model = parseDocumentSource(value);
  const identity = documentId ?? (model.editable ? model.document.envelope.id : value);
  return <DocumentPropertiesView
    key={identity}
    value={value}
    onChange={onChange}
    strings={strings}
    model={model}
    readOnly={readOnly}
  />;
}

function DocumentPropertiesView({
  value,
  onChange,
  strings,
  model,
  readOnly,
}: GDocumentPropertiesBaseProps & {
  onChange?: (source: string) => void;
  model: DocumentSourceModel;
  readOnly: boolean;
}) {
  const id = useId();
  const sourceRef = useRef(value);
  sourceRef.current = value;
  const [editDiagnostic, setEditDiagnostic] = useState<MarkdownDiagnostic | null>(null);
  const [addingProperty, setAddingProperty] = useState(false);
  const [propertyDraft, setPropertyDraft] = useState('');
  const [propertyDraftKind, setPropertyDraftKind] = useState<EditableDocumentPropertyKind>('text');
  const [activePickerKey, setActivePickerKey] = useState<string | null>(null);

  const publish = (next: string): boolean => {
    if (readOnly || next === sourceRef.current) return !readOnly;
    sourceRef.current = next;
    setEditDiagnostic(null);
    onChange?.(next);
    return true;
  };

  const reportError = (error: unknown) => {
    const diagnostic = error instanceof MarkdownContractError
      ? error.diagnostic
      : { code: 'unsupported_lossless_edit' as const, message: error instanceof Error ? error.message : String(error) };
    setEditDiagnostic(diagnostic);
    return diagnostic;
  };

  const editProperty = (key: string, next: JsonValue | undefined): boolean => {
    if (readOnly) return false;
    try {
      return publish(patchDocumentProperty(sourceRef.current, key, next));
    } catch (error) {
      reportError(error);
      return false;
    }
  };

  const propertyId = (key: string) => id + '-' + safeIdPart(key);
  const showDiagnostic = (diagnostic: MarkdownDiagnostic | null) => {
    if (!diagnostic) return null;
    return <p className="garden-document-diagnostic garden-document-edit-error" role="alert">
      {strings.propertyEditError} <span>{strings.diagnostic}: <code>{diagnostic.code}</code>{diagnosticPosition(diagnostic)}</span>
    </p>;
  };

  if (!model.editable) {
    const stateLabel = model.result.kind === 'legacy'
      ? strings.legacySource
      : model.result.kind === 'read_only'
        ? strings.unsupportedSource
        : strings.invalidSource;
    return <div className="garden-document-properties-component" aria-label={strings.properties}>
      <p className="garden-document-diagnostic" role="status">
        {stateLabel} <span>{strings.diagnostic}: <code>{model.diagnostic.code}</code>{diagnosticPosition(model.diagnostic)}</span>
      </p>
      <pre className="garden-document-source-readonly"><code>{value}</code></pre>
    </div>;
  }

  const envelope = model.document.envelope;
  const sourcePropertyRows = Object.entries(envelope).filter(([key]) => !KNOWN_PROPERTIES.has(key));
  const forcedPropertyKind = optionalPropertyKind(propertyDraft);
  const createProperty = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key = propertyDraft;
    const requiredKind = optionalPropertyKind(key);
    if (!key.trim()) return;
    if (Object.prototype.hasOwnProperty.call(envelope, key)) {
      reportError(new MarkdownContractError({ code: 'invalid_envelope', message: 'The ' + key + ' property already exists.' }));
      return;
    }
    if (TECHNICAL_FIELDS.has(key) || key === 'title') {
      reportError(new MarkdownContractError({ code: 'unsupported_lossless_edit', message: 'The ' + key + ' field is managed by the document editor.' }));
      return;
    }
    if (requiredKind && requiredKind !== propertyDraftKind) {
      reportError(new MarkdownContractError({ code: 'invalid_envelope', message: 'The ' + key + ' property must use its PDC type.' }));
      return;
    }
    try {
      publish(patchDocumentProperty(
        sourceRef.current,
        key,
        initialDocumentPropertyValue(propertyDraftKind),
      ));
      setPropertyDraft('');
      setPropertyDraftKind('text');
      setAddingProperty(false);
      setActivePickerKey(null);
    } catch (error) {
      reportError(error);
    }
  };

  return <div className="garden-document-properties-component">
    <div className="garden-document-title-row">
      {readOnly
        ? <div className="garden-document-title" aria-label={strings.title}>{envelope.title}</div>
        : <>
          <label className="garden-document-visually-hidden" htmlFor={propertyId('title')}>{strings.title}</label>
          <input
            id={propertyId('title')}
            className="garden-document-title"
            value={envelope.title}
            placeholder={strings.titlePlaceholder}
            onChange={(event) => editProperty('title', event.currentTarget.value)}
          />
        </>}
    </div>

    <section className="garden-document-properties" aria-label={strings.properties}>
      <h2>{strings.properties}</h2>
      <PropertyRow label={strings.tags} kind="list">
        <StringListProperty
          label={strings.tags}
          values={Array.isArray(envelope.tags) ? envelope.tags as string[] : []}
          placeholder={strings.tagsPlaceholder}
          removeLabel={strings.removeTag}
          readOnly={readOnly}
          onChange={(next) => editProperty('tags', next)}
        />
      </PropertyRow>
      <PropertyRow label={strings.aliases} kind="list">
        <StringListProperty
          label={strings.aliases}
          values={Array.isArray(envelope.aliases) ? envelope.aliases as string[] : []}
          placeholder={strings.aliasesPlaceholder}
          removeLabel={strings.removeAlias}
          readOnly={readOnly}
          onChange={(next) => editProperty('aliases', next)}
        />
      </PropertyRow>
      {envelope.profile !== undefined && <PropertyRow label={strings.profile} kind="text">
        {readOnly
          ? <span>{envelope.profile as string}</span>
          : <EditableString
            label={strings.profile}
            value={envelope.profile as string}
            validateOnBlur
            onChange={(next) => editProperty('profile', next)}
            onError={setEditDiagnostic}
          />}
      </PropertyRow>}
      {envelope.lang !== undefined && <PropertyRow label={strings.language} kind="text">
        {readOnly
          ? <span>{envelope.lang as string}</span>
          : <EditableString
            label={strings.language}
            value={envelope.lang as string}
            validateOnBlur
            onChange={(next) => editProperty('lang', next)}
            onError={setEditDiagnostic}
          />}
      </PropertyRow>}
      {envelope.cssclasses !== undefined && <PropertyRow label={strings.cssClasses} kind="list">
        <StringListProperty
          label={strings.cssClasses}
          values={envelope.cssclasses as string[]}
          placeholder={strings.valuePlaceholder}
          removeLabel={strings.removeValue}
          readOnly={readOnly}
          onChange={(next) => editProperty('cssclasses', next)}
        />
      </PropertyRow>}
      {envelope.favorite !== undefined && <PropertyRow label={strings.favorite} kind="boolean">
        {readOnly
          ? <span>{String(envelope.favorite)}</span>
          : <input
            type="checkbox" data-slot="native-checkbox"
            aria-label={strings.favorite}
            checked={envelope.favorite as boolean}
            onChange={(event) => editProperty('favorite', event.currentTarget.checked)}
          />}
      </PropertyRow>}
      {sourcePropertyRows.map(([key, propertyValue]) => <TypedPropertyEditor
        key={key}
        label={key}
        value={propertyValue}
        strings={strings}
        pickerKey={'property:' + key}
        activePickerKey={activePickerKey}
        onOpenPicker={setActivePickerKey}
        onClosePicker={() => setActivePickerKey(null)}
        onChange={(next) => editProperty(key, next)}
        onRemove={() => {
          setActivePickerKey(null);
          try {
            publish(removeDocumentProperty(sourceRef.current, key));
          } catch (error) {
            reportError(error);
          }
        }}
        onError={setEditDiagnostic}
        readOnly={readOnly}
      />)}
      {!readOnly && <div className="garden-document-add-property">
        <button
          type="button"
          className="garden-document-add-property-toggle"
          aria-expanded={addingProperty}
          aria-controls={id + '-add-property'}
          onClick={() => {
            setActivePickerKey(null);
            if (addingProperty) {
              setAddingProperty(false);
              setPropertyDraft('');
              setPropertyDraftKind('text');
            } else {
              setAddingProperty(true);
            }
            setEditDiagnostic(null);
          }}
        >{strings.addProperty}</button>
        {addingProperty && <form
          id={id + '-add-property'}
          className="garden-document-add-property-form"
          onSubmit={createProperty}
        >
          <div className="garden-document-add-property-input-row">
            <PropertyTypePicker
              label={propertyDraft || strings.propertyNamePlaceholder}
              value={forcedPropertyKind ?? propertyDraftKind}
              pickerKey="new-property-type"
              activePickerKey={activePickerKey}
              onOpen={setActivePickerKey}
              onClose={() => setActivePickerKey(null)}
              onChange={(kind) => {
                setPropertyDraftKind(kind);
                setEditDiagnostic(null);
                return true;
              }}
              strings={strings}
              disabled={forcedPropertyKind !== undefined}
            />
            <label className="garden-document-visually-hidden" htmlFor={id + '-property-name'}>{strings.propertyNamePlaceholder}</label>
            <input
              id={id + '-property-name'}
              autoFocus
              autoComplete="off"
              value={propertyDraft}
              placeholder={strings.propertyNamePlaceholder}
              onChange={(event) => {
                const key = event.currentTarget.value;
                setPropertyDraft(key);
                const requiredKind = optionalPropertyKind(key);
                if (requiredKind) setPropertyDraftKind(requiredKind);
                setEditDiagnostic(null);
              }}
            />
          </div>
          <button type="submit" disabled={!propertyDraft.trim()}>{strings.createProperty}</button>
          <button type="button" onClick={() => {
            setActivePickerKey(null);
            setAddingProperty(false);
            setPropertyDraft('');
            setPropertyDraftKind('text');
            setEditDiagnostic(null);
          }}>{strings.cancel}</button>
        </form>}
      </div>}
    </section>
    {showDiagnostic(editDiagnostic)}
  </div>;
}
