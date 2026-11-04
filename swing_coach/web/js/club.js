// 球杆识别：在每一帧里找出从双手延伸出去的杆身。
//
// 姿态模型只认识人，不认识球杆，所以这里用图像规则：
//   1. 「像球杆」的像素 = 细线（比两侧亮或暗）× 在动（和整段视频的静止背景不同）；落在身体上的点不算，
//      这样排除了背景里的静止直线（树干、地垫边、灯带）和衣服条纹、四肢轮廓；
//   2. 杆身从握把出发向外延伸：在双手附近（快速下杆时手腕关键点会落后于真实位置，所以允许偏离半个躯干长）
//      搜索各个方向的线段，取「像球杆」的像素最多的方向；
//   3. 球杆不会在相邻两帧之间乱跳：用动态规划（Viterbi）在整段挥杆里找一条连续的角度轨迹，
//      准备姿势时杆必须指向下方（球的方向）。
// 只依赖灰度像素数组，浏览器和 Node（测试）里都能运行。

import { sides } from './geometry.js';

const STEP = 3; // 角度步长（度）
export const ANGLES = Array.from({ length: 360 / STEP }, (_, k) => k * STEP);

// 身体线段（关键点序号），落在这些线段附近的像素不算球杆
const SEGMENTS = [[11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [11, 12], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [0, 11], [0, 12]];

const px = (p, H) => ({ x: p.x * H, y: p.y * H }); // 关键点（单位：视频高度）→ 像素

export function torsoPx(lm, H) {
  const sx = (lm[11].x + lm[12].x) / 2, sy = (lm[11].y + lm[12].y) / 2;
  const hx = (lm[23].x + lm[24].x) / 2, hy = (lm[23].y + lm[24].y) / 2;
  return Math.hypot(sx - hx, sy - hy) * H;
}

// 静止背景：若干帧逐像素取中位数
export function medianBackground(grays) {
  const n = grays.length, len = grays[0].length, out = new Float32Array(len), buf = new Float32Array(n);
  for (let i = 0; i < len; i++) {
    for (let k = 0; k < n; k++) buf[k] = grays[k][i];
    buf.sort();
    out[i] = buf[n >> 1];
  }
  return out;
}

// 每个像素「像球杆」的程度（0–1）
export function clubMap(gray, w, h, bg, lm, H, { legs = true, still = 0.3 } = {}) {
  const torso = torsoPx(lm, H);
  const S = new Float32Array(w * h);
  const offs = [];
  for (const k of [1, 2, 3]) offs.push([k, 0], [0, k], [k, k], [k, -k]);
  for (let y = 3; y < h - 3; y++) {
    for (let x = 3; x < w - 3; x++) {
      const i = y * w + x, c = gray[i];
      let rid = 0;
      for (const [dx, dy] of offs) {
        const a = gray[i + dy * w + dx], b = gray[i - dy * w - dx];
        const r = Math.max(Math.min(c - a, c - b), Math.min(a - c, b - c));
        if (r > rid) rid = r;
      }
      if (rid <= 0) continue;
      const mot = bg ? Math.min(1, Math.abs(c - bg[i]) / 25) : 1;
      S[i] = (Math.min(rid, 30) / 30) * (still + (1 - still) * mot);
    }
  }
  // 去掉身体：沿每条身体线段把附近的像素清零
  const r = 0.12 * torso;
  for (const [a, b] of SEGMENTS) {
    if (!legs && a >= 23 && b >= 25) continue;
    const A = px(lm[a], H), B = px(lm[b], H);
    const x0 = Math.max(0, Math.floor(Math.min(A.x, B.x) - r)), x1 = Math.min(w - 1, Math.ceil(Math.max(A.x, B.x) + r));
    const y0 = Math.max(0, Math.floor(Math.min(A.y, B.y) - r)), y1 = Math.min(h - 1, Math.ceil(Math.max(A.y, B.y) + r));
    const abx = B.x - A.x, aby = B.y - A.y, l2 = abx * abx + aby * aby || 1e-9;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = Math.max(0, Math.min(1, ((x - A.x) * abx + (y - A.y) * aby) / l2));
        if (Math.hypot(x - (A.x + t * abx), y - (A.y + t * aby)) < r) S[y * w + x] = 0;
      }
    }
  }
  return S;
}

// 各方向的得分：经过双手附近、向外延伸的线段上「像球杆」像素的平均值
export function lineProfile(S, w, h, lm, H, handed) {
  const { lead, trail } = sides(handed);
  const torso = torsoPx(lm, H);
  const hx = (lm[lead.wrist].x + lm[trail.wrist].x) / 2 * H, hy = (lm[lead.wrist].y + lm[trail.wrist].y) / 2 * H;
  const t0 = -0.6 * torso, nT = Math.ceil(2.6 * torso);
  const offs = [];
  for (let o = -0.5 * torso; o <= 0.5 * torso + 0.01; o += 2) offs.push(o);
  const lens = [0.6, 0.9, 1.2, 1.5].map((f) => Math.round(f * torso));
  const maxStart = Math.round(1.1 * torso);
  const score = new Float32Array(ANGLES.length), where = new Array(ANGLES.length);
  const cum = new Float32Array(nT + 1);
  ANGLES.forEach((deg, k) => {
    const rad = (deg * Math.PI) / 180, dx = Math.cos(rad), dy = Math.sin(rad), nx = -dy, ny = dx;
    let best = 0, arg = null;
    for (const o of offs) {
      const bx = hx + o * nx + t0 * dx, by = hy + o * ny + t0 * dy;
      cum[0] = 0;
      for (let s = 0; s < nT; s++) {
        const x = Math.round(bx + s * dx), y = Math.round(by + s * dy);
        cum[s + 1] = cum[s] + (x >= 0 && x < w && y >= 0 && y < h ? S[y * w + x] : 0);
      }
      for (let st = 0; st <= maxStart; st += 3) {
        for (const L of lens) {
          const e = Math.min(nT, st + L);
          const m = (cum[e] - cum[st]) / (e - st || 1);
          if (m > best) { best = m; arg = { off: o, start: t0 + st, len: e - st }; }
        }
      }
    }
    score[k] = best;
    where[k] = arg;
  });
  return { score, where, hands: { x: hx, y: hy }, torso };
}

const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// 逐帧角度轨迹：每帧得分归一后取 -log，相邻帧角度变化按时间受限（下杆允许转得快得多）
export function trackAngles(profiles, times, topTime) {
  const n = profiles.length, K = ANGLES.length;
  const cost = profiles.map((p) => {
    let mx = 0;
    for (const v of p.score) mx = Math.max(mx, v);
    return Array.from(p.score, (v) => -Math.log(v / (mx + 1e-3) + 0.02));
  });
  // 准备姿势：杆指向画面下方（球的方向）
  let D = cost[0].map((c, k) => c + (ANGLES[k] > 35 && ANGLES[k] < 145 ? 0 : 50));
  const back = [];
  for (let t = 1; t < n; t++) {
    const dt = Math.max(1e-3, times[t] - times[t - 1]);
    const sig = Math.max(6, (times[t] <= topTime ? 1200 : 4000) * dt);
    const nd = new Array(K), bk = new Int16Array(K);
    for (let j = 0; j < K; j++) {
      let best = Infinity, arg = 0;
      for (let i = 0; i < K; i++) {
        const v = D[i] + Math.min(0.5 * (angDiff(ANGLES[i], ANGLES[j]) / sig) ** 2, 12);
        if (v < best) { best = v; arg = i; }
      }
      nd[j] = best + cost[t][j];
      bk[j] = arg;
    }
    back.push(bk);
    D = nd;
  }
  let k = D.indexOf(Math.min(...D));
  const path = [k];
  for (let t = n - 1; t > 0; t--) { k = back[t - 1][k]; path.push(k); }
  return path.reverse();
}

// 沿选中的方向找握把和杆头：握把 = 线段起点，杆头 = 「像球杆」的像素连续出现的最远处
function endpoints(S, w, h, prof, k) {
  const { hands, torso } = prof;
  const arg = prof.where[k];
  if (!arg) return null;
  const rad = (ANGLES[k] * Math.PI) / 180, dx = Math.cos(rad), dy = Math.sin(rad), nx = -dy, ny = dx;
  const grip = { x: hands.x + arg.off * nx + arg.start * dx, y: hands.y + arg.off * ny + arg.start * dy };
  let last = arg.len, gap = 0;
  for (let s = 0; s < 2.2 * torso; s++) {
    const x = Math.round(grip.x + s * dx), y = Math.round(grip.y + s * dy);
    if (x < 0 || x >= w || y < 0 || y >= h) break;
    // 杆身很细，左右各看 1 像素
    const v = Math.max(S[y * w + x], S[y * w + Math.min(w - 1, x + 1)], S[y * w + Math.max(0, x - 1)]);
    if (v > 0.25) { last = s; gap = 0; } else if (++gap > 0.15 * torso) break;
  }
  return { grip, head: { x: grip.x + last * dx, y: grip.y + last * dy } };
}

/**
 * 识别一段挥杆里每一帧的球杆。
 * frames：[{ t, lm }]（lm 单位为视频高度）；gray(i) 返回第 i 帧的 { data: Float32Array 灰度, w, h }。
 * 返回 Map(帧序号 → { angle, grip, head, conf })，坐标单位与 lm 相同（视频高度）。
 */
export async function detectClub(frames, P, { handed = 'right', gray, from, to, bgFrames }) {
  const g0 = await gray(from);
  const H = g0.h;
  const bg = bgFrames?.length >= 5 ? medianBackground(await Promise.all(bgFrames.map(async (i) => (await gray(i)).data))) : null;
  const idx = [], profs = [], maps = [];
  for (let i = from; i <= to; i++) {
    const g = i === from ? g0 : await gray(i);
    // 准备和起杆时腿基本不动，杆身常常就在腿前面，这时不排除腿
    // 下杆时杆一定在动：静止的细线（灯带、地垫边）几乎不算
    const S = clubMap(g.data, g.w, g.h, bg, frames[i].lm, H, { legs: i >= P.P2, still: i > P.P4 ? 0.1 : 0.3 });
    idx.push(i);
    profs.push(lineProfile(S, g.w, g.h, frames[i].lm, H, handed));
    maps.push({ S, w: g.w, h: g.h });
  }
  const path = trackAngles(profs, idx.map((i) => frames[i].t), frames[P.P4].t);
  const out = new Map();
  path.forEach((k, j) => {
    const { S, w, h } = maps[j];
    const ends = endpoints(S, w, h, profs[j], k);
    if (!ends) return;
    let mx = 0;
    for (const v of profs[j].score) mx = Math.max(mx, v);
    out.set(idx[j], {
      angle: ANGLES[k],
      grip: { x: ends.grip.x / H, y: ends.grip.y / H },
      head: { x: ends.head.x / H, y: ends.head.y / H },
      conf: profs[j].score[k] / (mx || 1),
    });
  });
  return out;
}
