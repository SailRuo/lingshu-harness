import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

// The util is authored in TypeScript; strip the types so plain `node --test`
// can exercise it without a build step.
const source = fs.readFileSync(
  path.join(process.cwd(), 'src/utils/ttsEmotionTags.ts'),
  'utf8',
);
const stripped = stripTypeScriptTypes(source, { mode: 'strip' });
const moduleUrl = `data:text/javascript;base64,${Buffer.from(stripped).toString('base64')}`;
const {
  stripTtsEmotionTags,
  hasTtsEmotionTags,
  normalizeTtsEmotionBrackets,
  splitTtsEmotionText,
} = await import(moduleUrl);

test('strips english and chinese emotion tags', () => {
  assert.equal(stripTtsEmotionTags('[whispering] 若凡，这两天没动静'), '若凡，这两天没动静');
  assert.equal(stripTtsEmotionTags('[quiet]若凡，你忙吗？'), '若凡，你忙吗？');
  assert.equal(stripTtsEmotionTags('[兴奋] 今天天气真好。'), '今天天气真好。');
  assert.equal(stripTtsEmotionTags('【轻声】你好'), '你好');
  assert.equal(stripTtsEmotionTags('[温柔 疲惫]先歇一会儿吧。'), '先歇一会儿吧。');
});

test('keeps markdown links untouched', () => {
  const text = '看这个 [说明](https://example.com)';
  assert.equal(stripTtsEmotionTags(text), text);
  assert.equal(hasTtsEmotionTags(text), false);
  assert.equal(stripTtsEmotionTags('![图](https://example.com/a.png)'), '![图](https://example.com/a.png)');
});

test('detects emotion tags', () => {
  assert.equal(hasTtsEmotionTags('[兴奋]今天天气真好。'), true);
  assert.equal(hasTtsEmotionTags('今天天气真好。'), false);
  assert.equal(hasTtsEmotionTags(''), false);
});

test('normalizes fullwidth and CJK brackets', () => {
  assert.equal(normalizeTtsEmotionBrackets('【轻声】［小声］'), '[轻声][小声]');
});

test('split keeps the tag for the TTS wire only', () => {
  const { display, tts } = splitTtsEmotionText('[兴奋] 今天天气真好。');
  assert.equal(display, '今天天气真好。');
  assert.ok(tts && tts.includes('[兴奋]'));

  const plain = splitTtsEmotionText('今天天气真好。');
  assert.equal(plain.display, '今天天气真好。');
  assert.equal(plain.tts, null);
});
