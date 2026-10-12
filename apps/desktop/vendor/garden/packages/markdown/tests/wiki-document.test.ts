import {expect,test} from 'bun:test';
import {createMarkdownDocument,parseMarkdownDocument} from '../src/index.js';

function document(body:string) {
  return createMarkdownDocument({title:'Wiki',id:'01998ce5-1200-7000-8000-000000000021',created:'2026-09-27T00:00:00.000Z',body});
}

test('wiki documents retain source and ignore example IDs inside code and comments',()=>{
  const body='A target. ^decision\n\n`Example ^decision`\n\n%%Example ^decision%%\n\n```md\nExample ^decision\n```\n';
  const parsed=parseMarkdownDocument(document(body));
  expect(parsed.kind).toBe('markdown');
  if(parsed.kind==='markdown')expect(parsed.body).toBe(body);
});

test('standalone caret IDs participate in the same duplicate target check',()=>{
  expect(()=>document('First. ^same\n\nSecond.\n\n^same\n')).toThrow('duplicate');
});

test('HTML comments, text, data-id, and quoted attribute contents are not block targets',()=>{
  const id='b-01998ce5-1200-7000-8000-000000000021';
  const body=[
    `<div data-id="${id}" title="literal id='${id}' > still title">`,
    `<!-- <span id="${id}">commented out</span> -->`,
    `<pre>id="${id}"</pre>`,
    '</div>',
    '',
    `Real target. ^${id}`,
  ].join('\n');

  expect(parseMarkdownDocument(document(body)).kind).toBe('markdown');
});

test('nested HTML start-tag IDs still collide with caret targets',()=>{
  const id='b-01998ce5-1200-7000-8000-000000000021';
  const body=`<div>\n<section><span id="${id}">target</span></section>\n</div>\n\nReal target. ^${id}`;

  expect(()=>document(body)).toThrow('duplicate');
});
