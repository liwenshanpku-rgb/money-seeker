// 用球确定击球帧：在准备姿势里找到地上的球（脚附近一个小而亮的圆点，不在鞋上），逐帧检查这里还有没有球，
// 「球最后一次还在原地」之后的那一帧就是击球（杆头盖住球、或球被打走）。
// 双手在击球前后每帧移动很大，按手的速度只能猜个大概；慢动作视频结尾恢复正常速度时更会找错。
// 球的变化和视频怎么放慢无关，能精确到 ±1 帧。只依赖灰度像素数组，浏览器和 Node（测试）里都能运行。

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

/**
 * 不依赖 P 位置找击球帧：在第一帧（准备姿势）里找球，逐帧往后跟踪，
 * 「球最后一次还在原地」之后那一帧就是击球（之后球就再也不在了）。
 * 和视频怎么放慢、结尾是否恢复正常速度都无关，适合先用它作为 P7 的锚点。
 * 返回 { frame, ball } 或 null。
 */
export async function findImpactByBall(frames, { gray, view, dir, start = 0 }) {
  const g0 = await gray(start);
  const { w, h } = g0;
  const ball = findBall(g0.data, w, h, frames[start].lm, { view, dir });
  if (!ball) return null;
  const torso = torsoOf(frames[start].lm) * h;
  const near = Math.max(4, Math.round(0.04 * torso));
  // 「这里还有没有球」：附近小范围内圆点度最高的位置，圆点度不低于准备时的 45% 就算在。
  // 不和准备时的画面比，因为准备时杆头贴在球旁边，起杆后这一小块本来就会变
  const present = [];
  let at = { x: ball.x, y: ball.y };
  for (let i = start; i < frames.length; i++) {
    const g = (await gray(i)).data;
    let best = { x: at.x, y: at.y, s: -Infinity };
    for (let dy = -near; dy <= near; dy += 2) {
      for (let dx = -near; dx <= near; dx += 2) {
        const v = blobScore(g, w, h, at.x + dx, at.y + dy, ball.r);
        if (v > best.s) best = { x: at.x + dx, y: at.y + dy, s: v };
      }
    }
    const here = best.s >= 0.45 * ball.contrast;
    present.push(here);
    if (here) at = best; // 球还在时跟着画面漂移走
  }
  // 最后一个「球还在」的帧：之后的帧里球基本都不在（允许个别误判）
  for (let k = 0; k < present.length - 3; k++) {
    if (!present[k] || present[k + 1]) continue;
    const rest = present.slice(k + 1);
    if (rest.filter((x) => !x).length / rest.length >= 0.85) return { frame: start + k + 1, ball: { ...ball, x: at.x, y: at.y } };
  }
  return null;
}
