// 用球确定击球帧：准备时找到地上的球（脚附近一个小而亮的圆点，不在鞋上），
// 下杆时这一小块画面第一次明显变化（杆头到了、或者球飞走了）的那一帧就是击球。
// 双手在击球前后每帧移动很大，按手的速度只能猜个大概；球的变化能精确到 ±1 帧。
// 只依赖灰度像素数组，浏览器和 Node（测试）里都能运行。

const torsoOf = (lm) => Math.hypot((lm[11].x + lm[12].x - lm[23].x - lm[24].x) / 2, (lm[11].y + lm[12].y - lm[23].y - lm[24].y) / 2);

// 圆点度：圆盘内平均亮度减去外圈 8 个方向各自的平均亮度，取最小的那个方向。
// 球在各个方向上都比周围亮；杆身、裤子上的亮线沿着线的方向不比周围亮，得分就低。
function blobScore(g, w, h, cx, cy, r) {
  let inS = 0, inN = 0;
  const sec = new Float64Array(8), secN = new Float64Array(8);
  const R = Math.ceil(2 * r);
  if (cx - R < 0 || cx + R >= w || cy - R < 0 || cy + R >= h) return -Infinity;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const d = Math.hypot(dx, dy), v = g[(cy + dy) * w + cx + dx];
      if (d <= r) { inS += v; inN++; } else if (d <= 2 * r) {
        const k = Math.min(7, Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * 8));
        sec[k] += v; secN[k]++;
      }
    }
  }
  const c = inS / inN;
  let worst = Infinity;
  for (let k = 0; k < 8; k++) worst = Math.min(worst, c - sec[k] / (secN[k] || 1));
  return worst;
}

const LEGS = [[23, 25], [25, 27], [24, 26], [26, 28]];
function nearLegs(lm, H, x, y, rad) {
  for (const [a, b] of LEGS) {
    const A = { x: lm[a].x * H, y: lm[a].y * H }, B = { x: lm[b].x * H, y: lm[b].y * H };
    const abx = B.x - A.x, aby = B.y - A.y, l2 = abx * abx + aby * aby || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - A.x) * abx + (y - A.y) * aby) / l2));
    if (Math.hypot(x - (A.x + t * abx), y - (A.y + t * aby)) < rad) return true;
  }
  return false;
}

/**
 * 在准备姿势那一帧里找球。lm 单位为图像高度（x 已乘宽高比），返回像素坐标 {x, y, r, score} 或 null。
 */
export function findBall(gray, w, h, lm, { view = 'fo', dir = 1 } = {}) {
  const H = h, torso = torsoOf(lm) * H;
  const px = (p) => ({ x: p.x * H, y: p.y * H });
  const feet = [27, 28, 29, 30, 31, 32].map((k) => px(lm[k]));
  const groundY = Math.max(...feet.map((p) => p.y));
  const xs = feet.map((p) => p.x);
  // 相机低、离得近时，球在画面上可能在脚下方很远（离镜头更近）
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - 1.2 * torso)), x1 = Math.min(w - 1, Math.ceil(Math.max(...xs) + 1.2 * torso));
  const y0 = Math.max(0, Math.floor(groundY - 0.5 * torso)), y1 = Math.min(h - 1, Math.ceil(groundY + 1.4 * torso));
  // 球的直径约是躯干长度的 8%（4.3 cm / 约 50 cm）；离镜头近时更大，试两种半径
  // 球在杆头旁边：正面看在双手正下方附近，侧面看在双手外侧约一个躯干长处。
  // 旁边球筐里的球同样是亮圆点，按离这个位置的水平距离降低得分
  const hx = (lm[15].x + lm[16].x) / 2 * H;
  const cx = view === 'dtl' ? hx + dir * 0.8 * torso : hx;
  const near = (x) => Math.exp(-(((x - cx) / (0.9 * torso)) ** 2));
  let best = null;
  for (const rf of [0.04, 0.06]) {
    const r = Math.max(2, Math.round(rf * torso));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        // 鞋子、裤腿也可能有亮点：离脚上关键点和腿太近的不算
        if (feet.some((f) => Math.hypot(f.x - x, f.y - y) < 0.22 * torso)) continue;
        if (nearLegs(lm, H, x, y, 0.15 * torso)) continue;
        const raw = blobScore(gray, w, h, x, y, r);
        const s = raw > 0 ? raw * near(x) : raw;
        if (!best || s > best.score) best = { x, y, r, score: s, contrast: raw };
      }
    }
  }
  return best && best.contrast > (globalThis.BALL_MIN ?? 15) ? best : null;
}

// 在 img 里、球上一次位置附近找和准备时的球最像的地方（手持拍摄画面会慢慢漂移）。
// 返回 { x, y, diff }：diff 是最佳位置的平均像素差，球还在时很小，被杆头挡住或飞走后变大。
export function trackBall(ref, ball, img, w, h, at, search) {
  const R = Math.ceil(ball.r * 1.6);
  const cost = (cx, cy) => {
    let s = 0, n = 0;
    for (let dy = -R; dy <= R; dy += 1) {
      for (let dx = -R; dx <= R; dx += 1) {
        const x = cx + dx, y = cy + dy, rx = ball.x + dx, ry = ball.y + dy;
        if (x < 0 || x >= w || y < 0 || y >= h || rx < 0 || rx >= w || ry < 0 || ry >= h) continue;
        s += Math.abs(img[y * w + x] - ref[ry * w + rx]); n++;
      }
    }
    return n ? s / n : Infinity;
  };
  let best = { x: at.x, y: at.y, diff: cost(at.x, at.y) };
  for (let dy = -search; dy <= search; dy += 2) {
    for (let dx = -search; dx <= search; dx += 2) {
      const c = cost(at.x + dx, at.y + dy);
      if (c < best.diff) best = { x: at.x + dx, y: at.y + dy, diff: c };
    }
  }
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const c = cost(best.x + dx, best.y + dy);
    if (c < best.diff) best = { x: best.x + dx, y: best.y + dy, diff: c };
  }
  return best;
}

/**
 * 找击球帧。frames：[{ t, lm }]；gray(i) 返回 { data, w, h }（与 lm 同一坐标系）；P 是已识别的位置。
 * 从准备姿势起逐帧跟踪球（每帧只允许小幅漂移），下杆后第一次「找不到球」的帧就是击球。
 * 返回 { frame, ball, trace } 或 null（没找到球、或上杆时球就不见了，说明找到的不是球）。
 */
export async function detectImpact(frames, P, { gray, maxAfter = 0.5, view, dir }) {
  const g1 = await gray(P.P1);
  const { w, h } = g1;
  const ball = findBall(g1.data, w, h, frames[P.P1].lm, { view, dir });
  if (!ball) return null;
  const torso = torsoOf(frames[P.P1].lm) * h;
  const search = Math.max(8, Math.round(0.15 * torso));
  // 准备时杆头贴在球旁边，起杆后杆头离开，这一小块会变；所以只用准备时的样子跟踪到上杆顶点（宽松阈值），
  // 再以顶点时（杆头早已离开）的球作为参照
  let at = { x: ball.x, y: ball.y };
  const step = Math.max(1, Math.floor((P.P4 - P.P1) / 12));
  for (let i = P.P1 + step; i < P.P4; i += step) {
    const m = trackBall(g1.data, ball, (await gray(i)).data, w, h, at, search);
    if (m.diff > 45) return null;
    at = m;
  }
  const g4 = await gray(P.P4);
  const m4 = trackBall(g1.data, ball, g4.data, w, h, at, search);
  if (m4.diff > 45) return null;
  const ref = g4.data, refBall = { ...ball, x: m4.x, y: m4.y };
  // 顶点前后几帧的典型差异（球静止时的噪声水平）
  const seen = [];
  for (let i = Math.max(P.P1, P.P4 - 4); i < P.P4; i++) seen.push(trackBall(ref, refBall, (await gray(i)).data, w, h, refBall, 3).diff);
  seen.sort((a, b) => a - b);
  const base = seen.length ? seen[seen.length >> 1] : 8;
  const trace = [];
  // 下杆时逐帧比较，相邻两帧之间画面漂移很小，只允许小范围移动——否则会跟着刚被打出去的球走
  const near = Math.max(4, Math.round(0.04 * torso));
  at = refBall;
  const limit = frames[P.P7].t + maxAfter;
  for (let i = P.P4 + 1; i < frames.length && frames[i].t <= limit; i++) {
    const m = trackBall(ref, refBall, (await gray(i)).data, w, h, at, near);
    trace.push([i, m.diff]);
    if (m.diff > Math.max(12, base * 1.8)) return { frame: i, ball: refBall, trace };
    at = m;
  }
  return null;
}
