import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'bun:test';
import {
  GDocumentProperties,
  GPropertyValue,
  type GDocumentPropertiesStrings,
} from '../src/index.js';

const strings: GDocumentPropertiesStrings = {
  title: 'Title',
  titlePlaceholder: 'Untitled',
  properties: 'Properties',
  tags: 'Tags',
  tagsPlaceholder: 'Add tag',
  addTag: 'Add tag',
  removeTag: 'Remove tag',
  valuePlaceholder: 'Add value',
  addValue: 'Add value',
  removeValue: 'Remove value',
  aliases: 'Aliases',
  aliasesPlaceholder: 'Add alias',
  addAlias: 'Add alias',
  removeAlias: 'Remove alias',
  profile: 'Profile',
  language: 'Language',
  cssClasses: 'CSS classes',
  favorite: 'Favorite',
  jsonValue: 'JSON value',
  diagnostic: 'Diagnostic',
  invalidSource: 'Invalid source',
  unsupportedSource: 'Unsupported source',
  legacySource: 'Legacy source',
  propertyEditError: 'Could not edit this property.',
  addProperty: 'Add property',
  propertyNamePlaceholder: 'Property name',
  propertyType: 'Property type',
  textType: 'Text',
  numberType: 'Number',
  booleanType: 'Checkbox',
  listType: 'List',
  createProperty: 'Create property',
  applyPropertyType: 'Apply type',
  removeProperty: 'Remove property',
  cancel: 'Cancel',
};

function canonicalSource(): string {
  return [
    '---',
    'format: pdc-document/2',
    'body: pdc-markdown/1',
    'id: 018f47c6-4a77-7c52-9db8-0e5f9bcb17db',
    'created: 2026-09-27T11:00:00.000Z',
    'updated: 2026-09-27T11:00:00.000Z',
    'title: Property sheet',
    'tags: [garden, pdc]',
    'status: needs review',
    'details: { owner: Garden, revision: 4 }',
    '---',
    '# Body source remains canonical',
    '',
  ].join('\n');
}

test('the public editable properties component renders supported values and structured fallbacks', () => {
  const markup = renderToStaticMarkup(createElement(GDocumentProperties, {
    value: canonicalSource(),
    onChange: () => undefined,
    strings,
  }));

  expect(markup).toContain('Property sheet');
  expect(markup).toContain('needs review');
  expect(markup).toContain('garden-document-property-type-toggle');
  expect(markup).toContain('garden-document-add-property-toggle');
  expect(markup).toContain('JSON value');
  expect(markup).toContain('Garden');
});

test('read-only properties can omit onChange and expose no editing controls', () => {
  const markup = renderToStaticMarkup(createElement(GDocumentProperties, {
    value: canonicalSource(),
    strings,
    readOnly: true,
  }));

  expect(markup).toContain('Property sheet');
  expect(markup).toContain('garden');
  expect(markup).toContain('needs review');
  expect(markup).toContain('Garden');
  expect(markup).not.toContain('<input');
  expect(markup).not.toContain('<button');
});

test('GPropertyValue keeps scalars readable, string lists compact, and nested values explicit', () => {
  const scalar = renderToStaticMarkup(createElement(GPropertyValue, { value: 7, strings }));
  const list = renderToStaticMarkup(createElement(GPropertyValue, { value: ['garden', 'pdc'], strings, label: 'Topics' }));
  const nested = renderToStaticMarkup(createElement(GPropertyValue, { value: { owner: 'Garden', revision: 4 }, strings }));
  const empty = renderToStaticMarkup(createElement(GPropertyValue, { value: null, strings, emptyValue: 'No value' }));

  expect(scalar).toContain('>7<');
  expect(list).toContain('garden-document-chips');
  expect(list).toContain('garden');
  expect(list).not.toContain('<button');
  expect(nested).toContain('JSON value');
  expect(nested).toContain('revision');
  expect(empty).toContain('No value');
});

test('the standalone property component keeps non-canonical Markdown in its read-only source fallback', () => {
  const source = '# Plain Markdown stays unchanged\n';
  const markup = renderToStaticMarkup(createElement(GDocumentProperties, {
    value: source,
    strings,
    readOnly: true,
  }));

  expect(markup).toContain('Legacy source');
  expect(markup).toContain('# Plain Markdown stays unchanged');
  expect(markup).not.toContain('<input');
});
