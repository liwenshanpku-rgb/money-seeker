// P1–P10 关键位置指标：从关键点计算数值，对比职业区间，给出问题诊断、改进方法和练习。
//
// 区间参考公开的职业巡回赛生物力学数据与主流教学体系（如 GEARS / TPI / AimPoint 教练常用的
// P-system 检查点），按 2D 视频可测的方式换算。2D 视频有透视误差，数值宜看趋势，不宜当作精确测量。

import { body, angleAt, tiltFromVertical, clamp, deg, meanVisibility } from './geometry.js';

const acosDeg = (r) => deg(Math.acos(clamp(r, 0, 1)));

// 髋部 / 肩部转动角（相对准备姿势，上杆方向为正、朝目标打开为负），逐帧。
// 正面：两点水平间距按 cos 缩短，大小 = acos(宽度比)；方向用时间判断——
//   P4 之后宽度最大的那一帧是「转回正对」的时刻，之前算关闭、之后算打开。
// 侧面：准备时两点几乎重叠，转动后在画面上拉开，大小 = asin(间距 / 真实宽度)；
//   前侧点朝球移动为关闭、远离球为打开，方向可以直接看出。真实宽度取整个挥杆中的最大间距
//  （收杆时髋、肩基本转到 90°），并用身体比例兜底。
export function rotationSeries(frames, P, { view, dir, handed, kind }) {
  const pts = (i) => {
    const b = body(frames[i].lm, handed);
    return kind === 'hip' ? [b.leadHip, b.trailHip] : [b.leadShoulder, b.trailShoulder];
  };
  const n = frames.length;
  const out = new Array(n).fill(0);
  if (view === 'fo') {
    const w1 = Math.abs(pts(P.P1)[0].x - pts(P.P1)[1].x) || 1e-6;
    const ratio = (i) => { const [a, b] = pts(i); return Math.min(1, Math.abs(a.x - b.x) / w1); };
    let iSq = P.P4, best = -1;
    for (let i = P.P4; i <= P.P10; i++) { const r = ratio(i); if (r > best) { best = r; iSq = i; } }
    for (let i = P.P1; i < n; i++) out[i] = acosDeg(ratio(i)) * (i < iSq ? 1 : -1);
    return out;
  }
  const b1 = body(frames[P.P1].lm, handed);
  const torso = Math.hypot(b1.shoulderMid.x - b1.hipMid.x, b1.shoulderMid.y - b1.hipMid.y) || 1e-6;
  // 肩部绕前倾的脊柱转动，侧面画面里肩线会变斜，所以用整段长度；方向看前肩是朝球、朝下（关闭）还是相反
  const sep = (i) => {
    const [a, b] = pts(i);
    const dx = (a.x - b.x) * dir, dy = a.y - b.y;
    if (kind === 'hip') return dx;
    return Math.hypot(dx, dy) * (dx + dy >= 0 ? 1 : -1);
  };
  let W = (kind === 'hip' ? 0.6 : 0.95) * torso;
  for (let i = P.P1; i <= P.P10; i++) W = Math.max(W, Math.abs(sep(i)));
  const ang = (i) => deg(Math.asin(clamp(sep(i) / W, -1, 1)));
  const a1 = ang(P.P1);
  for (let i = P.P1; i < n; i++) out[i] = ang(i) - a1;
  return out;
}

// 指标计算所需的上下文
export function makeContext(frames, P, { view, dir, handed, club }) {
  const B = (pos) => body(frames[P[pos]].lm, handed);
  const b1 = B('P1');
  const stance = Math.abs(b1.leadAnkle.x - b1.trailAnkle.x) || 1e-6;
  const torso = Math.hypot(b1.shoulderMid.x - b1.hipMid.x, b1.shoulderMid.y - b1.hipMid.y) || 1e-6;
  const ctx = {
    frames, P, view, dir, handed, club, B, b1, stance, torso,
    t: (pos) => frames[P[pos]].t,
    // 正面：朝目标方向的水平位移（站位宽度为单位）
    toTarget: (p, p0) => ((p.x - p0.x) * dir) / stance,
    // 侧面：朝球方向的水平位移（躯干长度为单位）
    toBall: (p, p0) => ((p.x - p0.x) * dir) / torso,
    // 侧面：向下位移（躯干长度为单位）
    drop: (p, p0) => (p.y - p0.y) / torso,
    spineTilt: (b) => tiltFromVertical(b.hipMid, b.shoulderMid, -dir),
    spineBend: (b) => tiltFromVertical(b.hipMid, b.shoulderMid, dir),
    shoulderTurn: (b) => acosDeg(Math.abs(b.leadShoulder.x - b.trailShoulder.x) / Math.abs(b1.leadShoulder.x - b1.trailShoulder.x)),
    hipTurn: (b) => acosDeg(Math.abs(b.leadHip.x - b.trailHip.x) / Math.abs(b1.leadHip.x - b1.trailHip.x)),
    rot: (kind, pos) => {
      ctx._rot ||= {};
      ctx._rot[kind] ||= rotationSeries(frames, P, { view, dir, handed, kind });
      return ctx._rot[kind][P[pos]];
    },
  };
  return ctx;
}

// 指标定义。range 可按球杆区分；low/high 分别是低于、高于区间时的诊断。
export const METRICS = [
  // ---------------- 正面（face-on） ----------------
  {
    id: 'fo_stance', view: 'fo', pos: 'P1', name: '站位宽度', unit: '× 肩宽', digits: 2,
    points: ['leadAnkle', 'trailAnkle', 'leadShoulder', 'trailShoulder'],
    value: (c) => { const b = c.b1; return Math.abs(b.leadAnkle.x - b.trailAnkle.x) / Math.abs(b.leadShoulder.x - b.trailShoulder.x); },
    range: { iron: [0.95, 1.45], driver: [1.2, 1.8] },
    about: '双脚踝间距与两肩间距之比。铁杆约与肩同宽，一号木更宽，给转体和重心转移提供稳定底座。',
    low: { issue: '站位过窄', why: '底座不稳，转体时容易晃动、失去平衡，也限制了下杆的重心转移。', fix: '铁杆让双脚内侧约与肩同宽，一号木再各向外加半只脚。', drill: '在双脚外侧各放一根对齐杆，固定站位宽度后连续空挥 10 次，感受稳定的下盘。' },
    high: { issue: '站位过宽', why: '髋部转动受限，上杆转不够、容易左右平移（sway）代替转体。', fix: '双脚往里收，铁杆以肩宽为准；感觉髋部能自由转动为宜。', drill: '缩窄站位做半挥杆练习，体会髋部转动而不是侧移。' },
  },
  {
    id: 'fo_p1_tilt', view: 'fo', pos: 'P1', name: '准备时脊柱侧倾', unit: '°', digits: 0,
    points: ['leadShoulder', 'trailShoulder', 'leadHip', 'trailHip'],
    value: (c) => c.spineTilt(c.b1),
    range: { iron: [2, 14], driver: [7, 20] },
    about: '从正面看上半身向远离目标侧的倾斜。后手握杆位置更低，所以后肩自然低于前肩。',
    low: { issue: '上半身没有侧倾 / 偏向目标', why: '容易形成上杆「反向脊柱角」和下杆过陡的切球路径，一号木尤其容易打低打右。', fix: '准备时后肩自然放低、胸骨略微落在球后方，头在球后侧。', drill: '把一根杆竖放在两脚中间，准备时让头部和胸骨位于这根杆的后方再挥杆。' },
    high: { issue: '侧倾过大', why: '重心被压在后脚，下杆难以向前转移，容易打厚、打出右曲或左曲。', fix: '减小侧倾，铁杆以后肩略低于前肩为度。', drill: '对镜子做准备姿势，让脊柱侧倾大约一个拳头的肩高差。' },
  },
  {
    id: 'fo_p1_hands', view: 'fo', pos: 'P1', name: '准备时手的位置', unit: '× 站宽', digits: 2,
    points: ['leadWrist', 'trailWrist', 'leadHip', 'trailHip'],
    value: (c) => c.toTarget(c.b1.hands, c.b1.hipMid),
    range: { iron: [-0.03, 0.2], driver: [-0.1, 0.1] },
    about: '双手相对身体中心的左右位置。铁杆双手略靠前（目标侧）形成轻微杆身前倾，一号木接近居中。',
    low: { issue: '双手偏后', why: '杆面在准备时就打开、杆身后倾，容易挑球和打薄。', fix: '铁杆让双手位于前大腿内侧；一号木双手大致在身体中线。', drill: '准备时检查：前臂和杆身从正面看接近一条直线（铁杆）。' },
    high: { issue: '双手过度靠前', why: '杆身前倾过大，杆面容易被关闭或杆头触地过陡、打出深草皮。', fix: '双手收回到前大腿内侧即可，不要刻意前压。', drill: '准备时让杆头底部平贴地面，以此决定手的位置。' },
  },
  {
    id: 'fo_p2_sway', view: 'fo', pos: 'P2', name: '起杆骨盆侧移', unit: '× 站宽', digits: 2,
    points: ['leadHip', 'trailHip'],
    value: (c) => -c.toTarget(c.B('P2').hipMid, c.b1.hipMid),
    range: { iron: [-0.06, 0.08], driver: [-0.06, 0.1] },
    about: '起杆阶段骨盆向后侧（远离目标）的平移。起杆应由肩膀、手臂和躯干一起转动带动，骨盆基本不动。',
    low: { issue: '起杆时骨盆就向目标侧移动', why: '早早形成反向重心，上杆顶点重心在前脚，下杆反而要往后倒。', fix: '起杆时保持骨盆位置，感觉是胸口向后转而不是身体往前压。', drill: '前侧髋部外侧贴一根对齐杆（或墙），起杆时髋部不要碰到它。' },
    high: { issue: '起杆骨盆过早向后滑动（sway）', why: '用平移代替转动，后续上杆容易转不足，下杆还要先移回来，时机难掌握。', fix: '想象后侧大腿内侧夹住，起杆时后髋向后「转」而不是向侧边「滑」。', drill: '后脚外侧立一根对齐杆，起杆到 P2 时后髋不能碰到。' },
  },
  {
    id: 'fo_p3_leadarm', view: 'fo', pos: 'P3', name: '上杆中前臂伸直度', unit: '°', digits: 0,
    points: ['leadShoulder', 'leadElbow', 'leadWrist'],
    value: (c) => { const b = c.B('P3'); return angleAt(b.leadShoulder, b.leadElbow, b.leadWrist); },
    range: { iron: [150, 181], driver: [150, 181] },
    about: '前臂（右手球员的左臂）肘关节夹角。前臂保持伸展能维持挥杆半径和击球一致性。',
    low: { issue: '前臂过早弯曲', why: '挥杆半径变小，下杆要重新伸直手臂，触球点不稳定、距离损失。', fix: '让躯干转动带着手臂走，而不是靠弯曲手臂把杆抬起来。', drill: '在两前臂间夹一个小球或毛巾做半挥杆，保持手臂与胸口的三角结构。' },
    high: null,
  },
  {
    id: 'fo_p3_head', view: 'fo', pos: 'P3', name: '上杆中头部侧移', unit: '× 站宽', digits: 2,
    points: ['head'],
    value: (c) => -c.toTarget(c.B('P3').head, c.b1.head),
    range: { iron: [-0.06, 0.18], driver: [-0.06, 0.22] },
    about: '头部向后侧的平移。上杆时头允许随转体轻微后移，但不应前移或大幅后移。',
    low: { issue: '头部向目标侧移动', why: '典型的「反向重心」上杆，下杆时身体往后倒，容易打厚、打出高飘右曲。', fix: '上杆时让胸口转向后侧，头保持在原位或轻微后移。', drill: '对着镜子或在头部前侧立一根杆，上杆时头不要越过它。' },
    high: { issue: '头部大幅后移', why: '整个上身向后侧晃动，下杆需要额外的回移，击球点前后漂移。', fix: '以脊柱为轴转动，感觉后侧髋和肩向后转，而不是整个人往后挪。', drill: '同伴从正面用手轻扶你的头部外侧，做慢速上杆，体会头部稳定。' },
  },
  {
    id: 'fo_p4_shoulder', view: 'fo', pos: 'P4', name: '上杆顶点肩部转动（估算）', unit: '°', digits: 0,
    points: ['leadShoulder', 'trailShoulder'],
    value: (c) => c.shoulderTurn(c.B('P4')),
    range: { iron: [72, 115], driver: [78, 120] },
    about: '由正面画面中两肩投影宽度的缩短估算的肩部转动角，职业球员约 90°。仅为估算。',
    low: { issue: '肩部转动不足', why: '上杆蓄力不够，容易靠手臂发力、出现由外向内的下杆路径。', fix: '上杆到顶时让前肩转到下巴下方、背部对着目标。', drill: '双臂交叉抱胸，做转体练习，直到背部正对目标；再带杆做同样的感觉。' },
    high: { issue: '肩部转动过大', why: '可能是过度转动或上杆过长，容易失去控制和节奏。', fix: '在保持前臂伸展、后膝弯曲的前提下转到能控制的位置即可。', drill: '做 3/4 上杆练习，体会紧凑但完整的转体。' },
  },
  {
    id: 'fo_p4_hip', view: 'fo', pos: 'P4', name: '上杆顶点髋部转动（估算）', unit: '°', digits: 0,
    points: ['leadHip', 'trailHip'],
    value: (c) => c.hipTurn(c.B('P4')),
    range: { iron: [28, 62], driver: [30, 65] },
    about: '由两髋投影宽度估算的髋部转动，职业球员约 45°，肩髋差（X-factor）是下杆力量来源。',
    low: { issue: '髋部转动不足', why: '柔韧性不足或刻意锁住下半身，肩部也难以转到位，容易受伤。', fix: '允许前膝向内、后髋向后转，让髋部跟随上身转动。', drill: '双手抱杆在胸前做上杆转体，让前膝指向球的后方。' },
    high: { issue: '髋部转动过多', why: '上下半身扭转差变小，蓄力丢失；常伴随后膝伸直。', fix: '保持后膝弯曲，用髋部的阻力让肩部转动「拧」起来。', drill: '在后膝外侧放一个球，上杆时后膝不要伸直、不要外移。' },
  },
  {
    id: 'fo_p4_sway', view: 'fo', pos: 'P4', name: '上杆顶点骨盆侧移', unit: '× 站宽', digits: 2,
    points: ['leadHip', 'trailHip'],
    value: (c) => -c.toTarget(c.B('P4').hipMid, c.b1.hipMid),
    range: { iron: [-0.06, 0.14], driver: [-0.06, 0.18] },
    about: '上杆到顶时骨盆向后侧的平移。转动而不是平移，后髋应在后脚上方以内。',
    low: { issue: '上杆骨盆移向目标（反向重心）', why: '顶点重心在前脚，下杆反而后倒，是打厚和右曲的常见根源。', fix: '上杆时重心随转动落到后脚内侧，后髋向后转。', drill: '上杆到顶停 2 秒，检查重心是否在后脚内侧、前脚跟是否只是轻压地面。' },
    high: { issue: '上杆骨盆向后滑动（sway）', why: '后髋越过后脚外侧，力量泄漏，下杆来不及移回导致击球点不稳。', fix: '后膝保持弯曲朝前，后髋在后脚上方「转」。', drill: '后脚外侧立对齐杆，上杆到顶后髋不要碰到。' },
  },
  {
    id: 'fo_p4_head', view: 'fo', pos: 'P4', name: '上杆顶点头部侧移', unit: '× 站宽', digits: 2,
    points: ['head'],
    value: (c) => -c.toTarget(c.B('P4').head, c.b1.head),
    range: { iron: [-0.05, 0.2], driver: [-0.05, 0.25] },
    about: '上杆到顶时头部相对准备姿势的左右移动。',
    low: { issue: '头部前移（反向重心）', why: '下杆时身体往后倒，杆头最低点跑到球后。', fix: '上杆时让头保持或轻微后移，胸口转向后侧。', drill: '头顶对着墙或杆做慢速上杆，保持头部接触不变。' },
    high: { issue: '头部后移过多', why: '上身随杆向后晃，下杆回不到原位，触球不稳定。', fix: '把上杆想成「原地转」，头部稳定在两脚之间偏后。', drill: '对镜做上杆，头部移动不超过半个头宽。' },
  },
  {
    id: 'fo_p4_tilt', view: 'fo', pos: 'P4', name: '上杆顶点脊柱侧倾', unit: '°', digits: 0,
    points: ['leadShoulder', 'trailShoulder', 'leadHip', 'trailHip'],
    value: (c) => c.spineTilt(c.B('P4')),
    range: { iron: [2, 20], driver: [5, 24] },
    about: '上杆到顶时上半身仍应保持向后侧的倾斜。偏向目标即「反向脊柱角」。',
    low: { issue: '反向脊柱角（上身倒向目标）', why: '下杆时上身后倒，容易打厚、拉左或右曲，且对腰椎压力大。', fix: '上杆时让后侧身体变「长」、前肩向下转，上身不要向目标侧倾倒。', drill: '上杆到顶对镜检查：上半身应略向后侧倾斜，头在球后方。' },
    high: { issue: '上杆侧倾过大', why: '上身过度向后倒，下杆难以把重心移回前脚。', fix: '上杆以转动为主，避免向后侧压。', drill: '双手抱胸做转体，保持脊柱角度不变。' },
  },
  {
    id: 'fo_p4_leadarm', view: 'fo', pos: 'P4', name: '上杆顶点前臂伸直度', unit: '°', digits: 0,
    points: ['leadShoulder', 'leadElbow', 'leadWrist'],
    value: (c) => { const b = c.B('P4'); return angleAt(b.leadShoulder, b.leadElbow, b.leadWrist); },
    range: { iron: [145, 181], driver: [145, 181] },
    about: '上杆到顶前臂肘角。职业球员前臂基本伸直（不必僵硬），保持挥杆宽度。',
    low: { issue: '顶点前臂弯曲（「鸡翅」式上杆）', why: '挥杆弧变窄、上杆过长，下杆击球时机难以控制。', fix: '缩短上杆，以前臂保持伸展为上杆终点。', drill: '只用前手握杆做慢速上杆，前臂伸直时就停住，体会这个长度。' },
    high: null,
  },
  {
    id: 'fo_p5_shift', view: 'fo', pos: 'P5', name: '下杆早段骨盆前移', unit: '× 站宽', digits: 2,
    points: ['leadHip', 'trailHip'],
    value: (c) => c.toTarget(c.B('P5').hipMid, c.b1.hipMid),
    range: { iron: [0.0, 0.3], driver: [0.0, 0.3] },
    about: '下杆一开始骨盆向目标侧的移动。职业球员先「移」再「转」，重心开始压向前脚。',
    low: { issue: '下杆没有向前转移重心', why: '重心留在后脚，杆头最低点在球后，容易打厚、打薄、挑球。', fix: '转换时先让前膝和前髋向目标方向移动，再开始转。', drill: '「踏步挥杆」：上杆时前脚靠拢后脚，下杆开始时前脚向目标踏出再挥下。' },
    high: { issue: '下杆骨盆前冲过多', why: '下半身滑过头，上身被甩在后面，容易推右或右曲。', fix: '下杆的前移以前髋到前脚上方为止，然后转动。', drill: '前脚外侧立对齐杆，下杆时前髋可以接近但不要撞过它。' },
  },
  {
    id: 'fo_p6_shift', view: 'fo', pos: 'P6', name: '下杆释放前骨盆前移', unit: '× 站宽', digits: 2,
    points: ['leadHip', 'trailHip'],
    value: (c) => c.toTarget(c.B('P6').hipMid, c.b1.hipMid),
    range: { iron: [0.04, 0.35], driver: [0.03, 0.33] },
    about: '杆身下到与地面平行时，骨盆应已明显移向目标侧。',
    low: { issue: '重心转移不足', why: '击球时重心在后脚，打不出压缩感，铁杆难以先球后草。', fix: '下杆让前髋先移动到前脚上方，后膝向前膝方向靠。', drill: '在球前方约 10 厘米放一枚硬币，练习「先打球、再打硬币」。' },
    high: { issue: '下半身滑动过多', why: '下身滑过头，杆面来不及回正。', fix: '前腿形成稳定支撑，把前移转换为转动。', drill: '前脚外侧立对齐杆，下杆前髋不要撞过它。' },
  },
  {
    id: 'fo_p6_head', view: 'fo', pos: 'P6', name: '下杆头部位置', unit: '× 站宽', digits: 2,
    points: ['head'],
    value: (c) => c.toTarget(c.B('P6').head, c.b1.head),
    range: { iron: [-0.4, 0.06], driver: [-0.45, 0.03] },
    about: '下杆时头部应保持在准备位置或略靠后（「留在球后」），下半身向前而头不跟着冲。',
    low: { issue: '头部向后倒过多', why: '上身后仰，杆头最低点后移，容易打厚或挑球。', fix: '下杆时让胸口跟着髋部转向目标，不要刻意往后仰。', drill: '慢速下杆到 P6 停住，检查头部是否仍在两脚之间偏后。' },
    high: { issue: '头部前冲（越过球）', why: '上身抢先，出杆角度过陡，容易拉左、打深草皮。', fix: '下杆让下半身先动，头部留在球后方。', drill: '在头部前侧放一根竖杆作为参照，下杆到击球头不要越过它。' },
  },
  {
    id: 'fo_p6_hipopen', view: 'fo', pos: 'P6', name: '下杆髋部打开（估算）', unit: '°', digits: 0,
    points: ['leadHip', 'trailHip'],
    value: (c) => -c.rot('hip', 'P6'),
    range: { iron: [5, 40], driver: [3, 40] },
    about: '杆身下到与地面平行时，髋部朝目标打开的角度（估算，负值表示还没转回正对）。职业球员此时髋部已经打开 10–25°，比肩部先转。',
    low: { issue: '下杆转髋不够（髋部滞后）', why: '下杆没有由下半身启动，手臂和肩膀先把杆拉下来，容易出现由外向内的路径、左拉或为了救球翻手。', fix: '到顶点后先让前侧臀部向后、向目标方向转（感觉前侧裤兜往身后走），手臂「等一下」，被身体转动带下来。', drill: '贴墙转髋：准备时臀部轻碰身后的墙，下杆时让前侧臀部沿墙往后滑、后侧臀部离开墙。空手 2 组 × 10 次，再拿杆半挥 20 次。' },
    high: { issue: '下杆髋部打开过早过多', why: '下半身转得太快，手臂跟不上，杆面容易打开、推右。', fix: '转换时先把重心压向前脚，再转髋；保持上下半身的衔接。', drill: '「暂停下杆」：上杆到顶停 1 秒，再以中速下杆，体会髋和手臂一起到达击球位置。' },
  },
  {
    id: 'fo_p6_sequence', view: 'fo', pos: 'P6', name: '下杆顺序：髋先肩后', unit: '°', digits: 0,
    points: ['leadHip', 'trailHip', 'leadShoulder', 'trailShoulder'],
    value: (c) => c.rot('shoulder', 'P6') - c.rot('hip', 'P6'),
    range: { iron: [15, 70], driver: [15, 70] },
    about: '杆身与地面平行时，髋部比肩部多打开的角度（估算）。职业球员下杆是「髋 → 胸 → 手臂 → 杆」依次加速，此时髋部明显比肩部更开。',
    low: { issue: '肩膀和手臂抢先（下杆顺序反了）', why: '上半身先发力，髋部没有领先，力量传递断掉，常见结果是由外向内切球、左拉、右曲或杆头速度上不去。', fix: '转换时想「先下半身、后上半身」：前膝先向目标侧移动、前髋向后转，肩膀保持关闭久一点。', drill: '「泵杆练习」：上杆到顶，只让髋部启动、把双手下放到腰高（P6），再回到顶点，重复 2 次后第 3 次完整挥出。每组 5 球，做 3 组。' },
    high: null,
  },
  {
    id: 'fo_p7_hipturn', view: 'fo', pos: 'P7', name: '击球时髋部打开（估算）', unit: '°', digits: 0,
    points: ['leadHip', 'trailHip'],
    value: (c) => -c.rot('hip', 'P7'),
    range: { iron: [25, 60], driver: [25, 62] },
    about: '击球瞬间髋部朝目标打开的角度（估算），职业球员约 35–45°。',
    low: { issue: '击球时髋部打开不足', why: '下半身没带动，靠手臂发力，容易翻腕、拉左，杆头速度也受限。', fix: '下杆由下半身启动，击球时腰带扣朝向球的左前方。', drill: '在腰带环里横插一根对齐杆，慢速挥到击球位置停住：杆应该指向目标左侧约 40°，而不是平行于目标线。' },
    high: { issue: '击球时髋部打开过多', why: '上下身不同步，手臂跟不上，杆面打开推右。', fix: '保持下杆节奏，让手臂和身体一起到达击球位置。', drill: '慢速 9 点–3 点半挥杆，体会身体与手臂同步。' },
  },
  {
    id: 'fo_p7_shift', view: 'fo', pos: 'P7', name: '击球时骨盆前移', unit: '× 站宽', digits: 2,
    points: ['leadHip', 'trailHip'],
    value: (c) => c.toTarget(c.B('P7').hipMid, c.b1.hipMid),
    range: { iron: [0.06, 0.4], driver: [0.04, 0.36] },
    about: '击球瞬间骨盆相对准备姿势移向目标的程度。职业球员击球时约 70–80% 重心在前脚。',
    low: { issue: '击球时重心留在后脚', why: '杆头最低点在球后，打厚打薄、缺乏压缩，是业余球员最常见的问题之一。', fix: '下杆把前髋送到前脚上方，击球时后脚跟开始离地。', drill: '「后脚脚尖点地」练习：准备时后脚只用脚尖点地，强制重心在前脚完成击球。' },
    high: { issue: '击球时下半身冲过头', why: '上身被甩在后面，杆面难以回正，推右或右曲。', fix: '击球时前腿形成支撑，骨盆转动而不是继续向前滑。', drill: '前脚外侧立对齐杆，击球后前髋不越过。' },
  },
  {
    id: 'fo_p7_head', view: 'fo', pos: 'P7', name: '击球时头部位置', unit: '× 站宽', digits: 2,
    points: ['head'],
    value: (c) => c.toTarget(c.B('P7').head, c.b1.head),
    range: { iron: [-0.45, 0.06], driver: [-0.5, 0.02] },
    about: '击球瞬间头部应在准备位置或略靠后，形成「头在球后」的击球姿态。',
    low: { issue: '击球时上身后仰过多', why: '最低点后移、杆面动态杆面角增加，容易挑球、打厚。', fix: '下杆胸口跟随转向目标，不要刻意把身体往后倒。', drill: '慢速击球练习，在击球位置停住检查头部是否只略在球后方。' },
    high: { issue: '击球时头部越过球', why: '上身抢先、出杆过陡，铁杆打深草皮、一号木打低拉左。', fix: '下杆时下半身先动，头留在球后，感觉「在球后方击球」。', drill: '在球的目标侧地上放一个物体，击球时眼睛盯住球的后侧。' },
  },
  {
    id: 'fo_p7_hands', view: 'fo', pos: 'P7', name: '击球时手领先（杆身前倾）', unit: '× 站宽', digits: 2,
    points: ['leadWrist', 'trailWrist'],
    value: (c) => c.toTarget(c.B('P7').hands, c.b1.hands),
    range: { iron: [0.02, 0.35], driver: [-0.06, 0.25] },
    about: '击球时双手相对准备位置向目标侧领先的程度。铁杆击球时双手应在球前方，形成杆身前倾。',
    low: { issue: '击球时手落后（翻腕/挑球）', why: '过早释放手腕，杆身后倾，失去压缩、距离和方向都不稳。', fix: '下杆保持手腕角度更久，让身体转动带手通过击球区，击球时双手在前大腿前方。', drill: '「推杆袋」练习：杆头顶住一个装满毛巾的袋子，保持手在杆头前方推动它。' },
    high: { issue: '手领先过多', why: '杆面容易打开、出右，或杆身前倾过大打低。', fix: '让杆头自然释放，击球时双手在前大腿内侧即可。', drill: '半挥杆练习，感受杆头与双手同时到达击球位置。' },
  },
  {
    id: 'fo_p7_tilt', view: 'fo', pos: 'P7', name: '击球时脊柱侧倾', unit: '°', digits: 0,
    points: ['leadShoulder', 'trailShoulder', 'leadHip', 'trailHip'],
    value: (c) => c.spineTilt(c.B('P7')),
    range: { iron: [15, 38], driver: [20, 42] },
    about: '击球时上半身向后侧倾斜。骨盆前移、头在球后，自然形成这个侧倾。',
    low: { issue: '击球时上身过直 / 倒向目标', why: '通常伴随上身抢先，出杆过陡，打深草皮或拉左。', fix: '下杆时让骨盆前移、头留后，后肩向下向前转。', drill: '下杆慢动作，击球位置停住，检查后肩是否低于前肩。' },
    high: { issue: '击球时后仰过多', why: '最低点后移，容易打厚、挑球，一号木打出高飘球。', fix: '减少刻意后仰，让胸口在击球时朝向球。', drill: '在后肩后方放对齐杆参照，击球时不要往后倒。' },
  },
  {
    id: 'fo_p7_leadknee', view: 'fo', pos: 'P7', name: '击球时前腿支撑', unit: '°', digits: 0,
    points: ['leadHip', 'leadKnee', 'leadAnkle'],
    value: (c) => { const b = c.B('P7'); return angleAt(b.leadHip, b.leadKnee, b.leadAnkle); },
    range: { iron: [148, 181], driver: [152, 181] },
    about: '击球时前膝角度。前腿伸展形成支撑（「蹬地」），是职业球员杆头速度的重要来源。',
    low: { issue: '击球时前腿没有形成支撑', why: '前膝持续弯曲或向目标滑动，无法利用地面反作用力，速度损失。', fix: '下杆后段前腿向上蹬直，感觉前髋向后上方转。', drill: '「蹬地」练习：下杆时用力踩地，击球后前腿伸直，保持收杆。' },
    high: null,
  },
  {
    id: 'fo_p8_extension', view: 'fo', pos: 'P8', name: '送杆双臂伸展', unit: '°', digits: 0,
    points: ['trailShoulder', 'trailElbow', 'trailWrist'],
    value: (c) => { const b = c.B('P8'); return angleAt(b.trailShoulder, b.trailElbow, b.trailWrist); },
    range: { iron: [140, 181], driver: [140, 181] },
    about: '击球后后臂（右手球员的右臂）应完全伸展，双臂指向目标。',
    low: { issue: '送杆手臂收缩（「鸡翅」）', why: '击球时减速或身体停止转动，杆面不稳定、距离损失。', fix: '击球后继续转身，让双臂向目标方向伸展。', drill: '击球后停在 P8：双臂伸直、杆身与地面平行、杆头趾部朝上。' },
    high: null,
  },
  {
    id: 'fo_p10_balance', view: 'fo', pos: 'P10', name: '收杆重心位置', unit: '', digits: 2,
    points: ['leadHip', 'trailHip', 'leadAnkle', 'trailAnkle'],
    value: (c) => {
      const b = c.B('P10');
      const span = (c.b1.leadAnkle.x - c.b1.trailAnkle.x) || 1e-6;
      return (b.hipMid.x - c.b1.trailAnkle.x) / span;
    },
    format: (v) => `${Math.round(v * 100)}%`,
    range: { iron: [0.78, 1.15], driver: [0.75, 1.15] },
    about: '收杆时骨盆在两脚间的位置（0% = 后脚，100% = 前脚）。职业收杆几乎全部重心在前脚。',
    low: { issue: '收杆重心留在后脚', why: '重心没完成转移，说明下杆用上身/手臂发力，击球质量不稳定。', fix: '收杆时腰带扣朝向目标，后脚只剩脚尖点地。', drill: '收杆后保持 3 秒平衡，再把后脚抬起离地，能站稳说明重心到位。' },
    high: { issue: '收杆重心冲过前脚', why: '身体向目标冲出去，平衡不好。', fix: '以前腿为轴转动收杆，不要整个人向前扑。', drill: '收杆后保持平衡 3 秒，身体不晃。' },
  },
  {
    id: 'fo_p10_tilt', view: 'fo', pos: 'P10', name: '收杆身体姿态', unit: '°', digits: 0,
    points: ['leadShoulder', 'trailShoulder', 'leadHip', 'trailHip'],
    value: (c) => c.spineTilt(c.B('P10')),
    range: { iron: [-8, 22], driver: [-8, 25] },
    about: '收杆时身体应接近直立，略向后侧倾斜可以接受；过度后弯（反 C 型）伤腰。',
    low: { issue: '收杆身体前倾', why: '上身冲向目标，往往是下杆上身抢先的结果。', fix: '收杆时胸口朝向目标、身体直立。', drill: '收杆时让后肩成为离目标最近的部位，保持站直。' },
    high: { issue: '收杆后仰（反 C 型）', why: '腰椎压力大，也说明击球时重心偏后。', fix: '让骨盆在收杆时转到前脚上方，上身站直。', drill: '收杆后检查：前髋、前肩、前脚大致在一条竖线上。' },
  },

  // ---------------- 侧面（down-the-line） ----------------
  {
    id: 'dtl_p1_bend', view: 'dtl', pos: 'P1', name: '准备时脊柱前倾', unit: '°', digits: 0,
    points: ['leadShoulder', 'trailShoulder', 'leadHip', 'trailHip'],
    value: (c) => c.spineBend(c.b1),
    range: { iron: [32, 50], driver: [28, 46] },
    about: '从侧面看髋部到肩部连线相对竖直的前倾角，职业铁杆约 40°。由髋关节折叠产生，而不是弯腰驼背。',
    low: { issue: '站得太直', why: '挥杆平面过平，容易打薄、打出左曲，也难以保持转体轴心。', fix: '从髋关节向前折叠，臀部向后坐，让手臂自然下垂。', drill: '把球杆贴在背后（后脑、上背、尾骨三点接触），从髋部前倾直到杆不离开三点。' },
    high: { issue: '前倾过多', why: '平面过陡、重心过于靠前脚尖，下杆容易起身（提前伸展）。', fix: '稍微抬高胸口，重心放在脚掌中部。', drill: '准备时轻轻上下踮脚，找到重心在脚掌中部的感觉。' },
  },
  {
    id: 'dtl_p1_knee', view: 'dtl', pos: 'P1', name: '准备时膝盖弯曲', unit: '°', digits: 0,
    points: ['trailHip', 'trailKnee', 'trailAnkle'],
    value: (c) => angleAt(c.b1.trailHip, c.b1.trailKnee, c.b1.trailAnkle),
    range: { iron: [140, 170], driver: [140, 172] },
    about: '后膝夹角（180° = 伸直）。职业球员膝盖轻微弯曲，约 15–30°，保持运动员姿态。',
    low: { issue: '膝盖弯曲过多（蹲得太低）', why: '下半身锁死难以转动，容易在挥杆中起身。', fix: '膝盖只需「解锁」，髋部前倾负责降低身体。', drill: '对镜侧身：膝盖前沿大致在脚尖上方即可。' },
    high: { issue: '膝盖太直', why: '下半身僵硬，转体和重心转移困难，平衡差。', fix: '膝盖轻微弯曲，感觉大腿肌肉有轻微张力。', drill: '准备时做一个「准备接球」的运动员姿态，再握杆。' },
  },
  {
    id: 'dtl_p1_arms', view: 'dtl', pos: 'P1', name: '准备时手臂下垂', unit: '× 躯干', digits: 2,
    points: ['leadWrist', 'trailWrist', 'leadShoulder', 'trailShoulder'],
    value: (c) => c.toBall(c.b1.hands, c.b1.shoulderMid),
    range: { iron: [-0.08, 0.3], driver: [-0.05, 0.35] },
    about: '双手相对肩部的前后位置。手臂应从肩部自然下垂，双手大约在肩部正下方或略前。',
    low: { issue: '双手离身体太近', why: '挥杆空间不足，下杆手臂被身体卡住，容易打到杆根。', fix: '站得离球稍远一点，让手臂自然下垂。', drill: '准备后松开后手，前臂自然垂下的位置就是手的位置。' },
    high: { issue: '双手伸得太远', why: '手臂紧绷、重心前移到脚尖，挥杆平面过平，击球不稳。', fix: '向球靠近半步，让手臂从肩部自然下垂。', drill: '手与大腿之间留约一个半拳的距离。' },
  },
  {
    id: 'dtl_p4_bend', view: 'dtl', pos: 'P4', name: '上杆顶点脊柱角保持', unit: '°', digits: 1,
    points: ['leadShoulder', 'trailShoulder', 'leadHip', 'trailHip'],
    value: (c) => c.spineBend(c.B('P4')) - c.spineBend(c.b1),
    range: { iron: [-7, 6], driver: [-7, 6] },
    about: '上杆到顶时脊柱前倾角相对准备姿势的变化，负值表示身体抬起。职业球员基本保持不变。',
    low: { issue: '上杆时身体抬起', why: '失去准备时的脊柱角，下杆还要重新找回，打薄、打厚交替出现。', fix: '上杆时保持臀部向后的感觉，胸口朝下转。', drill: '臀部轻贴墙站好，上杆时后侧臀部始终贴着墙。' },
    high: { issue: '上杆时身体下压', why: '头部和上身下沉，下杆容易起身补偿。', fix: '保持准备时的高度，围绕脊柱转动。', drill: '同伴用杆轻放在你头顶上方，上杆时头不要下沉。' },
  },
  {
    id: 'dtl_p4_head', view: 'dtl', pos: 'P4', name: '上杆顶点头部高度', unit: '× 躯干', digits: 2,
    points: ['head'],
    value: (c) => c.drop(c.B('P4').head, c.b1.head),
    range: { iron: [-0.08, 0.1], driver: [-0.08, 0.1] },
    about: '上杆到顶时头部上下移动（正值 = 下沉）。职业球员头部高度基本稳定。',
    low: { issue: '上杆时头部抬高', why: '身体起立，挥杆轴心改变，击球高度不稳定。', fix: '保持膝盖弯曲和髋部前倾，转动时不站起来。', drill: '对镜侧身上杆，头顶高度保持在同一刻度。' },
    high: { issue: '上杆时头部下沉', why: '下杆需要起身补偿，容易打薄或提前伸展。', fix: '保持胸口高度，围绕脊柱转动而不是压低身体。', drill: '头顶上方放一根杆作为参照，慢速上杆。' },
  },
  {
    id: 'dtl_p4_hips', view: 'dtl', pos: 'P4', name: '上杆顶点臀部位置', unit: '× 躯干', digits: 2,
    points: ['leadHip', 'trailHip'],
    value: (c) => c.toBall(c.B('P4').hipMid, c.b1.hipMid),
    range: { iron: [-0.15, 0.06], driver: [-0.15, 0.06] },
    about: '上杆时骨盆朝球方向的移动（正值 = 朝球移动）。应保持或略向后。',
    low: { issue: '上杆臀部后移过多', why: '重心退到脚跟，下杆容易向前冲回球。', fix: '上杆转动时保持重心在脚掌中部。', drill: '准备时把重心放在脚掌中部，上杆停顿检查不压脚跟。' },
    high: { issue: '上杆时臀部向球靠近', why: '失去髋部空间，下杆手臂没有通道，容易起身、打出右推或杆根球。', fix: '上杆时后髋向后转（朝自己身后），而不是向球推。', drill: '臀部贴墙练习：上杆时后侧臀部始终贴墙。' },
  },
  {
    id: 'dtl_p4_hipturn', view: 'dtl', pos: 'P4', name: '上杆顶点髋部转动（估算）', unit: '°', digits: 0,
    points: ['leadHip', 'trailHip'],
    value: (c) => c.rot('hip', 'P4'),
    range: { iron: [28, 65], driver: [30, 68] },
    about: '侧面画面中两髋被拉开的程度估算的髋部转动，职业球员上杆顶点约 45°。',
    low: { issue: '上杆髋部转动不足', why: '下半身锁住，肩部也转不到位，上杆只能靠手臂抬杆，容易站起来或上杆过快。', fix: '上杆时允许后髋向后转（朝自己身后），前膝向内指向球的后方。', drill: '双手抱杆在胸前做上杆转体，转到后侧口袋朝向身后的目标线，3 组 × 10 次。' },
    high: { issue: '上杆髋部转动过多', why: '上下半身扭转差变小，蓄力丢失，常伴随后膝伸直、身体抬起。', fix: '保持后膝弯曲，用髋部的阻力让肩部转动「拧」起来。', drill: '后膝夹毛巾做上杆，到顶停 2 秒检查后膝没有伸直。' },
  },
  {
    id: 'dtl_p4_shoulder', view: 'dtl', pos: 'P4', name: '上杆顶点肩部转动（估算）', unit: '°', digits: 0,
    points: ['leadShoulder', 'trailShoulder'],
    value: (c) => c.rot('shoulder', 'P4'),
    range: { iron: [62, 115], driver: [65, 120] },
    about: '侧面画面中两肩被拉开的程度估算的肩部转动，职业球员约 90°（侧面估算通常偏小）。',
    low: { issue: '上杆肩部转动不足', why: '蓄力不够，下杆容易用手臂发力、由外向内。', fix: '上杆到顶时前肩转到下巴下方，背部对着目标。', drill: '双臂交叉抱胸做转体，直到背部正对目标；再带杆做同样的感觉。' },
    high: null,
  },
  {
    id: 'dtl_p6_hips', view: 'dtl', pos: 'P6', name: '下杆臀部位置（提前伸展）', unit: '× 躯干', digits: 2,
    points: ['leadHip', 'trailHip'],
    value: (c) => c.toBall(c.B('P6').hipMid, c.b1.hipMid),
    range: { iron: [-0.18, 0.06], driver: [-0.18, 0.06] },
    about: '下杆到杆身平行时骨盆朝球的移动。臀部向球顶出就是「提前伸展」（early extension），业余球员中极为常见。',
    low: { issue: '下杆臀部后退过多', why: '通常伴随上身前冲。', fix: '下杆时让前髋向后上方转，保持胸口朝下。', drill: '慢速下杆检查臀部线。' },
    high: { issue: '提前伸展：下杆臀部向球顶出', why: '手臂下杆通道被堵，身体起立，导致杆根球、推右、左曲交替出现。', fix: '下杆时让前侧臀部向后（朝着身后）转，保持臀部在准备时的「臀线」后方。', drill: '臀部贴墙练习：准备时臀部轻触墙，下杆到击球时前侧臀部仍然碰墙。' },
  },
  {
    id: 'dtl_p6_hipopen', view: 'dtl', pos: 'P6', name: '下杆髋部打开（估算）', unit: '°', digits: 0,
    points: ['leadHip', 'trailHip'],
    value: (c) => -c.rot('hip', 'P6'),
    range: { iron: [5, 40], driver: [3, 40] },
    about: '杆身下到与地面平行时髋部朝目标打开的角度（估算）。从侧面看，职业球员此时前侧髋部已经开始向后让开。',
    low: { issue: '下杆转髋不够（髋部滞后）', why: '下杆没有由下半身启动，手臂和肩膀先把杆拉下来，容易左拉、翻手或打出不稳定的球路。', fix: '到顶点后先让前侧臀部向后、向目标方向转（感觉前侧裤兜往身后走），手臂「等一下」，被身体转动带下来。', drill: '贴墙转髋：准备时臀部轻碰身后的墙，下杆时让前侧臀部沿墙往后滑、后侧臀部离开墙。空手 2 组 × 10 次，再拿杆半挥 20 次。' },
    high: { issue: '下杆髋部打开过早过多', why: '下半身转得太快，手臂跟不上，杆面容易打开、推右。', fix: '转换时先把重心压向前脚，再转髋。', drill: '上杆到顶停 1 秒再以中速下杆，体会髋和手臂一起到达击球位置。' },
  },
  {
    id: 'dtl_p6_sequence', view: 'dtl', pos: 'P6', name: '下杆顺序：髋先肩后', unit: '°', digits: 0,
    points: ['leadHip', 'trailHip', 'leadShoulder', 'trailShoulder'],
    value: (c) => c.rot('shoulder', 'P6') - c.rot('hip', 'P6'),
    range: { iron: [15, 70], driver: [15, 70] },
    about: '杆身与地面平行时，髋部比肩部多打开的角度（估算）。职业球员此时髋部明显领先肩部。',
    low: { issue: '肩膀和手臂抢先（下杆顺序反了）', why: '上半身先发力，髋部没有领先，力量传递断掉，常见由外向内切球、左拉、右曲或杆头速度上不去。', fix: '转换时想「先下半身、后上半身」：前膝先向目标侧移动、前髋向后转，肩膀保持关闭久一点。', drill: '「泵杆练习」：上杆到顶，只让髋部启动、把双手下放到腰高（P6），再回到顶点，重复 2 次后第 3 次完整挥出。每组 5 球，做 3 组。' },
    high: null,
  },
  {
    id: 'dtl_p7_bend', view: 'dtl', pos: 'P7', name: '击球时脊柱角保持', unit: '°', digits: 1,
    points: ['leadShoulder', 'trailShoulder', 'leadHip', 'trailHip'],
    value: (c) => c.spineBend(c.B('P7')) - c.spineBend(c.b1),
    range: { iron: [-10, 4], driver: [-11, 4] },
    about: '击球时脊柱前倾相对准备时的变化。职业球员击球时略微抬起几度，但仍保持前倾。',
    low: { issue: '击球时身体起立（失去前倾）', why: '杆头离开地面，打薄、打顶，或者为了补偿而翻手造成左曲。', fix: '下杆时保持胸口朝下，让转动而不是起身来带动击球。', drill: '在头部上方放参照物，慢速击球时头不要上升。' },
    high: { issue: '击球时身体下压', why: '杆头入射过深，容易打厚。', fix: '下杆保持准备时的高度。', drill: '慢速半挥杆，体会准备与击球时身体高度一致。' },
  },
  {
    id: 'dtl_p7_hips', view: 'dtl', pos: 'P7', name: '击球时臀部位置（提前伸展）', unit: '× 躯干', digits: 2,
    points: ['leadHip', 'trailHip'],
    value: (c) => c.toBall(c.B('P7').hipMid, c.b1.hipMid),
    range: { iron: [-0.2, 0.06], driver: [-0.2, 0.06] },
    about: '击球时骨盆朝球的移动，正值越大提前伸展越严重。',
    low: { issue: '击球时臀部后退过多', why: '重心后移，可能上身前冲。', fix: '保持重心在脚掌中部。', drill: '慢速击球检查臀部线。' },
    high: { issue: '提前伸展：击球时臀部顶向球', why: '身体起立、手臂无路可走，杆面难以控制。', fix: '下杆时前髋向后上方转，击球时臀部仍在准备时的臀线上或后方。', drill: '在臀部后方放一把椅子，击球时臀部保持轻触椅背。' },
  },
  {
    id: 'dtl_p7_hipopen', view: 'dtl', pos: 'P7', name: '击球时髋部打开（估算）', unit: '°', digits: 0,
    points: ['leadHip', 'trailHip'],
    value: (c) => -c.rot('hip', 'P7'),
    range: { iron: [25, 60], driver: [25, 62] },
    about: '击球瞬间髋部朝目标打开的角度（估算），职业球员约 35–45°。从侧面看，前侧髋部已经让开，能看到更多的后侧臀部。',
    low: { issue: '击球时髋部打开不足', why: '下半身没带动，靠手臂发力，容易翻腕、拉左，杆头速度也受限。', fix: '下杆由下半身启动，击球时腰带扣朝向球的左前方。', drill: '在腰带环里横插一根对齐杆，慢速挥到击球位置停住：杆应该指向目标左侧约 40°。' },
    high: { issue: '击球时髋部打开过多', why: '上下身不同步，杆面打开推右。', fix: '保持下杆节奏，让手臂和身体一起到达击球位置。', drill: '慢速 9 点–3 点半挥杆，体会身体与手臂同步。' },
  },
  {
    id: 'dtl_p7_head', view: 'dtl', pos: 'P7', name: '击球时头部高度', unit: '× 躯干', digits: 2,
    points: ['head'],
    value: (c) => c.drop(c.B('P7').head, c.b1.head),
    range: { iron: [-0.08, 0.12], driver: [-0.1, 0.12] },
    about: '击球时头部相对准备时的上下变化（正值 = 下沉）。职业球员击球时头部常略微下沉。',
    low: { issue: '击球时头部抬起', why: '身体起立，打薄、打顶。', fix: '击球时眼睛盯住球的后侧，保持胸口朝下。', drill: '击球后继续看着球的位置 1 秒再抬头。' },
    high: { issue: '击球时头部下沉过多', why: '入射过深，容易打厚。', fix: '保持准备时的身体高度。', drill: '慢速击球练习，体会稳定的头部高度。' },
  },
  {
    id: 'dtl_p10_posture', view: 'dtl', pos: 'P10', name: '收杆身体直立', unit: '°', digits: 0,
    points: ['leadShoulder', 'trailShoulder', 'leadHip', 'trailHip'],
    value: (c) => c.spineBend(c.B('P10')),
    range: { iron: [-10, 24], driver: [-10, 24] },
    about: '收杆时脊柱相对竖直的前倾，职业收杆身体基本直立。',
    low: { issue: '收杆身体后仰', why: '腰部压力大。', fix: '收杆时站直、胸口朝向目标。', drill: '收杆保持 3 秒平衡。' },
    high: { issue: '收杆仍保持前倾（没转完）', why: '身体转动没有完成，常与送杆减速有关。', fix: '击球后继续转身，直到胸口朝向目标、身体站直。', drill: '收杆时让后肩成为离目标最近的部位。' },
  },

  // ---------------- 两种视角通用 ----------------
  {
    id: 'tempo', view: 'any', pos: 'P4', name: '挥杆节奏（上杆 : 下杆）', unit: ': 1', digits: 1,
    points: [],
    value: (c) => (c.t('P4') - c.t('P1')) / Math.max(1e-6, c.t('P7') - c.t('P4')),
    range: { iron: [2.4, 3.8], driver: [2.4, 3.8] },
    about: '上杆时间与下杆时间之比。职业球员非常稳定地接近 3 : 1（Tour Tempo 研究）。需要 60fps 以上视频才较准确。',
    low: { issue: '上杆太快 / 节奏急促', why: '上杆过急会打乱转换时机，常伴随从上往下砍球。', fix: '上杆放慢，在顶点完成转体后再开始下杆。', drill: '跟着节拍器或口令「一——二——三，打」挥杆，上杆三拍、下杆一拍。' },
    high: { issue: '上杆过慢 / 下杆不够果断', why: '下杆加速不足或顶点停顿过长，丢失弹性与速度。', fix: '保持上杆流畅，转换时果断加速。', drill: '用节拍器 3:1 节奏练习空挥，逐步加快整体速度。' },
  },
];

const rangeFor = (m, club) => m.range[club] || m.range.iron;

export function formatValue(m, v) {
  if (!Number.isFinite(v)) return '—';
  if (m.format) return m.format(v);
  return `${v.toFixed(m.digits)}${m.unit ? ` ${m.unit}` : ''}`;
}

// 评估一项：good / warn / bad / na
function grade(v, [lo, hi]) {
  if (!Number.isFinite(v)) return { status: 'na', severity: 0 };
  const tol = (hi - lo) * 0.5;
  if (v >= lo && v <= hi) return { status: 'good', severity: 0 };
  const off = v < lo ? lo - v : v - hi;
  return { status: off <= tol ? 'warn' : 'bad', severity: off / (hi - lo), side: v < lo ? 'low' : 'high' };
}

export function evaluate(ctx) {
  const results = [];
  for (const m of METRICS) {
    if (m.view !== 'any' && m.view !== ctx.view) continue;
    const range = rangeFor(m, ctx.club);
    let value = NaN;
    let visibility = 1;
    try {
      const b = ctx.B(m.pos);
      visibility = m.points.length ? meanVisibility(m.points.map((k) => b[k])) : 1;
      value = m.value(ctx);
    } catch { value = NaN; }
    let g = grade(value, range);
    if (visibility < 0.5 && g.status !== 'na') g = { status: 'na', severity: 0, lowVis: true };
    const advice = g.side ? m[g.side] : null;
    results.push({ metric: m, id: m.id, pos: m.pos, value, range, visibility, ...g, advice });
  }
  return results;
}

const POINTS = { good: 100, warn: 60, bad: 20 };

export function summarize(results) {
  const scored = results.filter((r) => r.status !== 'na');
  const score = scored.length ? Math.round(scored.reduce((s, r) => s + POINTS[r.status], 0) / scored.length) : null;
  const priorities = results
    .filter((r) => (r.status === 'bad' || r.status === 'warn') && r.advice)
    .sort((a, b) => (b.status === 'bad') - (a.status === 'bad') || b.severity - a.severity)
    .slice(0, 3);
  const byPos = {};
  for (const r of results) (byPos[r.pos] ||= []).push(r);
  return { score, priorities, byPos, counts: countBy(results) };
}

function countBy(results) {
  const c = { good: 0, warn: 0, bad: 0, na: 0 };
  for (const r of results) c[r.status]++;
  return c;
}
