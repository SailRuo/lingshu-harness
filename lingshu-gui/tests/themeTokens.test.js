import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const lightCss = fs.readFileSync(
  path.join(process.cwd(), 'src/assets/styles/light.css'),
  'utf8',
);

const darkCss = fs.readFileSync(
  path.join(process.cwd(), 'src/assets/styles/dark.css'),
  'utf8',
);

const settingsView = fs.readFileSync(
  path.join(process.cwd(), 'src/views/SettingsView.vue'),
  'utf8',
);

for (const [name, source] of [
  ['light', lightCss],
  ['dark', darkCss],
]) {
  test(`${name} theme defines compatibility aliases used by app components`, () => {
    assert.match(source, /--primary-color:/);
    assert.match(source, /--primary-color-rgb:/);
    assert.match(source, /--color-primary-light-1:/);
    assert.match(source, /--color-primary-light-3:/);
    assert.match(source, /--bg-nav-rail:/);
    assert.match(source, /--bg-settings-sidebar:/);
    assert.match(source, /--bg-titlebar-button-hover:/);
    assert.match(source, /--bg-secondary:/);
    assert.match(source, /--success-color:/);
    assert.match(source, /--color-unread-bg:/);
    assert.doesNotMatch(source, /--bg-titlebar:/);
  });
}

test('settings container uses the shared app rail surface token', () => {
  assert.match(settingsView, /background-color:\s*var\(--bg-nav-rail,\s*var\(--bg-sidebar\)\)/);
});

test('settings sidebar uses the dedicated conversation-list surface token', () => {
  assert.match(
    settingsView,
    /background-color:\s*var\(--bg-conversation-list,\s*var\(--bg-nav-rail,\s*var\(--bg-sidebar\)\)\)/,
  );
});
