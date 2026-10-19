import {test,expect} from 'bun:test';
import {parser} from '@lezer/markdown';
import {envelopeSyntax} from '../src/envelope-syntax';
const markdown=parser.configure(envelopeSyntax);
test('frontmatter stays source while the following body still parses as Markdown',()=>{
 const source='---\ntitle: A note\ntags: [one]\n---\n\n# Body\n';
 const tree=markdown.parse(source);
 expect(tree.topNode.firstChild?.name).toBe('GardenEnvelope');
 expect(tree.topNode.firstChild?.to).toBe(source.indexOf('\n\n'));
 expect(tree.topNode.lastChild?.name).toBe('ATXHeading1');
});
test('an unfinished envelope remains visible source without consuming a later document',()=>{
 const source='---\ntitle: unfinished\n';
 const tree=markdown.parse(source);
 expect(tree.topNode.firstChild?.name).toBe('GardenEnvelope');
 expect(tree.topNode.firstChild?.nextSibling).toBe(null);
 expect(markdown.parse('# Ordinary Markdown').topNode.firstChild?.name).toBe('ATXHeading1');
});
