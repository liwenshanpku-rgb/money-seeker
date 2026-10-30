import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildShareText } from '../web/js/share.js';

const prompt = readFileSync(new URL('../web/coach-prompt.md', import.meta.url), 'utf8');

test('分享文字包含提示词、基本信息、测量结果和补充说明', () => {
  const text = buildShareText(prompt, {
    settings: { handed: 'right', club: 'driver', view: 'dtl' },
    score: 68,
    timing: { P1: 0.5, P4: 1.4 },
    metrics: [
      { pos: 'P7', name: '击球时臀部位置（提前伸展）', value: '0.12 × 躯干', pro_range: '-0.2 – 0.06 × 躯干', status: 'bad', issue: '提前伸展：击球时臀部顶向球', pro_value: null },
      { pos: 'P1', name: '准备时脊柱前倾', value: '38 °', pro_range: '28 – 46 °', status: 'good', issue: null, pro_value: '41 °' },
    ],
    note: '经常打右曲',
  });
  assert.ok(text.startsWith('你是一位经验丰富的 PGA'));
  assert.match(text, /一号木/);
  assert.match(text, /侧面/);
  assert.match(text, /- P7 击球时臀部位置（提前伸展）：0\.12 × 躯干（职业区间 -0\.2 – 0\.06 × 躯干）→ 需改进，提前伸展/);
  assert.match(text, /- P1 准备时脊柱前倾：38 °.*→ 达标；职业视频 41 °/);
  assert.match(text, /# 我的补充\n经常打右曲/);
  assert.match(text, /P1 0\.5，P4 1\.4/);
});

test('中文按宽度逐字折行', async () => {
  const { wrapText } = await import('../web/js/share.js');
  const ctx = { measureText: (s) => ({ width: [...s].length * 10 }) };
  assert.deepEqual(wrapText(ctx, '一二三四五六七', 30), ['一二三', '四五六', '七']);
  assert.deepEqual(wrapText(ctx, '一二\n三', 100), ['一二', '三']);
});
