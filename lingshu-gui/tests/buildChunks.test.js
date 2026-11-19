import test from 'node:test';
import assert from 'node:assert/strict';
import { createManualChunks } from '../scripts/manualChunks.js';

test('createManualChunks splits heavy vendor modules into stable chunks', () => {
  const manualChunks = createManualChunks();

  assert.equal(
    manualChunks('E:/Project/LingShu-Agent/lingshu-gui/node_modules/@arco-design/web-vue/es/index.mjs'),
    'arco',
  );
  assert.equal(
    manualChunks('E:/Project/LingShu-Agent/lingshu-gui/node_modules/@arco-design/web-vue/es/form/index.js'),
    'arco',
  );
  assert.equal(
    manualChunks('E:/Project/LingShu-Agent/lingshu-gui/node_modules/@arco-design/web-vue/es/modal/index.js'),
    'arco',
  );
  assert.equal(
    manualChunks('E:/Project/LingShu-Agent/lingshu-gui/node_modules/@arco-design/web-vue/es/avatar/index.js'),
    'arco',
  );
  assert.equal(
    manualChunks('E:/Project/LingShu-Agent/lingshu-gui/node_modules/@xterm/xterm/lib/xterm.js'),
    'terminal',
  );
  assert.equal(
    manualChunks('E:/Project/LingShu-Agent/lingshu-gui/node_modules/marked/lib/marked.esm.js'),
    'markdown',
  );
  assert.equal(
    manualChunks('E:/Project/LingShu-Agent/lingshu-gui/node_modules/@tauri-apps/api/window.js'),
    'tauri-bridge',
  );
  assert.equal(
    manualChunks('E:/Project/LingShu-Agent/lingshu-gui/node_modules/vue-router/dist/vue-router.mjs'),
    'vue-core',
  );
  assert.equal(
    manualChunks('E:/Project/LingShu-Agent/lingshu-gui/node_modules/lodash-es/lodash.js'),
    'vendor',
  );
  assert.equal(
    manualChunks('E:/Project/LingShu-Agent/lingshu-gui/src/views/ChatView.vue'),
    undefined,
  );
});
