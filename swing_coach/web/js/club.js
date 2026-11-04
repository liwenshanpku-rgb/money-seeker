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

// 静止背景：若干帧逐像素取中位数。shifts[k] 是第 k 帧相对参考帧的画面平移（手持拍摄会抖），先对齐再取。
export function medianBackground(grays, w, h, shifts) {
  const n = grays.length, out = new Float32Array(w * h), buf = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = 0; k < n; k++) {
        const sx = x + (shifts?.[k]?.dx || 0), sy = y + (shifts?.[k]?.dy || 0);
        if (sx >= 0 && sx < w && sy >= 0 && sy < h) buf[m++] = grays[k][sy * w + sx];
      }
      const b = buf.subarray(0, m).sort();
      out[y * w + x] = m ? b[m >> 1] : 0;
    }
  }
  return out;
}

// 估计 img 相对 ref 的整体平移（画面抖动 / 轻微跟拍）：在去掉人的区域上找差异最小的平移，先粗后细。
// 返回 {dx, dy}：img 上的 (x + dx, y + dy) 对应 ref 上的 (x, y)。
export function estimateShift(ref, img, w, h, personBox, R = 24) {
  const sad = (dx, dy, step) => {
    let s = 0, c = 0;
    for (let y = 8; y < h - 8; y += step) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let x = 8; x < w - 8; x += step) {
        if (personBox && x > personBox.x0 && x < personBox.x1 && y > personBox.y0 && y < personBox.y1) continue;
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        s += Math.abs(img[yy * w + xx] - ref[y * w + x]); c++;
      }
    }
    return c ? s / c : Infinity;
  };
  let best = { dx: 0, dy: 0 }, bv = sad(0, 0, 6);
  for (let dy = -R; dy <= R; dy += 3) for (let dx = -R; dx <= R; dx += 3) {
    const v = sad(dx, dy, 6);
    if (v < bv) { bv = v; best = { dx, dy }; }
  }
  const c0 = best;
  for (let dy = c0.dy - 2; dy <= c0.dy + 2; dy++) for (let dx = c0.dx - 2; dx <= c0.dx + 2; dx++) {
    const v = sad(dx, dy, 3);
    if (v < bv) { bv = v; best = { dx, dy }; }
  }
  return best;
}

// 每个像素的「可用度」（0–1）：在动的程度（静止背景压低到 still），身体上的点为 0。
// 是不是细线要看线的方向才能判断（树叶纹理在各个方向上都像细线），在 lineProfile 里沿线的法向计算。
export function clubMap(gray, w, h, neighbors, lm, H, { legs = true, still = 0.3 } = {}) {
  const torso = torsoPx(lm, H);
  const M = new Float32Array(w * h);
  // 在动的程度：和前后相邻帧（各自对齐画面抖动后）的差异取较小值。
  // 只和相邻帧比，手持拍摄的抖动和缓慢跟拍都影响很小；取较小值可以去掉前后帧里杆的「残影」。
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!neighbors?.length) { M[i] = 1; continue; }
      let mot = Infinity;
      for (const nb of neighbors) {
        const bx = x + nb.shift.dx, by = y + nb.shift.dy;
        const d = bx < 0 || bx >= w || by < 0 || by >= h ? 0 : Math.abs(gray[i] - nb.data[by * w + bx]);
        if (d < mot) mot = d;
      }
      M[i] = still + (1 - still) * Math.min(1, mot / 25);
    }
  }
  // 去掉身体：沿每条身体线段把附近的像素清零
  for (const [a, b] of SEGMENTS) {
    const isLeg = a >= 23 && b >= 25;
    if (!legs && isLeg) continue;
    // 腿只去掉中线附近（裤子上的线条），杆身常从腿前经过
    const r = (isLeg ? 0.06 : 0.12) * torso;
    const A = px(lm[a], H), B = px(lm[b], H);
    const x0 = Math.max(0, Math.floor(Math.min(A.x, B.x) - r)), x1 = Math.min(w - 1, Math.ceil(Math.max(A.x, B.x) + r));
    const y0 = Math.max(0, Math.floor(Math.min(A.y, B.y) - r)), y1 = Math.min(h - 1, Math.ceil(Math.max(A.y, B.y) + r));
    const abx = B.x - A.x, aby = B.y - A.y, l2 = abx * abx + aby * aby || 1e-9;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = Math.max(0, Math.min(1, ((x - A.x) * abx + (y - A.y) * aby) / l2));
        if (Math.hypot(x - (A.x + t * abx), y - (A.y + t * aby)) < r) M[y * w + x] = 0;
      }
    }
  }
  return { gray, M };
}

// 各方向的得分：经过双手附近、向外延伸的线段上「像球杆」像素的平均值
export function lineProfile(map, w, h, lm, H, handed, { lead: handsLead } = {}) {
  const { gray, M } = map;
  const { lead, trail } = sides(handed);
  const torso = torsoPx(lm, H);
  // handsLead：按双手速度对姿态模型的延迟做的补偿（视频高度单位）
  const hx = ((lm[lead.wrist].x + lm[trail.wrist].x) / 2 + (handsLead?.x || 0)) * H;
  const hy = ((lm[lead.wrist].y + lm[trail.wrist].y) / 2 + (handsLead?.y || 0)) * H;
  // 线段从双手稍后一点开始（允许手腕关键点有些偏差），不能从手后面很远开始，否则反方向的线也会覆盖到杆身
  const t0 = -0.2 * torso, nT = Math.ceil(2.2 * torso);
  const offs = [];
  for (let o = -0.8 * torso; o <= 0.8 * torso + 0.01; o += 2) offs.push(o);
  const lens = [0.6, 0.9, 1.2, 1.5].map((f) => Math.round(f * torso));
  const maxStart = Math.round(1.1 * torso);
  const score = new Float32Array(ANGLES.length), where = new Array(ANGLES.length);
  const cum = new Float32Array(nT + 1), cnt = new Float32Array(nT + 1);
  const minValid = 0.35 * torso;
  // 杆身不会沿前臂从双手指回手肘（那多半是反方向的同一条线或手臂轮廓）
  const toElbow = (Math.atan2(lm[lead.elbow].y * H - hy, lm[lead.elbow].x * H - hx) * 180) / Math.PI;
  ANGLES.forEach((deg, k) => {
    if (angDiff(deg, toElbow) < 30) { score[k] = 0; where[k] = null; return; }
    const rad = (deg * Math.PI) / 180, dx = Math.cos(rad), dy = Math.sin(rad), nx = -dy, ny = dx;
    let best = 0, arg = null;
    for (const o of offs) {
      const bx = hx + o * nx + t0 * dx, by = hy + o * ny + t0 * dy;
      cum[0] = 0; cnt[0] = 0;
      for (let s = 0; s < nT; s++) {
        const x = Math.round(bx + s * dx), y = Math.round(by + s * dy);
        // 只在可见（不在身体上、在画面内）的点上取平均：杆身经过腿前、手臂后面时只看露出来的部分
        const ok = x >= 3 && x < w - 3 && y >= 3 && y < h - 3 && M[y * w + x] > 0;
        cum[s + 1] = cum[s] + (ok ? ridgeAt(gray, M, w, h, x, y, nx, ny) : 0);
        cnt[s + 1] = cnt[s] + (ok ? 1 : 0);
      }
      for (let st = 0; st <= maxStart; st += 3) {
        for (const L of lens) {
          const e = Math.min(nT, st + L);
          const c = cnt[e] - cnt[st];
          if (c < minValid) continue;
          const m = (cum[e] - cum[st]) / c;
          if (m > best) { best = m; arg = { off: o, start: t0 + st, len: e - st }; }
        }
      }
    }
    score[k] = best;
    where[k] = arg;
  });
  return { score, where, hands: { x: hx, y: hy }, torso };
}

// 沿法向 (nx, ny) 看：中心比两侧都亮或都暗（细线），再乘可用度
const WIDTHS = [1, 2, 3];
function ridgeAt(gray, M, w, h, x, y, nx, ny) {
  const i = y * w + x, m = M[i];
  if (!m) return 0;
  const c = gray[i];
  let rid = 0;
  for (const k of WIDTHS) {
    const ax = Math.round(x + k * nx), ay = Math.round(y + k * ny), bx = Math.round(x - k * nx), by = Math.round(y - k * ny);
    if (ax < 0 || ax >= w || ay < 0 || ay >= h || bx < 0 || bx >= w || by < 0 || by >= h) continue;
    const a = gray[ay * w + ax], b = gray[by * w + bx];
    const r = Math.max(Math.min(c - a, c - b), Math.min(a - c, b - c));
    if (r > rid) rid = r;
  }
  return (Math.min(rid, 30) / 30) * m;
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
function endpoints(map, w, h, prof, k) {
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
    if (x < 3 || x >= w - 3 || y < 3 || y >= h - 3) break;
    const v = Math.max(ridgeAt(map.gray, map.M, w, h, x, y, nx, ny), ridgeAt(map.gray, map.M, w, h, Math.round(x + nx), Math.round(y + ny), nx, ny), ridgeAt(map.gray, map.M, w, h, Math.round(x - nx), Math.round(y - ny), nx, ny));
    if (v > 0.25) { last = s; gap = 0; } else if (++gap > 0.15 * torso) break;
  }
  return { grip, head: { x: grip.x + last * dx, y: grip.y + last * dy } };
}

/**
 * 识别一段挥杆里每一帧的球杆。
 * frames：[{ t, lm }]（lm 单位为视频高度）；gray(i) 返回第 i 帧的 { data: Float32Array 灰度, w, h }。
 * 返回 Map(帧序号 → { angle, grip, head, conf })，坐标单位与 lm 相同（视频高度）。
 */
export async function detectClub(frames, P, { handed = 'right', gray, from, to, debug, lagSec = 0.033 }) {
  const g0 = await gray(from);
  const H = g0.h;
  // 人所在的区域（整段挥杆的范围）不参与画面对齐
  let box = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  const t1 = torsoPx(frames[P.P1].lm, H);
  for (let i = from; i <= to; i++) for (const k of [0, 11, 12, 15, 16, 23, 24, 27, 28]) {
    const p = px(frames[i].lm[k], H);
    box = { x0: Math.min(box.x0, p.x - 0.6 * t1), x1: Math.max(box.x1, p.x + 0.6 * t1), y0: Math.min(box.y0, p.y - 0.6 * t1), y1: Math.max(box.y1, p.y + 0.6 * t1) };
  }
  // 隔一帧比较（相邻帧在上杆慢速时几乎不动，差异太小）
  const gap = Math.max(1, Math.round((frames.length - 1) / ((frames[frames.length - 1].t - frames[0].t) || 1) / 60));
  const idx = [], profs = [], maps = [];
  for (let i = from; i <= to; i++) {
    const g = i === from ? g0 : await gray(i);
    // 准备和起杆时腿基本不动，杆身常常就在腿前面，这时不排除腿
    // 下杆时杆一定在动：静止的细线（灯带、地垫边）几乎不算
    const neighbors = [];
    for (const j of [i - gap, i + gap]) {
      if (j < 0 || j >= frames.length) continue;
      const nd = (await gray(j)).data;
      neighbors.push({ data: nd, shift: estimateShift(g.data, nd, g.w, g.h, box, 8) });
    }
    const map = clubMap(g.data, g.w, g.h, neighbors, frames[i].lm, H, { legs: i >= P.P2, still: i > P.P4 ? 0.1 : 0.3 });
    idx.push(i);
    // 姿态模型对快速移动的手有延迟（实测快速下杆、送杆时落后 2–4 帧）：沿双手速度往前推 lagSec 秒
    const hand = (j) => { const f = frames[Math.max(0, Math.min(frames.length - 1, j))]; return { x: (f.lm[15].x + f.lm[16].x) / 2, y: (f.lm[15].y + f.lm[16].y) / 2, t: f.t }; };
    const a = hand(i - 1), b = hand(i + 1), dt = (b.t - a.t) || 1;
    profs.push(lineProfile(map, g.w, g.h, frames[i].lm, H, handed, { lead: { x: (b.x - a.x) / dt * lagSec, y: (b.y - a.y) / dt * lagSec } }));
    maps.push({ map, w: g.w, h: g.h });
  }
  const path = trackAngles(profs, idx.map((i) => frames[i].t), frames[P.P4].t);
  if (debug) {
    profs.forEach((p, j) => {
      const order = [...p.score.keys()].sort((a, b) => p.score[b] - p.score[a]).slice(0, 4);
      debug.push(`${idx[j]} ${Object.keys(P).filter((k) => P[k] === idx[j]).join(',')} pick=${ANGLES[path[j]]} top: ${order.map((k) => `${ANGLES[k]}:${p.score[k].toFixed(2)}`).join(' ')}`);
    });
  }
  const out = new Map();
  path.forEach((k, j) => {
    const { map, w, h } = maps[j];
    const ends = endpoints(map, w, h, profs[j], k);
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
