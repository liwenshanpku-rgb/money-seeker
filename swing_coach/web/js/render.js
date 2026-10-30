// 画面渲染：关键帧裁剪、骨架、职业模板叠加、手部轨迹、速度时间轴。

import { BONES, body, dist } from './geometry.js';
import { templatePose, POSITIONS, PRO_TIMING, paramsAt } from './template.js';
import { orientation } from './phases.js';

export const COLORS = {
  user: '#ff8a3d',
  userJoint: '#ffd2b3',
  pro: '#2fd38a',
  back: '#5aa9ff',
  down: '#ff5d73',
};

// 把模板关键点按用户的身材和站位对齐：以双脚踝中点为锚点、按「踝→肩」高度缩放、方向一致
function aligner(ref, { view, club, handed }) {
  const t1 = templatePose('P1', { view, club, handed });
  const tb = body(t1.landmarks, handed);
  const ub = body(ref.lm, handed);
  const k = dist(ub.ankleMid, ub.shoulderMid) / dist(tb.ankleMid, tb.shoulderMid);
  const m = ref.dir / orientation(t1.landmarks, handed, view);
  return (q) => ({ x: ub.ankleMid.x + (q.x - tb.ankleMid.x) * k * m, y: ub.ankleMid.y + (q.y - tb.ankleMid.y) * k, v: 1 });
}

export function alignTemplate(position, ref, opts) {
  const map = aligner(ref, opts);
  const tp = templatePose(position, opts);
  return { landmarks: tp.landmarks.map(map), hands: map(tp.hands), clubHead: map(tp.clubHead) };
}

// 职业模板从 P1 到 P10 的手部轨迹（已对齐到用户）
export function templateHandPath(ref, opts, steps = 120) {
  const map = aligner(ref, opts);
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * PRO_TIMING.P10;
    out.push(map(templatePose(null, { ...opts, params: paramsAt(t) }).hands));
  }
  return out;
}

// 所有关键帧共用的裁剪框（单位：视频高度）
export function cropBox(frameList, aspect, pad = 0.18) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const lm of frameList) {
    for (const p of lm) {
      if ((p.v ?? 1) < 0.3) continue;
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
  }
  const h = (y1 - y0) * (1 + pad * 2);
  const w = Math.max(x1 - x0, h * 0.75) * (1 + pad);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const side = Math.max(w, h);
  return {
    x: Math.max(0, cx - side / 2), y: Math.max(0, cy - side / 2),
    w: Math.min(aspect, side), h: Math.min(1, side),
  };
}

export function drawSkeleton(ctx, lm, toPx, { color, joint, width = 3, dash = null, alpha = 1, minVis = 0.3 }) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  if (dash) ctx.setLineDash(dash);
  for (const [a, b] of BONES) {
    const p = lm[a], q = lm[b];
    if (!p || !q || (p.v ?? 1) < minVis || (q.v ?? 1) < minVis) continue;
    const P = toPx(p), Q = toPx(q);
    ctx.beginPath(); ctx.moveTo(P.x, P.y); ctx.lineTo(Q.x, Q.y); ctx.stroke();
  }
  // 头部
  const s0 = lm[11], s1 = lm[12], n = lm[0];
  if (n && (n.v ?? 1) >= minVis) {
    const r = Math.max(4, dist(toPx(s0), toPx(s1)) * 0.28, width * 3);
    const N = toPx(n);
    ctx.beginPath(); ctx.arc(N.x, N.y, r, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.setLineDash([]);
  if (joint) {
    ctx.fillStyle = joint;
    for (const i of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
      const p = lm[i];
      if (!p || (p.v ?? 1) < minVis) continue;
      const P = toPx(p);
      ctx.beginPath(); ctx.arc(P.x, P.y, width * 1.1, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}

export function drawClub(ctx, hands, clubHead, toPx, color, width = 2) {
  const H = toPx(hands), C = toPx(clubHead);
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash([6, 5]);
  ctx.beginPath(); ctx.moveTo(H.x, H.y); ctx.lineTo(C.x, C.y); ctx.stroke();
  ctx.restore();
}

// 在 canvas 上画一帧：背景（视频画面或纯色）+ 用户骨架 + 可选模板
export async function drawFrame(canvas, source, frame, crop, { template, showTemplate = true, label, labelSize = 15 } = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const k = Math.min(W / crop.w, H / crop.h);
  const ox = (W - crop.w * k) / 2, oy = (H - crop.h * k) / 2;
  const toPx = (p) => ({ x: ox + (p.x - crop.x) * k, y: oy + (p.y - crop.y) * k });
  ctx.fillStyle = '#0d1512';
  ctx.fillRect(0, 0, W, H);
  await source.draw(ctx, frame.t, crop, { ox, oy, k });
  if (template && showTemplate) {
    drawSkeleton(ctx, template.landmarks, toPx, { color: COLORS.pro, width: 3, dash: [7, 5], alpha: 0.9 });
    drawClub(ctx, template.hands, template.clubHead, toPx, COLORS.pro);
  }
  drawSkeleton(ctx, frame.lm, toPx, { color: COLORS.user, joint: COLORS.userJoint, width: 3 });
  if (label) {
    ctx.font = `600 ${labelSize}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(8, 8, ctx.measureText(label).width + labelSize, labelSize * 1.6);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, 8 + labelSize / 2, 8 + labelSize * 1.15);
  }
  return toPx;
}

// 手部轨迹：上杆蓝、下杆红，叠加职业模板轨迹（绿色虚线）
export async function drawHandPath(canvas, source, frames, P, crop, { handed, templatePath, label = '手部轨迹' } = {}) {
  const toPx = await drawFrame(canvas, source, frames[P.P1], crop, { label });
  const ctx = canvas.getContext('2d');
  const path = (from, to, color) => {
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.beginPath();
    for (let i = from; i <= to; i++) {
      const h = toPx(body(frames[i].lm, handed).hands);
      if (i === from) ctx.moveTo(h.x, h.y); else ctx.lineTo(h.x, h.y);
    }
    ctx.stroke(); ctx.restore();
  };
  if (templatePath) {
    ctx.save();
    ctx.strokeStyle = COLORS.pro; ctx.lineWidth = 2; ctx.setLineDash([6, 5]); ctx.beginPath();
    templatePath.forEach((p, i) => { const q = toPx(p); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
    ctx.stroke(); ctx.restore();
  }
  path(P.P1, P.P4, COLORS.back);
  path(P.P4, P.P10, COLORS.down);
  ctx.fillStyle = '#fff';
  ctx.font = '600 12px system-ui, sans-serif';
  for (const pos of POSITIONS) {
    const h = toPx(body(frames[P[pos]].lm, handed).hands);
    ctx.beginPath(); ctx.arc(h.x, h.y, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillText(pos, h.x + 6, h.y - 6);
  }
}

// 手速时间轴，标出 P1–P10 和当前帧
export function drawTimeline(canvas, speed, frames, P, current) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const css = getComputedStyle(document.documentElement);
  ctx.clearRect(0, 0, W, H);
  const n = speed.length;
  const vmax = Math.max(...speed) || 1;
  const X = (i) => (i / Math.max(1, n - 1)) * (W - 20) + 10;
  const Y = (v) => H - 18 - (v / vmax) * (H - 34);
  ctx.strokeStyle = css.getPropertyValue('--muted') || '#888';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  speed.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.stroke();
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (const pos of POSITIONS) {
    const i = P[pos];
    ctx.strokeStyle = COLORS.pro; ctx.globalAlpha = 0.6;
    ctx.beginPath(); ctx.moveTo(X(i), 12); ctx.lineTo(X(i), H - 16); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = css.getPropertyValue('--text') || '#ddd';
    ctx.fillText(pos.replace('P', ''), X(i), 10);
  }
  if (current !== undefined) {
    ctx.strokeStyle = COLORS.user; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(X(current), 0); ctx.lineTo(X(current), H); ctx.stroke();
  }
  ctx.fillStyle = css.getPropertyValue('--muted') || '#888';
  ctx.textAlign = 'left';
  ctx.fillText(`${frames[0].t.toFixed(2)}s`, 4, H - 3);
  ctx.textAlign = 'right';
  ctx.fillText(`${frames[n - 1].t.toFixed(2)}s  手速`, W - 4, H - 3);
  ctx.textAlign = 'left';
}

// 背景来源：真实视频
export function videoSource(video) {
  return {
    async draw(ctx, t, crop, { ox, oy, k }) {
      const { seek } = await import('./pose.js');
      if (Math.abs(video.currentTime - t) > 1e-3) await seek(video, t);
      const vh = video.videoHeight;
      ctx.drawImage(video, crop.x * vh, crop.y * vh, crop.w * vh, crop.h * vh, ox, oy, crop.w * k, crop.h * k);
    },
  };
}

// 背景来源：演示模式（无视频），画地面线
export function blankSource(groundY = 0.92) {
  return {
    async draw(ctx, t, crop, { ox, oy, k }) {
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = 1;
      const y = oy + (groundY - crop.y) * k;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(ctx.canvas.width, y); ctx.stroke();
    },
  };
}
