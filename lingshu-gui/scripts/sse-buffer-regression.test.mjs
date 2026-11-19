import assert from 'node:assert/strict';
import { consumeSseBuffer, flushTrailingSseBuffer } from '../src/utils/sse.js';

const chunkA = 'data: {"type":"text_delta","content":"hello"}\n';
const chunkB = 'data: {"type":"done","metadata":{"run_status":"done"}}';

const firstPass = consumeSseBuffer(chunkA + chunkB);

assert.deepEqual(firstPass.payloads, ['{"type":"text_delta","content":"hello"}']);
assert.equal(firstPass.rest, 'data: {"type":"done","metadata":{"run_status":"done"}}');

const trailing = flushTrailingSseBuffer(firstPass.rest);

assert.deepEqual(trailing, ['{"type":"done","metadata":{"run_status":"done"}}']);

console.log('sse trailing buffer regression passed');
