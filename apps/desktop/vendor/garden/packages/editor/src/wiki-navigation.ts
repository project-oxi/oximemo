import { gardenMarkdownParser } from '@garden/markdown/syntax';

export interface MarkdownNavigationTarget {
  anchor: string;
  requestId?: number;
}

/** Resolve a local heading or caret target without changing document text. */
export function findMarkdownAnchor(source: string, fragment: string): {from:number;to:number}|null {
  let anchor = fragment.replace(/^#/, '');
  try { anchor = decodeURIComponent(anchor); } catch { /* A literal percent remains valid heading text. */ }
  const normalize = (text:string) => text.trim().normalize('NFC').toLowerCase().replace(/\s+/g, ' ');
  const wanted = normalize(anchor);
  if (!wanted) return null;
  let result: {from:number;to:number}|null = null;
  gardenMarkdownParser.parse(source).iterate({enter(node) {
    if (result) return false;
    if (anchor.startsWith('^')) {
      if (node.name === 'GardenBlockId' && source.slice(node.from,node.to) === anchor) result={from:node.from,to:node.to};
      return;
    }
    if (!/^(ATX|Setext)Heading[1-6]$/.test(node.name)) return;
    const parts:string[]=[];
    let cursor=node.from;
    node.node.toTree().iterate({enter(child) {
      if (!/(?:Mark|GardenBlockId)$/.test(child.name)) return;
      const from=node.from+child.from, to=node.from+child.to;
      if (from>=cursor) {parts.push(source.slice(cursor,from));cursor=to;}
    }});
    parts.push(source.slice(cursor,node.to));
    const label=normalize(parts.join('').replace(/\\([\\`*_{}\[\]()#+.!-])/g,'$1'));
    if(label===wanted || label.replace(/ /g,'-')===wanted) result={from:node.from,to:node.to};
    return false;
  }});
  return result;
}
