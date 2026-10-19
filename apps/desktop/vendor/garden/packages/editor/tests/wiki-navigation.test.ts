import {expect,test} from 'bun:test';
import {findMarkdownAnchor} from '../src/wiki-navigation.js';

test('heading references resolve visible headings, including inline marks and encoded spaces',()=>{
  const source='# Start\n\n## A **shared** foundation\n\nText.\n';
  const from=source.indexOf('## A');
  expect(findMarkdownAnchor(source,'#A%20shared%20foundation')).toEqual({from,to:source.indexOf('\n',from)});
  expect(findMarkdownAnchor(source,'a-shared-foundation')?.from).toBe(from);
  expect(findMarkdownAnchor(source,'#Missing')).toBeNull();
});

test('block references target explicit IDs and ignore code examples',()=>{
  const source='```md\nExample ^decision\n```\n\nReal decision. ^decision\n';
  const from=source.lastIndexOf('^decision');
  expect(findMarkdownAnchor(source,'#^decision')).toEqual({from,to:from+'^decision'.length});
  expect(findMarkdownAnchor(source,'#^missing')).toBeNull();
});
