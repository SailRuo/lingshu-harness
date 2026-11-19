import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COMPOSER_MODE,
  readComposerMode,
  writeComposerMode,
} from '../src/utils/composerModePersistence.js';

function createStorage(initialEntries = {}) {
  const store = new Map(Object.entries(initialEntries));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
  };
}

test('readComposerMode restores a persisted valid mode', () => {
  const storage = createStorage({ 'lingshu-chat-composer-mode': 'task' });

  assert.equal(readComposerMode(storage), 'task');
});

test('readComposerMode falls back to default when persisted mode is invalid', () => {
  const storage = createStorage({ 'lingshu-chat-composer-mode': 'invalid' });

  assert.equal(readComposerMode(storage), DEFAULT_COMPOSER_MODE);
});

test('writeComposerMode persists the selected mode', () => {
  const storage = createStorage();

  writeComposerMode(storage, 'chat');

  assert.equal(storage.getItem('lingshu-chat-composer-mode'), 'chat');
});
