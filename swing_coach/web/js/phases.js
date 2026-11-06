// P1–P10 相位检测：从逐帧关键点里找出 10 个标准位置对应的帧。
//
// 思路（不依赖球杆检测，只用人体关键点）：
//   1. 平滑关键点，计算双手中心速度；
//   2. P7 击球 = 手速峰值附近、双手最低的一帧；P4 顶点 = P7 之前双手最高的一帧；
//   3. P1 = P4 之前最后一段静止；P10 = P7 之后双手抬高并重新静止；
//   4. 中间位置用一个随挥杆单调变化的特征穿越阈值来定：
//      正面视角用「胸口→双手」连线的角度，侧面视角用双手高度占上杆总高度的比例。
//      阈值不是拍脑袋的常数，而是在职业模板上算出来的同一特征值。

import { body, sub, tiltFromVertical, dist, NUM_LANDMARKS, sides } from './geometry.js';
import { templatePose, POSITIONS } from './template.js';

// 关键点平滑：低可见度点先线性插值，再做居中滑动平均。
// lm 是画面坐标；wl 是 MediaPipe 给出的 3D 世界坐标（米，以髋部为原点），有的话一起平滑。
export function smoothFrames(frames, windowSec = 0.06, minVis = 0.3) {
  const n = frames.length;
  if (n === 0) return [];
  const dt = n > 1 ? (frames[n - 1].t - frames[0].t) / (n - 1) : 1 / 30;
  const half = Math.max(1, Math.round(windowSec / dt / 2));
  const out = frames.map((f) => ({ t: f.t }));
  for (const key of ['lm', 'wl']) {
    if (!frames.some((f) => f[key])) continue;
    const dims = key === 'wl' ? ['x', 'y', 'z'] : ['x', 'y'];
    for (const f of out) f[key] = new Array(NUM_LANDMARKS);
    for (let k = 0; k < NUM_LANDMARKS; k++) {
      const vals = Object.fromEntries(dims.map((d) => [d, new Array(n)]));
      const vs = new Array(n);
      const good = [];
      for (let i = 0; i < n; i++) {
        const p = frames[i][key]?.[k];
        vs[i] = p ? (p.v ?? 1) : 0;
        if (p && vs[i] >= minVis) { for (const d of dims) vals[d][i] = p[d] ?? 0; good.push(i); }
      }
      if (good.length === 0) {
        for (let i = 0; i < n; i++) out[i][key][k] = { x: 0, y: 0, z: 0, v: 0 };
        continue;
      }
      // 插值填补
      let gi = 0;
      for (let i = 0; i < n; i++) {
        if (vals.x[i] !== undefined) continue;
        while (gi < good.length - 1 && good[gi + 1] < i) gi++;
        const a = good[gi], b = good[Math.min(gi + 1, good.length - 1)];
        for (const d of dims) {
          const xs = vals[d];
          if (i <= a || a === b) xs[i] = xs[a];
          else if (i >= b) xs[i] = xs[b];
          else xs[i] = xs[a] + (xs[b] - xs[a]) * ((i - a) / (b - a));
        }
      }
      for (let i = 0; i < n; i++) {
        const lo = Math.max(0, i - half), hi = Math.min(n - 1, i + half), c = hi - lo + 1;
        const p = {};
        for (const d of dims) { let sum = 0; for (let j = lo; j <= hi; j++) sum += vals[d][j]; p[d] = sum / c; }
        let sv = 0; for (let j = lo; j <= hi; j++) sv += vs[j];
        p.v = sv / c;
        out[i][key][k] = p;
      }
    }
  }
  return out;
}

// 自动判断拍摄角度：正面时两肩在画面上拉得开，侧面时两肩几乎重叠
export function detectView(lm, handed) {
  const b = body(lm, handed);
  const torso = dist(b.shoulderMid, b.hipMid);
  const width = Math.abs(b.leadShoulder.x - b.trailShoulder.x);
  return width / torso > 0.45 ? 'fo' : 'dtl';
}

// 画面方向：正面视角下目标在哪一侧（+1 右 / -1 左）；侧面视角下球在哪一侧
export function orientation(lm, handed, view) {
  const b = body(lm, handed);
  if (view === 'fo') return Math.sign(b.leadShoulder.x - b.trailShoulder.x) || 1;
  return Math.sign(b.hands.x - b.hipMid.x) || 1;
}

// 正面特征：胸口→双手连线偏离竖直向下的角度，向远离目标侧为正（连续展开，不在 ±180 处跳变）
function handAngles(frames, handed, dirSign) {
  const out = [];
  let prev = null;
  for (const f of frames) {
    const b = body(f.lm, handed);
    const d = sub(b.hands, b.shoulderMid);
    let a = (Math.atan2(-d.x * dirSign, d.y) * 180) / Math.PI;
    if (prev !== null) { while (a - prev > 180) a -= 360; while (a - prev < -180) a += 360; }
    out.push(a);
    prev = a;
  }
  return out;
}

// 模板在每个 P 位置的特征值（用于阈值）
const thresholdCache = new Map();
export function templateFeatures(view, club = 'iron') {
  const key = `${view}|${club}`;
  if (thresholdCache.has(key)) return thresholdCache.get(key);
  const frames = POSITIONS.map((p) => ({ t: 0, lm: templatePose(p, { view, club }).landmarks }));
  let feat;
  if (view === 'fo') {
    feat = handAngles(frames, 'right', 1);
  } else {
    const ys = frames.map((f) => body(f.lm, 'right').hands.y);
    feat = ys.map((y) => (ys[0] - y) / (ys[0] - ys[3]));
  }
  const res = Object.fromEntries(POSITIONS.map((p, i) => [p, feat[i]]));
  thresholdCache.set(key, res);
  return res;
}

function argBest(lo, hi, score) {
  let best = lo, bv = -Infinity;
  for (let i = lo; i <= hi; i++) { const v = score(i); if (v > bv) { bv = v; best = i; } }
  return best;
}

// 在 [lo, hi] 内找特征第一次越过阈值的帧；没越过就取最接近的
function crossing(feat, lo, hi, th, rising) {
  for (let i = lo; i <= hi; i++) if (rising ? feat[i] >= th : feat[i] <= th) return i;
  return argBest(lo, hi, (i) => -Math.abs(feat[i] - th));
}

export function detectPhases(rawFrames, { handed = 'right', view, club = 'iron', smoothed } = {}) {
  const frames = smoothed || smoothFrames(rawFrames);
  const n = frames.length;
  if (n < 10) throw new Error('视频太短，至少需要 10 帧');
  const dt = (frames[n - 1].t - frames[0].t) / (n - 1);
  const sec = (s) => Math.max(1, Math.round(s / dt));

  const hands = frames.map((f) => body(f.lm, handed).hands);
  const speed = hands.map((_, i) => {
    const a = hands[Math.max(0, i - 1)], b = hands[Math.min(n - 1, i + 1)];
    return dist(a, b) / (dt * (Math.min(n - 1, i + 1) - Math.max(0, i - 1)));
  });
  const edge = Math.min(sec(0.05), Math.floor(n / 10));
  // 击球：手速快且双手处在低位。慢速挥杆时送杆阶段手也很快，但那时双手已经抬高，按高度加权避免把送杆当成击球
  let yTop = Infinity, yLow = -Infinity;
  for (const h of hands) { yTop = Math.min(yTop, h.y); yLow = Math.max(yLow, h.y); }
  const lowness = (i) => (hands[i].y - yTop) / ((yLow - yTop) || 1);
  const iFast = argBest(edge, n - 1 - edge, (i) => speed[i] * (0.25 + 0.75 * lowness(i) ** 2));
  const vmax = Math.max(...speed.slice(edge, n - edge));
  if (!(vmax > 0)) throw new Error('没有检测到挥杆动作');

  // P7：手速峰值 ±0.1 秒内双手最低（y 最大）的帧
  const i7 = argBest(Math.max(0, iFast - sec(0.1)), Math.min(n - 1, iFast + sec(0.1)), (i) => hands[i].y);
  // P4：击球前 3.5 秒内双手最高（顶点停顿较久的慢速挥杆，顶点离击球可能超过 2 秒）
  const i4 = argBest(Math.max(0, i7 - sec(3.5)), Math.max(0, i7 - 2), (i) => -hands[i].y);
  const swingH = hands[i7].y - hands[i4].y;
  // 侧面视角里起杆初段双手主要沿镜头纵深移动，画面上很慢，所以静止阈值更低
  const v0 = view || detectView(frames[Math.max(0, i4 - sec(1))].lm, handed);
  const still = (v0 === 'dtl' ? 0.03 : 0.06) * vmax;

  // P1：从顶点往回找，第一段「静止且双手低位」的帧。
  // 有 3D 坐标时用双手的 3D 速度判断静止（侧面视角起杆时双手主要朝镜头纵深移动，画面上几乎不动）
  let still1 = (i) => speed[i] < still;
  if (frames[0].wl) {
    const { lead, trail } = sides(handed);
    const h3 = frames.map((f) => { const a = f.wl[lead.wrist], b = f.wl[trail.wrist]; return [(a.x + b.x) / 2, (a.y + b.y) / 2, ((a.z ?? 0) + (b.z ?? 0)) / 2]; });
    const sp3 = h3.map((_, i) => {
      const a = h3[Math.max(0, i - 1)], b = h3[Math.min(n - 1, i + 1)];
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / (dt * (Math.min(n - 1, i + 1) - Math.max(0, i - 1)));
    });
    const vmax3 = Math.max(...sp3.slice(edge, n - edge));
    still1 = (i) => sp3[i] < 0.05 * vmax3;
  }
  let i1 = 0;
  for (let i = i4 - 1; i >= 0; i--) {
    if (still1(i) && hands[i].y > hands[i4].y + 0.75 * swingH) { i1 = i; break; }
  }
  // P10：击球后双手抬高到一半以上，然后重新静止
  let i10 = n - 1;
  let risen = false;
  for (let i = i7 + 1; i < n; i++) {
    if (hands[i].y < hands[i7].y - 0.5 * swingH) risen = true;
    if (risen && speed[i] < still) { i10 = i; break; }
  }

  const lm1 = frames[i1].lm;
  const v = view || v0;
  const dir = orientation(lm1, handed, v);
  const th = templateFeatures(v, club);

  let feat;
  if (v === 'fo') {
    feat = handAngles(frames, handed, dir);
    // 以准备姿势为零点，消除个人手位差异
    const off = feat[i1] - th.P1;
    feat = feat.map((a) => a - off);
  } else {
    const y1 = hands[i1].y, y4 = hands[i4].y;
    feat = hands.map((h) => (y1 - h.y) / (y1 - y4 || 1));
  }

  const P = { P1: i1, P4: i4, P7: i7, P10: i10 };
  P.P2 = crossing(feat, i1, i4, th.P2, true);
  P.P3 = crossing(feat, P.P2, i4, th.P3, true);
  P.P5 = crossing(feat, i4, i7, th.P5, false);
  P.P6 = crossing(feat, P.P5, i7, th.P6, false);
  if (v === 'fo') {
    P.P8 = crossing(feat, i7, i10, th.P8, false);
    P.P9 = crossing(feat, P.P8, i10, th.P9, false);
  } else {
    P.P8 = crossing(feat, i7, i10, th.P8, true);
    P.P9 = crossing(feat, P.P8, i10, th.P9, true);
  }
  return { P, view: v, dir, frames, speed, feature: feat, fps: 1 / dt };
}

export { sides };

// 长视频里找出每一次挥杆（例如三脚架架在身后，连续打了好几杆）。
// 用低帧率粗扫一遍的关键点：双手速度的峰值在击球附近；之前 2.5 秒内、之后 1.5 秒内双手都举过肩
//（排除走动、试挥的小动作和收杆后放下球杆），两次击球至少相隔 2.5 秒。粗扫帧率低，峰值可能落在击球前后一两帧，
// 所以窗口前后多留一些。返回每一杆的大致时间窗口（秒），再用正常帧率逐杆精细分析。
export function findSwings(rawFrames, { handed = 'right', before = 2.5, after = 1.8 } = {}) {
  const frames = smoothFrames(rawFrames, 0.15);
  const n = frames.length;
  if (n < 5) return [];
  const t = frames.map((f) => f.t);
  const B = frames.map((f) => body(f.lm, handed));
  const speed = B.map((_, i) => {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    return dist(B[a].hands, B[b].hands) / ((t[b] - t[a]) || 1);
  });
  const vmax = Math.max(...speed);
  if (!(vmax > 0)) return [];
  const raised = (i) => {
    for (let j = i; j >= 0 && t[i] - t[j] <= 2.5; j--) if (B[j].hands.y < B[j].shoulderMid.y) return true;
    return false;
  };
  // 击球前后双手先落到肩下，之后 1.5 秒内再举过肩（送杆、收杆）；收杆后放下球杆只有下落、没有再举起。
  // 视频在击球后不久就结束的不要求
  const up = (j) => B[j].hands.y < B[j].shoulderMid.y;
  const finished = (i) => {
    if (t[n - 1] - t[i] < 0.8) return true;
    let low = false;
    for (let j = i; j > 0 && t[i] - t[j] <= 0.3; j--) if (!up(j)) low = true;
    for (let j = i; j < n && t[j] - t[i] <= 1.5; j++) {
      if (!up(j)) low = true;
      else if (low) return true;
    }
    return false;
  };
  // 击球时双手在腰部或更低：峰值前后 0.2 秒内要有这样的帧（顶点处杆的晃动、收杆后转身时双手都在高处）
  const waist = (j) => B[j].hands.y > (B[j].shoulderMid.y + B[j].hipMid.y) / 2;
  const nearLow = (i) => {
    for (let j = i; j >= 0 && t[i] - t[j] <= 0.2; j--) if (waist(j)) return true;
    for (let j = i; j < n && t[j] - t[i] <= 0.2; j++) if (waist(j)) return true;
    return false;
  };
  // 相近的候选里保留「快且双手低」的那个
  const score = (i) => speed[i] * (waist(i) ? 1 : 0.6);
  const peaks = [];
  for (let i = 1; i < n - 1; i++) {
    // 收杆后放下球杆、走动等动作不满足「之前举过肩、之后又举过肩、速度够快」
    if (speed[i] < 0.35 * vmax || speed[i] < speed[i - 1] || speed[i] < speed[i + 1]) continue;
    if (!raised(i) || !finished(i) || !nearLow(i)) continue;
    const last = peaks[peaks.length - 1];
    if (last && t[i] - t[last] < 2.5) { if (score(i) > score(last)) peaks[peaks.length - 1] = i; continue; }
    peaks.push(i);
  }
  // 窗口起点：从击球往回找，越过上杆顶点后，第一个「双手低于髋部且基本静止」的帧就是准备姿势，再往前留 0.5 秒。
  // 上杆慢、顶点停顿久的挥杆，准备姿势可能在击球前 3 秒以上；找不到时退回固定的 before 秒
  const addressStart = (i) => {
    let j = i;
    while (j > 0 && t[i] - t[j] <= 6 && !up(j)) j--;
    while (j > 0 && t[i] - t[j] <= 6) {
      if (!up(j) && B[j].hands.y > B[j].hipMid.y && speed[j] < 0.1 * vmax) return t[j] - 0.5;
      j--;
    }
    return t[i] - before;
  };
  return peaks.map((i, k) => ({
    peak: t[i],
    start: Math.max(t[0], Math.min(t[i] - before, addressStart(i)), k > 0 ? t[peaks[k - 1]] + 1.2 : -Infinity),
    end: Math.min(t[n - 1], t[i] + after, k < peaks.length - 1 ? t[peaks[k + 1]] - 2 : Infinity),
  }));
}
