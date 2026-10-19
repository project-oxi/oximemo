import { wikiPreview } from './wiki-preview.js';
import { envelopeSyntax } from './envelope-syntax.js';
import { useEffect, useRef } from 'react';
import { Annotation, Compartment, EditorSelection, EditorState, Prec, Transaction } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, commonmarkLanguage } from '@codemirror/lang-markdown';
import { gardenMarkdownConfig } from '@garden/markdown/syntax';
import { atomicEditorTheme, atomicMarkdownSyntax, readOnlyFacet } from '@atomic-editor/editor';
import { tablePreview } from './table-preview.js';
import { continueTaskOnEnter, removeTaskPrefixOnBackspace, toggleOrCreateTask } from './task-editing.js';
import { taskField, type TaskLabels } from './task-field.js';
import { gardenInlinePreview } from './garden-inline-preview.js';
import { codePreview, type CodePreviewLabels } from './code-preview.js';
import { embedPreview, embedPreviewRefreshEffect, type EmbedResource } from './embed-preview.js';
import { slashCommands, type SlashCommandLabels } from './slash-commands.js';
import { findMarkdownAnchor, type MarkdownNavigationTarget } from './wiki-navigation.js';

export interface GMarkdownEditorProps {
  value: string;
  onChange: (source: string) => void;
  label: string;
  readOnly?: boolean;
  /** Change identity to reset selection/history when switching documents. */
  documentId?: string;
  className?: string;
  onLinkOpen?: (url: string) => void;
  onSave?: () => void;
  unsupportedLabel: string;
  /** Accessible label for the table preview control; falls back to its header text. */
  tablePreviewLabel?: string;
  /** Preserve the owning document's separator when this editor receives only a body slice. */
  lineSeparator?: '\n' | '\r\n';
  /** Localized accessible task status labels; visible status enums are TODO and DONE. */
  taskLabels?: TaskLabels;
  codeLabels?: Partial<CodePreviewLabels>;
  embedLabels?: { edit?: string; missing?: string };
  slashLabels?: SlashCommandLabels;
  wikiLabels?: {footnote?: string; backlink?: string};
  navigationTarget?: MarkdownNavigationTarget;
  /** Host resolves vault-contained references to authorized URLs or source. */
  resolveEmbed?: (reference: string) => EmbedResource | undefined;
}
const externalChange = Annotation.define<boolean>();
function routeLink(onOpen:(url:string)=>void, url:string) {
 const normalized=url.replace(/[\u0000-\u0020\u007f]/g,'');
 if (/^[a-z][a-z\d+.-]*:/i.test(normalized) && !/^(?:https?|pdc):/i.test(normalized)) return;
 onOpen(url);
}
function preview(onOpen:(url:string)=>void, tablePreviewLabel?:string) {
 return [gardenInlinePreview({onLinkClick:url=>routeLink(onOpen,url)}),tablePreview(tablePreviewLabel)];
}
function hasMixedEndings(source: string) { return source.includes('\r\n') && /(^|[^\r])\n/.test(source); }
const taskKeymap=Prec.highest(keymap.of([
 {key:'Enter',run:(view:EditorView)=>{const transaction=continueTaskOnEnter(view.state);if(!transaction)return false;view.dispatch(transaction);return true;}},
 {key:'Backspace',run:(view:EditorView)=>{const transaction=removeTaskPrefixOnBackspace(view.state);if(!transaction)return false;view.dispatch(transaction);return true;}},
 {key:'Mod-Enter',run:(view:EditorView)=>{const transaction=toggleOrCreateTask(view.state);if(!transaction)return false;view.dispatch(transaction);return true;}},
]));

/** Source is canonical. Preview widgets construct safe DOM and never serialize back to Markdown. */
export function GMarkdownEditor({value,onChange,label,readOnly=false,documentId='',className,onLinkOpen,onSave,unsupportedLabel,tablePreviewLabel,taskLabels,codeLabels,embedLabels,slashLabels,wikiLabels,navigationTarget,resolveEmbed,lineSeparator:requestedLineSeparator}:GMarkdownEditorProps) {
  const mount=useRef<HTMLDivElement>(null), viewRef=useRef<EditorView|null>(null);
  const callbacks=useRef({onChange,onLinkOpen,onSave,resolveEmbed}); callbacks.current={onChange,onLinkOpen,onSave,resolveEmbed};
  const latestValue=useRef(value);latestValue.current=value;
  const readOnlyConfig=useRef(new Compartment()), labelConfig=useRef(new Compartment()), previewConfig=useRef(new Compartment()), taskConfig=useRef(new Compartment());
  const slashConfig=useRef(new Compartment());
  // Emptying a CRLF document must not remount the editor and erase its undo history.
  const documentFormat=useRef({id:documentId,separator:requestedLineSeparator??(value.includes('\r\n')?'\r\n':'\n')});
  if(documentFormat.current.id!==documentId) documentFormat.current={id:documentId,separator:requestedLineSeparator??(value.includes('\r\n')?'\r\n':'\n')};
  const lineSeparator=requestedLineSeparator??documentFormat.current.separator;
  const previewAllowed=!readOnly;
  const buildPreview=()=>[
    wikiPreview({onLinkOpen:target=>routeLink(link=>callbacks.current.onLinkOpen?.(link),target),footnoteLabel:label=>`${wikiLabels?.footnote??'Footnote'} ${label}`,footnoteBacklinkLabel:(label,index,total)=>`${wikiLabels?.backlink??'Back to reference'} ${label}${total>1?` (${index}/${total})`:''}`}),
    ...preview(url=>callbacks.current.onLinkOpen?.(url),tablePreviewLabel),
    codePreview({copy:codeLabels?.copy??'Copy code',copied:codeLabels?.copied??'Copied',edit:codeLabels?.edit??'Edit code'}),
    embedPreview({resolve:reference=>callbacks.current.resolveEmbed?.(reference),onLinkOpen:url=>routeLink(link=>callbacks.current.onLinkOpen?.(link),url),editLabel:embedLabels?.edit,missingLabel:embedLabels?.missing}),
  ];
  const sourceFallback=hasMixedEndings(value) || /\r(?!\n)/.test(value);
  useEffect(()=>{
    if(!mount.current || sourceFallback) return;
    const initial=latestValue.current;
    const view=new EditorView({parent:mount.current,state:EditorState.create({doc:initial,extensions:[
      EditorState.lineSeparator.of(lineSeparator),
      readOnlyConfig.current.of([EditorState.readOnly.of(readOnly),EditorView.editable.of(!readOnly),readOnlyFacet.of(readOnly)]),
      labelConfig.current.of(EditorView.contentAttributes.of({'aria-label':label})),
      history(),drawSelection(),keymap.of([...historyKeymap,...defaultKeymap,{key:'Mod-s',run:()=>{callbacks.current.onSave?.();return Boolean(callbacks.current.onSave);}}]),
      markdown({base:commonmarkLanguage,extensions:[envelopeSyntax,gardenMarkdownConfig]}),atomicMarkdownSyntax,atomicEditorTheme,
      slashConfig.current.of(slashCommands(slashLabels)),
      taskKeymap,taskConfig.current.of(readOnly?[]:taskField(taskLabels)),
      previewConfig.current.of(previewAllowed?buildPreview():[]),
      EditorView.lineWrapping,
      EditorView.updateListener.of(update=>{
        if(update.docChanged && !update.transactions.some(transaction=>transaction.annotation(externalChange))) callbacks.current.onChange(update.state.sliceDoc());
      }),
    ]})});
    viewRef.current=view;
    return ()=>{viewRef.current=null;view.destroy();};
  },[documentId,sourceFallback,lineSeparator]);
  useEffect(()=>{
    const view=viewRef.current;if(!view)return;
    if(view.state.sliceDoc()!==value) view.dispatch({changes:{from:0,to:view.state.doc.length,insert:value},annotations:[externalChange.of(true),Transaction.addToHistory.of(false)]});
  },[value]);
  useEffect(()=>{viewRef.current?.dispatch({effects:[readOnlyConfig.current.reconfigure([EditorState.readOnly.of(readOnly),EditorView.editable.of(!readOnly),readOnlyFacet.of(readOnly)]),labelConfig.current.reconfigure(EditorView.contentAttributes.of({'aria-label':label}))]});},[readOnly,label]);
  useEffect(()=>{viewRef.current?.dispatch({effects:previewConfig.current.reconfigure(previewAllowed?buildPreview():[])});},[previewAllowed,tablePreviewLabel,codeLabels?.copy,codeLabels?.copied,codeLabels?.edit,embedLabels?.edit,embedLabels?.missing,wikiLabels?.footnote,wikiLabels?.backlink]);
  useEffect(()=>{viewRef.current?.dispatch({effects:taskConfig.current.reconfigure(readOnly?[]:taskField(taskLabels))});},[readOnly,taskLabels?.todo,taskLabels?.done,taskLabels?.toggle]);
  useEffect(()=>{viewRef.current?.dispatch({effects:embedPreviewRefreshEffect.of(null)});},[resolveEmbed]);
  useEffect(()=>{viewRef.current?.dispatch({effects:slashConfig.current.reconfigure(slashCommands(slashLabels))});},[slashLabels]);
  useEffect(()=>{
    const editor=viewRef.current;
    if(!editor || !navigationTarget)return;
    const range=findMarkdownAnchor(editor.state.doc.toString(),navigationTarget.anchor);
    if(range){editor.dispatch({selection:EditorSelection.cursor(range.from),scrollIntoView:true});editor.focus();}
  },[documentId,navigationTarget?.anchor,navigationTarget?.requestId]);
  if(sourceFallback) return <div className={className}><p role="status">{unsupportedLabel}</p><textarea aria-label={label} value={value} readOnly /></div>;
  return <div ref={mount} className={['garden-markdown-editor','atomic-cm-editor',className].filter(Boolean).join(' ')} />;
}
