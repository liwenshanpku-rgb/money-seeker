// 运行：node --test swing_coach/tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticSwing, PRO_PARAMS, POSITIONS } from '../web/js/template.js';
import { detectPhases } from '../web/js/phases.js';
import { makeContext, evaluate, summarize } from '../web/js/metrics.js';

function run({ view = 'fo', club = 'iron', handed = 'right', table, noise = 0.002, timing } = {}) {
  const s = syntheticSwing({ view, club, handed, table, noise, timing });
  const det = detectPhases(s.frames, { handed, club });
  const ctx = makeContext(det.frames, det.P, { view: det.view, dir: det.dir, handed, club });
  const results = evaluate(ctx);
  return { s, det, results, byId: Object.fromEntries(results.map((r) => [r.id, r])) };
}

for (const view of ['fo', 'dtl']) {
  for (const handed of ['right', 'left']) {
    test(`识别 P1–P10（${view}, ${handed}）`, () => {
      const { s, det } = run({ view, handed });
      assert.equal(det.view, view);
      for (const p of POSITIONS) {
        const tol = p === 'P1' || p === 'P10' ? 8 : 2;
        assert.ok(Math.abs(det.P[p] - s.truth[p]) <= tol, `${p}: got ${det.P[p]}, want ${s.truth[p]}`);
      }
      const order = POSITIONS.map((p) => det.P[p]);
      assert.deepEqual([...order].sort((a, b) => a - b), order, 'P 位置应按时间顺序');
    });
  }
}

for (const view of ['fo', 'dtl']) {
  for (const club of ['iron', 'driver']) {
    test(`职业模板自身全部达标（${view}, ${club}）`, () => {
      const { results } = run({ view, club, noise: 0 });
      const bad = results.filter((r) => r.status !== 'good').map((r) => `${r.id}=${r.value}`);
      assert.deepEqual(bad, []);
      assert.equal(summarize(results).score, 100);
    });
  }
}

test('正面：识别反向重心、重心不转移和翻腕', () => {
  const table = structuredClone(PRO_PARAMS);
  Object.assign(table.P4, { tilt: -6, shiftX: 0.03 });
  Object.assign(table.P7, { shiftX: 0.0, arm: 12, tilt: 10 });
  const { byId, results } = run({ table });
  assert.notEqual(byId.fo_p4_tilt.status, 'good');
  assert.equal(byId.fo_p4_tilt.side, 'low');
  assert.notEqual(byId.fo_p7_shift.status, 'good');
  assert.notEqual(byId.fo_p7_hands.status, 'good');
  const top = summarize(results).priorities.map((r) => r.id);
  assert.ok(top.length > 0 && top.length <= 3);
});

test('侧面：识别提前伸展（臀部顶向球、起身）', () => {
  const table = structuredClone(PRO_PARAMS);
  Object.assign(table.P6, { shiftZ: 0.06, bend: 30 });
  Object.assign(table.P7, { shiftZ: 0.08, bend: 26 });
  const { byId } = run({ view: 'dtl', table });
  assert.equal(byId.dtl_p7_hips.status, 'bad');
  assert.equal(byId.dtl_p7_hips.side, 'high');
  assert.notEqual(byId.dtl_p7_bend.status, 'good');
  assert.notEqual(byId.dtl_p6_hips.status, 'good');
});

test('节奏：上杆过快时提示', () => {
  const timing = { P1: 0, P2: 0.1, P3: 0.2, P4: 0.32, P5: 0.46, P6: 0.53, P7: 0.6, P8: 0.68, P9: 0.8, P10: 1.2 };
  const { byId } = run({ timing });
  assert.ok(byId.tempo.value < 2);
  assert.equal(byId.tempo.side, 'low');
});

test('低可见度关键点不打分', () => {
  const s = syntheticSwing({});
  for (const f of s.frames) f.lm[0] = { ...f.lm[0], v: 0.1 };
  const det = detectPhases(s.frames, {});
  const ctx = makeContext(det.frames, det.P, { view: det.view, dir: det.dir, handed: 'right', club: 'iron' });
  const head = evaluate(ctx).find((r) => r.id === 'fo_p4_head');
  assert.equal(head.status, 'na');
});

for (const view of ['fo', 'dtl']) {
  test(`识别下杆转髋不够、肩膀抢先（${view}）`, () => {
    const table = structuredClone(PRO_PARAMS);
    Object.assign(table.P5, { hip: 30, shoulder: 50 });
    Object.assign(table.P6, { hip: 12, shoulder: 12 });
    Object.assign(table.P7, { hip: -8, shoulder: -15 });
    const { byId } = run({ view, table, noise: 0.001 });
    const id = (s) => `${view}_${s}`;
    assert.equal(byId[id('p6_hipopen')].side, 'low', `p6_hipopen=${byId[id('p6_hipopen')].value}`);
    assert.equal(byId[id('p6_sequence')].side, 'low', `p6_sequence=${byId[id('p6_sequence')].value}`);
    const p7 = view === 'fo' ? byId.fo_p7_hipturn : byId.dtl_p7_hipopen;
    assert.equal(p7.side, 'low', `p7=${p7.value}`);
  });
}

test('正面斜着拍时，转动类指标标为无法判断而不是 0°', () => {
  for (const yaw of [35, -35]) {
    const s = syntheticSwing({ view: 'fo', yaw, noise: 0.001 });
    const det = detectPhases(s.frames, { view: 'fo' });
    const ctx = makeContext(det.frames, det.P, { view: 'fo', dir: det.dir, handed: 'right', club: 'iron' });
    const results = evaluate(ctx);
    assert.ok(ctx.oblique(), `yaw ${yaw} 应判为斜拍`);
    for (const r of results.filter((x) => x.metric.rotation)) assert.equal(r.status, 'na', `${r.id} yaw ${yaw}`);
  }
  const s = syntheticSwing({ view: 'fo', noise: 0.001 });
  const det = detectPhases(s.frames, { view: 'fo' });
  assert.equal(makeContext(det.frames, det.P, { view: 'fo', dir: det.dir, handed: 'right', club: 'iron' }).oblique(), false);
});
