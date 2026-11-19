import test from 'node:test';
import assert from 'node:assert/strict';
import { applyThemeToDocument, resolveThemeMode } from '../src/utils/theme.js';

function createDocumentStub() {
  const htmlAttrs = new Map();
  const bodyAttrs = new Map();

  return {
    documentElement: {
      setAttribute(name, value) {
        htmlAttrs.set(name, value);
      },
      getAttribute(name) {
        return htmlAttrs.get(name) ?? null;
      },
    },
    body: {
      setAttribute(name, value) {
        bodyAttrs.set(name, value);
      },
      removeAttribute(name) {
        bodyAttrs.delete(name);
      },
      getAttribute(name) {
        return bodyAttrs.get(name) ?? null;
      },
    },
  };
}

test('resolveThemeMode keeps explicit light and dark selections', () => {
  assert.equal(resolveThemeMode('light', true), 'light');
  assert.equal(resolveThemeMode('dark', false), 'dark');
});

test('resolveThemeMode maps system selection from OS preference', () => {
  assert.equal(resolveThemeMode('system', true), 'dark');
  assert.equal(resolveThemeMode('system', false), 'light');
});

test('applyThemeToDocument applies dark attributes for explicit dark mode', () => {
  const doc = createDocumentStub();

  applyThemeToDocument(doc, 'dark', () => false);

  assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark');
  assert.equal(doc.body.getAttribute('arco-theme'), 'dark');
});

test('applyThemeToDocument removes dark body attribute for light mode', () => {
  const doc = createDocumentStub();

  applyThemeToDocument(doc, 'light', () => true);

  assert.equal(doc.documentElement.getAttribute('data-theme'), 'light');
  assert.equal(doc.body.getAttribute('arco-theme'), null);
});

test('applyThemeToDocument resolves system mode before writing attributes', () => {
  const doc = createDocumentStub();

  applyThemeToDocument(doc, 'system', () => true);
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark');
  assert.equal(doc.body.getAttribute('arco-theme'), 'dark');

  applyThemeToDocument(doc, 'system', () => false);
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'light');
  assert.equal(doc.body.getAttribute('arco-theme'), null);
});
