// 运行：node --test swing_coach/tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticSwing, PRO_PARAMS, PRO_TIMING, POSITIONS } from '../web/js/template.js';
import { detectPhases, findSwings } from '../web/js/phases.js';
import { makeContext, evaluate, summarize, aggregateResults, representativeIndex } from '../web/js/metrics.js';

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
      const bad = results.filter((r) => r.status !== 'good' && !(r.status === 'ref' && r.value >= r.range[0] && r.value <= r.range[1])).map((r) => `${r.id}=${r.value}`);
      assert.deepEqual(bad, []);
      assert.equal(summarize(results).score, 100);
    });
  }
}

test('正面：识别反向重心、重心不转移和翻腕', () => {
  const table = structuredClone(PRO_PARAMS);
  Object.assign(table.P4, { tilt: -6, shiftX: 0.03 });
  Object.assign(table.P7, { shiftX: -0.02, arm: 12, tilt: 10 });
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

test('侧面：识别下杆由外向内（双手走到上杆路线外侧）', () => {
  const s = syntheticSwing({ view: 'dtl', noise: 0 });
  const { dir } = detectPhases(s.frames, {});
  const lm1 = s.frames[s.truth.P1].lm;
  const torso = Math.abs((lm1[23].y + lm1[24].y) / 2 - (lm1[11].y + lm1[12].y) / 2);
  // 下杆过程中把双手、手肘向球的方向推出去，P4→P7 中段最多 0.35 个躯干长度
  const a = s.truth.P4, b = s.truth.P7;
  for (let i = a; i <= b; i++) {
    const k = 0.35 * torso * Math.sin((Math.PI * (i - a)) / (b - a));
    for (const j of [13, 14, 15, 16]) s.frames[i].lm[j] = { ...s.frames[i].lm[j], x: s.frames[i].lm[j].x + k * dir };
  }
  const det = detectPhases(s.frames, {});
  const ctx = makeContext(det.frames, det.P, { view: det.view, dir: det.dir, handed: 'right', club: 'iron' });
  const r = evaluate(ctx).find((x) => x.id === 'dtl_p5_path');
  assert.equal(r.side, 'high', String(r.value));
  assert.notEqual(r.status, 'good');
});

test('节奏：上杆过快时提示', () => {
  const timing = { P1: 0, P2: 0.1, P3: 0.2, P4: 0.32, P5: 0.46, P6: 0.53, P7: 0.6, P8: 0.68, P9: 0.8, P10: 1.2 };
  const { byId } = run({ timing });
  assert.ok(byId.tempo.value < 2.4, String(byId.tempo.value));
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
    // 转动类是「参考」指标：不按区间打分，这里检查数值确实低于职业区间
    const below = (r) => r.value < r.range[0];
    assert.ok(below(byId[id('p6_hipopen')]), `p6_hipopen=${byId[id('p6_hipopen')].value}`);
    assert.ok(below(byId[id('p6_sequence')]), `p6_sequence=${byId[id('p6_sequence')].value}`);
    const p7 = view === 'fo' ? byId.fo_p7_hipturn : byId.dtl_p7_hipopen;
    assert.ok(below(p7), `p7=${p7.value}`);
    assert.equal(p7.status, 'ref');
  });
}

test('有 3D 坐标时，正面斜着拍也能算出转动角度', () => {
  const at = (opts) => {
    const s = syntheticSwing({ view: 'fo', noise: 0.001, ...opts });
    const det = detectPhases(s.frames, { view: 'fo' });
    const ctx = makeContext(det.frames, det.P, { view: 'fo', dir: det.dir, handed: 'right', club: 'iron' });
    return { ctx, byId: Object.fromEntries(evaluate(ctx).map((r) => [r.id, r])) };
  };
  const square = at({});
  for (const yaw of [35, -35]) {
    const { ctx, byId } = at({ yaw });
    assert.equal(ctx.oblique(), false);
    for (const id of ['fo_p4_shoulder', 'fo_p4_hip', 'fo_p7_hipturn']) {
      assert.ok(byId[id].value >= byId[id].range[0] && byId[id].value <= byId[id].range[1], `${id} yaw ${yaw} = ${byId[id].value}`);
      assert.ok(Math.abs(byId[id].value - square.byId[id].value) < 6, `${id} yaw ${yaw}: ${byId[id].value} vs ${square.byId[id].value}`);
    }
  }
});

test('没有 3D 坐标时（只有 2D），正面斜拍的转动类指标标为无法判断', () => {
  for (const yaw of [35, -35]) {
    const s = syntheticSwing({ view: 'fo', yaw, noise: 0.001, withWorld: false });
    const det = detectPhases(s.frames, { view: 'fo' });
    const ctx = makeContext(det.frames, det.P, { view: 'fo', dir: det.dir, handed: 'right', club: 'iron' });
    assert.ok(ctx.oblique(), `yaw ${yaw} 应判为斜拍`);
    for (const r of evaluate(ctx).filter((x) => x.metric.rotation)) assert.equal(r.status, 'na', `${r.id} yaw ${yaw}`);
  }
});

test('侧面视角左右关键点被认反时，转动方向和大小不受影响', () => {
  const swap = (lm) => {
    const out = lm.slice();
    for (const [a, b] of [[11, 12], [13, 14], [15, 16], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]]) { out[a] = lm[b]; out[b] = lm[a]; }
    return out;
  };
  const s = syntheticSwing({ view: 'dtl', noise: 0.001 });
  // 模拟识别模型在挥杆中途反复把左右认反
  const flipped = s.frames.map((f, i) => (Math.floor(i / 7) % 2 ? { ...f, lm: swap(f.lm), wl: swap(f.wl) } : f));
  const val = (frames) => {
    const det = detectPhases(frames, { view: 'dtl' });
    const ctx = makeContext(det.frames, det.P, { view: 'dtl', dir: det.dir, handed: 'right', club: 'iron' });
    return [ctx.rot('hip', 'P4'), ctx.rot('shoulder', 'P4'), -ctx.rot('hip', 'P7')];
  };
  const [h, sh, h7] = val(s.frames);
  const [fh, fsh, fh7] = val(flipped);
  assert.ok(h > 30 && sh > 60 && h7 > 25, `${h} ${sh} ${h7}`);
  assert.ok(Math.abs(fh - h) < 8 && Math.abs(fsh - sh) < 8 && Math.abs(fh7 - h7) < 8, `${fh} ${fsh} ${fh7} vs ${h} ${sh} ${h7}`);
});

test('参考类指标和职业球员对比：差距小算达标，差距大给出方向', async () => {
  const { compareToPro } = await import('../web/js/metrics.js');
  const s = syntheticSwing({ view: 'dtl', noise: 0.001 });
  const det = detectPhases(s.frames, { view: 'dtl' });
  const r = evaluate(makeContext(det.frames, det.P, { view: 'dtl', dir: det.dir, handed: 'right', club: 'iron' })).find((x) => x.id === 'dtl_p7_hipopen');
  assert.equal(r.status, 'ref');
  assert.equal(compareToPro(r, r.value + 5).status, 'good');
  const far = compareToPro(r, r.value + 40);
  assert.equal(far.status, 'bad');
  assert.equal(far.side, 'low');
  assert.ok(far.advice.issue.includes('髋部'));
  assert.equal(compareToPro(r, NaN).status, 'ref');
});

test('所有职业球员骨架数据：P1–P10 顺序正确，非参考指标没有「需改进」', async () => {
  const fs = await import('node:fs');
  globalThis.fetch = async (u) => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(new URL(`../web/${u}`, import.meta.url))) });
  const { loadProFrames, PROS } = await import('../web/js/pros.js');
  let n = 0;
  for (const pro of PROS.filter((p) => p.data)) {
    for (const [club, files] of Object.entries(pro.data)) {
      for (const [v, url] of Object.entries(files)) {
        const d = await loadProFrames(url);
        const order = POSITIONS.map((p) => d.P[p]);
        assert.deepEqual([...order].sort((a, b) => a - b), order, `${pro.id} ${club} ${v}`);
        if (d.images) for (const img of Object.values(d.images)) assert.ok(fs.existsSync(new URL(`../web/${img}`, import.meta.url)), img);
        const det = detectPhases(d.frames, { view: v });
        const results = evaluate(makeContext(det.frames, d.P, { view: v, dir: det.dir, handed: 'right', club }));
        const bad = results.filter((r) => r.status === 'bad' && r.id !== 'tempo').map((r) => `${r.id}=${r.value}`);
        assert.deepEqual(bad, [], `${pro.id} ${club} ${v}: ${bad}`);
        n++;
      }
    }
  }
  assert.ok(n >= 2);
});

test('长视频：找出连续的每一杆', () => {
  // 三杆首尾相接（每杆前后各静止 2–3 秒），按 8fps 粗扫
  const frames = [];
  const peaks = [];
  let offset = 0;
  for (const seed of [1, 2, 3]) {
    const s = syntheticSwing({ view: 'dtl', fps: 8, lead: 3, tail: 2, noise: 0.002, seed });
    // 两杆之间：用 1.5 秒从收杆姿势慢慢回到准备姿势（放下球杆、重新站位）
    if (frames.length) {
      const a = frames[frames.length - 1], b = s.frames[0];
      for (let k = 1; k <= 12; k++) {
        const f = k / 13;
        frames.push({ t: a.t + k / 8, lm: a.lm.map((p, j) => ({ ...p, x: p.x + (b.lm[j].x - p.x) * f, y: p.y + (b.lm[j].y - p.y) * f })) });
      }
      offset = frames[frames.length - 1].t + 1 / 8;
    }
    for (const f of s.frames) frames.push({ ...f, t: f.t + offset });
    peaks.push(offset + 3 + PRO_TIMING.P7); // lead + P7
  }
  const found = findSwings(frames, {});
  assert.equal(found.length, 3);
  found.forEach((w, i) => {
    assert.ok(Math.abs(w.peak - peaks[i]) < 0.3, `第 ${i + 1} 杆击球时间 ${w.peak}，应为 ${peaks[i]}`);
    assert.ok(w.start < peaks[i] - 1.4 && w.end > peaks[i] + 0.6, '窗口应包含上杆和送杆');
  });
  // 按窗口截出的片段（相对这一杆的时间）能完成 P1–P10 分析
  const one = syntheticSwing({ view: 'dtl', fps: 30, lead: 3, tail: 2 });
  const shift = found[1].peak - (3 + PRO_TIMING.P7);
  const sub = one.frames.filter((f) => f.t >= found[1].start - shift && f.t <= found[1].end - shift);
  const det = detectPhases(sub, {});
  assert.ok(Math.abs(sub[det.P.P7].t - (3 + PRO_TIMING.P7)) < 0.1);
});

test('长视频：没有挥杆（只是走动）时不误报', () => {
  const s = syntheticSwing({ view: 'dtl', fps: 8, lead: 3, tail: 2 });
  // 双手始终低于肩：把每帧都替换成准备姿势并左右平移
  const still = s.frames.map((f, i) => ({ ...f, lm: s.frames[0].lm.map((p) => ({ ...p, x: p.x + 0.05 * Math.sin(i / 3) })) }));
  assert.equal(findSwings(still, {}).length, 0);
});

test('多杆综合：取中位数并重新评分', () => {
  const runs = [0.002, 0.004, 0.003].map((noise, i) => run({ view: 'dtl', noise, timing: undefined }).results);
  // 第三杆的节奏改成明显偏快，中位数仍应达标
  runs[2] = runs[2].map((r) => (r.id === 'tempo' ? { ...r, value: 1.2, status: 'bad', side: 'low' } : r));
  const agg = aggregateResults(runs);
  const tempo = agg.find((r) => r.id === 'tempo');
  assert.equal(tempo.status, 'good');
  assert.equal(tempo.n, 3);
  assert.equal(tempo.spread[0], 1.2);
  assert.equal(agg.length, runs[0].length);
  assert.notEqual(representativeIndex(runs, agg), 2);
});
