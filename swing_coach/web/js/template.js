// 职业挥杆模板：一个参数化的 3D 火柴人，按 P1–P10 每个位置的职业球员典型参数摆姿势，
// 再投影成正面（face-on）或侧面（down-the-line）2D 关键点，用来叠加对比、标定相位检测阈值。
//
// 3D 坐标（右手球员）：x 指向目标，y 向上，z 指向球（球员胸口朝 +z）。脚踝在 y=0。

import { NUM_LANDMARKS } from './geometry.js';

export const POSITIONS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];

export const POSITION_INFO = {
  P1: { name: '准备站位', desc: 'Address：静止准备击球' },
  P2: { name: '起杆', desc: 'Takeaway：上杆中杆身与地面平行' },
  P3: { name: '上杆中段', desc: '上杆中前臂（左臂）与地面平行' },
  P4: { name: '上杆顶点', desc: 'Top：上杆到顶、转换方向前' },
  P5: { name: '下杆早段', desc: '下杆中前臂与地面平行' },
  P6: { name: '下杆释放前', desc: '下杆中杆身与地面平行' },
  P7: { name: '击球', desc: 'Impact：杆头触球' },
  P8: { name: '送杆', desc: '击球后杆身与地面平行' },
  P9: { name: '收杆前段', desc: '击球后后臂（右臂）与地面平行' },
  P10: { name: '收杆', desc: 'Finish：完成收杆、保持平衡' },
};

// 每个位置的模板参数（度 / 身体单位）。
// hip/shoulder：转动角，上杆为正、下杆朝目标打开为负；bend：脊柱前倾；tilt：脊柱向远离目标侧的侧倾；
// arm：双手在挥杆平面内绕胸口转过的角度；club：杆身在平面内转过的角度；
// shiftX：骨盆朝目标的平移；shiftZ：骨盆朝球的平移（正值即「提前伸展」）；kneeL/kneeT：前/后膝前屈量。
export const PRO_PARAMS = {
  P1: { hip: 0, shoulder: 0, bend: 40, tilt: 5, arm: 0, club: 0, shiftX: 0, shiftZ: 0, kneeL: 0.07, kneeT: 0.07, heelUp: 0 },
  P2: { hip: 12, shoulder: 35, bend: 40, tilt: 6, arm: 30, club: 90, shiftX: -0.008, shiftZ: 0, kneeL: 0.075, kneeT: 0.07, heelUp: 0 },
  P3: { hip: 30, shoulder: 70, bend: 39, tilt: 8, arm: 80, club: 175, shiftX: -0.012, shiftZ: -0.005, kneeL: 0.085, kneeT: 0.065, heelUp: 0 },
  P4: { hip: 45, shoulder: 92, bend: 38, tilt: 9, arm: 125, club: 262, shiftX: -0.01, shiftZ: -0.01, kneeL: 0.09, kneeT: 0.065, heelUp: 0 },
  P5: { hip: 22, shoulder: 62, bend: 38, tilt: 14, arm: 85, club: 190, shiftX: 0.035, shiftZ: -0.015, kneeL: 0.085, kneeT: 0.08, heelUp: 0 },
  P6: { hip: -10, shoulder: 30, bend: 37, tilt: 20, arm: 40, club: 100, shiftX: 0.055, shiftZ: -0.015, kneeL: 0.06, kneeT: 0.09, heelUp: 0.01 },
  P7: { hip: -40, shoulder: -22, bend: 36, tilt: 24, arm: -12, club: -6, shiftX: 0.07, shiftZ: -0.015, kneeL: 0.03, kneeT: 0.1, heelUp: 0.03 },
  P8: { hip: -55, shoulder: -60, bend: 34, tilt: 25, arm: -42, club: -95, shiftX: 0.075, shiftZ: -0.01, kneeL: 0.02, kneeT: 0.11, heelUp: 0.05 },
  P9: { hip: -70, shoulder: -95, bend: 28, tilt: 21, arm: -85, club: -180, shiftX: 0.085, shiftZ: 0, kneeL: 0.015, kneeT: 0.12, heelUp: 0.07 },
  P10: { hip: -90, shoulder: -120, bend: 10, tilt: 8, arm: -150, club: -255, shiftX: 0.13, shiftZ: 0, kneeL: 0.01, kneeT: 0.14, heelUp: 0.1 },
};

// 球杆差异：一号木站位更宽、脊柱侧倾更大、手位更居中
const CLUB_ADJUST = {
  iron: { halfStance: 0.17, tiltAdd: 0, handsX: 0.025, ballZ: 0.44 },
  driver: { halfStance: 0.215, tiltAdd: 5, handsX: -0.005, ballZ: 0.52 },
};

// ---------- 3D 小工具 ----------
const v3 = (x, y, z) => ({ x, y, z });
const add3 = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub3 = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const mul3 = (a, k) => v3(a.x * k, a.y * k, a.z * k);
const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross3 = (a, b) => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const len3 = (a) => Math.sqrt(dot3(a, a));
const norm3 = (a) => mul3(a, 1 / len3(a));
const R = Math.PI / 180;

// Rodrigues 旋转：v 绕单位轴 k 转 ang 度
function rotate(v, k, ang) {
  const c = Math.cos(ang * R);
  const s = Math.sin(ang * R);
  return add3(add3(mul3(v, c), mul3(cross3(k, v), s)), mul3(k, dot3(k, v) * (1 - c)));
}

// 两段式手臂：已知肩、手位置和上臂/前臂长度，求肘部；手臂伸不直时肘部朝 bendDir 方向弯
function elbow(shoulder, hand, upper, fore, bendDir) {
  const d = sub3(hand, shoulder);
  const L = len3(d);
  const u = mul3(d, 1 / L);
  if (L >= upper + fore) return add3(shoulder, mul3(u, upper * (L / (upper + fore))));
  const a = (upper * upper - fore * fore + L * L) / (2 * L);
  const h = Math.sqrt(Math.max(0, upper * upper - a * a));
  let perp = sub3(bendDir, mul3(u, dot3(bendDir, u)));
  perp = len3(perp) < 1e-6 ? v3(0, -1, 0) : norm3(perp);
  return add3(add3(shoulder, mul3(u, a)), mul3(perp, h));
}

const X = v3(1, 0, 0);
const Y = v3(0, 1, 0);
const Z = v3(0, 0, 1);

function spineAxis(bend, tilt) {
  // 先前倾（绕 x，头朝 +z），再侧倾（绕 z，头朝 -x，即远离目标）
  return rotate(rotate(Y, X, bend), Z, tilt);
}

// 计算一组参数下的 3D 关节位置
export function pose3D(params, club = 'iron') {
  const adj = CLUB_ADJUST[club] || CLUB_ADJUST.iron;
  const p = { ...params, tilt: params.tilt + adj.tiltAdd };
  const P1 = { ...PRO_PARAMS.P1, tilt: PRO_PARAMS.P1.tilt + adj.tiltAdd };

  const HIP_H = 0.5, SPINE = 0.31, NECK = 0.13, HALF_SH = 0.17, HALF_HIP = 0.1;
  const UPPER = 0.18, FORE = 0.175;

  const ankleL = v3(adj.halfStance, 0, 0);
  const ankleT = v3(-adj.halfStance, 0, 0);

  // 准备姿势下的胸口（挥杆圆心）与手的位置 —— 挥杆平面由此确定，不随身体参数变化
  const hipMid0 = v3(0, HIP_H, -0.05);
  const sh0 = add3(hipMid0, mul3(spineAxis(P1.bend, P1.tilt), SPINE));
  const hands0 = v3(adj.handsX, 0.42, 0.2);
  const ball = v3(adj.handsX * 0.4, 0.02, adj.ballZ);
  const club0 = sub3(ball, hands0);
  const center = sh0;
  // 挥杆平面包含目标线和「球 → 胸口」连线；法向量的方向让正角度把手带向远离目标侧
  const planeN = norm3(cross3(norm3(sub3(center, ball)), X));

  const hipMid = add3(hipMid0, v3(p.shiftX, 0, p.shiftZ));
  const s = spineAxis(p.bend, p.tilt);
  const shMid = add3(hipMid, mul3(s, SPINE));

  const hipOff = rotate(v3(HALF_HIP, 0, 0), Y, -p.hip);
  const hipL = add3(hipMid, hipOff);
  const hipT = sub3(hipMid, hipOff);

  // 肩线：垂直于脊柱的「目标方向」，再绕脊柱转动
  let shLine = sub3(X, mul3(s, dot3(X, s)));
  shLine = rotate(norm3(shLine), s, -p.shoulder);
  const shL = add3(shMid, mul3(shLine, HALF_SH));
  const shT = sub3(shMid, mul3(shLine, HALF_SH));
  const head = add3(shMid, mul3(s, NECK));

  const handOffset = sub3(hands0, center);
  let hands = add3(add3(center, rotate(handOffset, planeN, p.arm)), v3(p.shiftX * 0.6, 0, 0));
  // 职业球员前臂基本伸直：手离前肩超过手臂长度时，把手拉回到臂长范围内
  const reach = sub3(hands, shL);
  const maxReach = UPPER + FORE;
  if (len3(reach) > maxReach) hands = add3(shL, mul3(norm3(reach), maxReach));
  const shaft = rotate(club0, planeN, p.club);
  const shaftDir = norm3(shaft);
  const wristL = hands;
  const wristT = add3(hands, mul3(shaftDir, 0.035));
  const clubHead = add3(hands, shaft);

  const elbowL = elbow(shL, wristL, UPPER, FORE, v3(0, -0.3, 1));
  const elbowT = elbow(shT, wristT, UPPER, FORE, v3(0, -1, 0));

  const knee = (hip, ankle, fwd, inward) => add3(mul3(add3(hip, ankle), 0.5), v3(inward, 0, fwd));
  const kneeL = knee(hipL, ankleL, p.kneeL, -0.01);
  const kneeT = knee(hipT, ankleT, p.kneeT, 0.01 + Math.max(0, p.kneeT - 0.09) * 0.8);

  const heelT = add3(ankleT, v3(0, p.heelUp, -0.05));
  const heelL = add3(ankleL, v3(0, 0, -0.05));
  const footT = add3(ankleT, v3(0.01, 0, 0.13));
  const footL = add3(ankleL, v3(0.03, 0, 0.13));

  return {
    head, shL, shT, elbowL, elbowT, wristL, wristT, hipL, hipT, kneeL, kneeT,
    ankleL, ankleT, heelL, heelT, footL, footT, hands, clubHead, ball,
  };
}

// 投影到 2D 图像坐标（x 向右、y 向下，单位为图像高度）
// face-on：相机在球员正前方 (+z)，目标在画面右侧；down-the-line：相机在球员身后目标线延长线上，球在画面右侧
export function project(j3, view, frame = { cx: 0.9, ground: 0.92, s: 0.85 }) {
  const out = {};
  for (const [k, p] of Object.entries(j3)) {
    const h = view === 'dtl' ? p.z : p.x;
    out[k] = { x: frame.cx + h * frame.s, y: frame.ground - p.y * frame.s, v: 1 };
  }
  return out;
}

// 2D 关节 → MediaPipe 33 点数组（右手球员：前侧 = 左半身）
export function toLandmarks(j2, handed = 'right') {
  const lm = new Array(NUM_LANDMARKS).fill(null).map(() => ({ ...j2.head }));
  const lead = handed === 'left'
    ? { sh: 12, el: 14, wr: 16, hip: 24, kn: 26, an: 28, he: 30, ft: 32 }
    : { sh: 11, el: 13, wr: 15, hip: 23, kn: 25, an: 27, he: 29, ft: 31 };
  const trail = handed === 'left'
    ? { sh: 11, el: 13, wr: 15, hip: 23, kn: 25, an: 27, he: 29, ft: 31 }
    : { sh: 12, el: 14, wr: 16, hip: 24, kn: 26, an: 28, he: 30, ft: 32 };
  const set = (i, p) => { lm[i] = { x: p.x, y: p.y, v: p.v ?? 1 }; };
  set(0, j2.head);
  set(lead.sh, j2.shL); set(trail.sh, j2.shT);
  set(lead.el, j2.elbowL); set(trail.el, j2.elbowT);
  set(lead.wr, j2.wristL); set(trail.wr, j2.wristT);
  set(lead.hip, j2.hipL); set(trail.hip, j2.hipT);
  set(lead.kn, j2.kneeL); set(trail.kn, j2.kneeT);
  set(lead.an, j2.ankleL); set(trail.an, j2.ankleT);
  set(lead.he, j2.heelL); set(trail.he, j2.heelT);
  set(lead.ft, j2.footL); set(trail.ft, j2.footT);
  return lm;
}

function mirror3(j3) {
  const out = {};
  for (const [k, p] of Object.entries(j3)) out[k] = v3(-p.x, p.y, p.z);
  return out;
}

// 某个 P 位置的模板 2D 关键点 + 球杆（杆头、球）
export function templatePose(position, { view = 'fo', club = 'iron', handed = 'right', params } = {}) {
  let j3 = pose3D(params || PRO_PARAMS[position], club);
  if (handed === 'left') j3 = mirror3(j3);
  const j2 = project(j3, view);
  return { landmarks: toLandmarks(j2, handed), clubHead: j2.clubHead, hands: j2.hands, ball: j2.ball };
}

// ---------- 合成挥杆（演示与测试用） ----------
// 节奏：上杆 : 下杆 ≈ 3 : 1（职业球员典型节奏）
export const PRO_TIMING = { P1: 0, P2: 0.27, P3: 0.55, P4: 0.84, P5: 0.98, P6: 1.05, P7: 1.12, P8: 1.2, P9: 1.32, P10: 1.75 };

function lerpParams(a, b, f) {
  const o = {};
  for (const k of Object.keys(a)) o[k] = a[k] + (b[k] - a[k]) * f;
  return o;
}

export function paramsAt(t, timing = PRO_TIMING, table = PRO_PARAMS) {
  if (t <= timing.P1) return { ...table.P1 };
  for (let i = 0; i < POSITIONS.length - 1; i++) {
    const a = POSITIONS[i], b = POSITIONS[i + 1];
    if (t <= timing[b]) {
      const f = (t - timing[a]) / (timing[b] - timing[a]);
      // P4 附近用缓动，模拟上杆顶点的减速与转换
      const ease = a === 'P3' ? Math.sin((f * Math.PI) / 2) : a === 'P4' ? 1 - Math.cos((f * Math.PI) / 2) : f;
      return lerpParams(table[a], table[b], ease);
    }
  }
  return { ...table.P10 };
}

// 生成一段合成视频的逐帧关键点：前后各有静止段
export function syntheticSwing({
  fps = 60, lead = 0.6, tail = 0.6, view = 'fo', club = 'iron', handed = 'right',
  timing = PRO_TIMING, table = PRO_PARAMS, noise = 0, seed = 1,
} = {}) {
  let r = seed;
  const rand = () => { r = (r * 16807) % 2147483647; return r / 2147483647 - 0.5; };
  const total = lead + timing.P10 + tail;
  const frames = [];
  for (let i = 0; Math.round(i) <= Math.round(total * fps); i++) {
    const t = i / fps;
    const params = paramsAt(t - lead, timing, table);
    const { landmarks } = templatePose(null, { view, club, handed, params });
    frames.push({
      t,
      lm: landmarks.map((p) => ({ x: p.x + rand() * noise, y: p.y + rand() * noise, v: 0.99 })),
    });
  }
  const truth = Object.fromEntries(POSITIONS.map((p) => [p, Math.round((lead + timing[p]) * fps)]));
  return { frames, fps, truth };
}
