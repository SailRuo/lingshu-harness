import test from 'node:test';
import assert from 'node:assert/strict';
import { arcoPluginName, registerArcoComponents } from '../src/plugins/arco.js';

test('registerArcoComponents installs the official Arco plugin once', () => {
  const installs = [];
  const app = {
    use(component) {
      installs.push(component);
      return this;
    },
  };

  registerArcoComponents(app);

  assert.equal(installs.length, 1);
  assert.equal(typeof installs[0].install, 'function');
  assert.equal(arcoPluginName, 'ArcoVue');
});
