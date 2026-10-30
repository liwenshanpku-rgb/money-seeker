// 2D 几何工具与 MediaPipe Pose 关键点索引。
// 坐标约定：x 向右、y 向下，单位为「视频高度」（x 已乘以宽高比），这样角度不受画幅影响。

export const LM = {
  NOSE: 0,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
  L_HEEL: 29, R_HEEL: 30,
  L_FOOT: 31, R_FOOT: 32,
};

export const NUM_LANDMARKS = 33;

// 画骨架用的连线
export const BONES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32],
];

const LEFT = { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27, heel: 29, foot: 31 };
const RIGHT = { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28, heel: 30, foot: 32 };

// 右手球员的前侧（靠近目标）是左半身；左手球员相反。MediaPipe 的 left/right 指被拍者自身的左右。
export function sides(handed) {
  return handed === 'left' ? { lead: RIGHT, trail: LEFT } : { lead: LEFT, trail: RIGHT };
}

export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a, k) => ({ x: a.x * k, y: a.y * k });
export const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, v: Math.min(a.v ?? 1, b.v ?? 1) });
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const deg = (r) => (r * 180) / Math.PI;
export const rad = (d) => (d * Math.PI) / 180;
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 关节 b 处的夹角（度），a-b-c 伸直时为 180
export function angleAt(a, b, c) {
  const u = sub(a, b);
  const w = sub(c, b);
  const n = Math.hypot(u.x, u.y) * Math.hypot(w.x, w.y);
  if (n === 0) return NaN;
  return deg(Math.acos(clamp((u.x * w.x + u.y * w.y) / n, -1, 1)));
}

// 向量 from→to 相对竖直向上的倾角（度），向 dirSign 方向倾斜为正
export function tiltFromVertical(from, to, dirSign) {
  const d = sub(to, from);
  return deg(Math.atan2(d.x * dirSign, -d.y));
}

// 把一帧关键点整理成具名身体部位
export function body(lm, handed) {
  const { lead, trail } = sides(handed);
  const p = (i) => lm[i];
  const b = {
    head: p(LM.NOSE),
    leadShoulder: p(lead.shoulder), trailShoulder: p(trail.shoulder),
    leadElbow: p(lead.elbow), trailElbow: p(trail.elbow),
    leadWrist: p(lead.wrist), trailWrist: p(trail.wrist),
    leadHip: p(lead.hip), trailHip: p(trail.hip),
    leadKnee: p(lead.knee), trailKnee: p(trail.knee),
    leadAnkle: p(lead.ankle), trailAnkle: p(trail.ankle),
  };
  b.shoulderMid = mid(b.leadShoulder, b.trailShoulder);
  b.hipMid = mid(b.leadHip, b.trailHip);
  b.ankleMid = mid(b.leadAnkle, b.trailAnkle);
  b.hands = mid(b.leadWrist, b.trailWrist);
  return b;
}

export function meanVisibility(points) {
  if (!points.length) return 0;
  return points.reduce((s, q) => s + (q.v ?? 1), 0) / points.length;
}
