// 「发给 Claude App」：把关键帧拼成一张图 + 生成可粘贴的点评请求文字。
// 不需要任何 token，用的是 Claude App 里正常对话的额度。

const STATUS = { good: '达标', warn: '接近', bad: '需改进', na: '无法判断' };

const VIEW_NAME = { fo: '正面（face-on）', dtl: '侧面（down-the-line）', both: '正面 + 侧面（两段视频，可能是不同的挥杆）' };

export function buildShareText(prompt, { settings, score, timing, metrics, note }) {
  const lines = [
    prompt.trim(),
    '',
    '# 基本信息',
    `惯用手：${settings.handed === 'left' ? '左手' : '右手'}；球杆：${settings.club === 'driver' ? '一号木' : '铁杆'}；` +
      `拍摄角度：${VIEW_NAME[settings.view] || settings.view}；程序综合评分：${score ?? '—'}`,
  ];
  if (timing) {
    const fmt = (t) => Object.entries(t).map(([p, v]) => `${p} ${v}`).join('，');
    const nested = Object.values(timing).some((v) => typeof v === 'object');
    if (nested) for (const [view, t] of Object.entries(timing)) lines.push(`各位置时间（秒，${view}）：${fmt(t)}`);
    else lines.push(`各位置时间（秒）：${fmt(timing)}`);
  }
  if (settings.demo) lines.push('注意：这是程序合成的示例挥杆（只有骨架，没有真实画面）。');
  lines.push('', '# 程序测量结果（2D 视频估算）');
  const multiView = settings.view === 'both';
  for (const m of metrics) {
    let s = `- ${multiView && m.view ? `[${m.view}] ` : ''}${m.pos} ${m.name}：${m.value}（职业区间 ${m.pro_range}）→ ${STATUS[m.status] || m.status}`;
    if (m.issue) s += `，${m.issue}`;
    if (m.pro_value) s += `；职业视频 ${m.pro_value}`;
    lines.push(s);
  }
  const n = (note || '').trim();
  if (n) lines.push('', `# 我的补充`, n.slice(0, 500));
  lines.push('', `请看附图（${multiView ? '正面和侧面的 ' : ''}P1–P10 关键帧拼图）并给出教练点评。`);
  return lines.join('\n');
}

// 把若干张同尺寸的 canvas 拼成网格大图
export function montage(canvases, { cols = 5, gap = 6, background = '#0d1512' } = {}) {
  const w = canvases[0].width, h = canvases[0].height;
  const rows = Math.ceil(canvases.length / cols);
  const out = document.createElement('canvas');
  out.width = cols * w + (cols + 1) * gap;
  out.height = rows * h + (rows + 1) * gap;
  const ctx = out.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, out.width, out.height);
  canvases.forEach((c, i) => {
    const x = gap + (i % cols) * (w + gap);
    const y = gap + Math.floor(i / cols) * (h + gap);
    ctx.drawImage(c, x, y);
  });
  return out;
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.85) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('生成图片失败'))), type, quality));
}

// 剪贴板：优先用异步 API，失败时退回 execCommand（部分 iOS 版本需要）
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

// ---------- 发给朋友的结果卡片 ----------
const CARD = {
  bg: '#f4f6f3', panel: '#ffffff', text: '#17201b', muted: '#5d6b63', line: '#dfe5e0',
  accent: '#127a4a', good: '#1f9d5c', warn: '#d48a00', bad: '#d64545', dark: '#0d1512',
  font: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
};

// 按字符折行（中文没有空格，逐字测量）
export function wrapText(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const ch of text) {
    if (ch === '\n') { lines.push(line); line = ''; continue; }
    if (ctx.measureText(line + ch).width > maxWidth && line) { lines.push(line); line = ch; } else line += ch;
  }
  if (line) lines.push(line);
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// data: { score, facts: [[标签, 值]], counts, priorities: [{title, status, detail, fix}], frames: [canvas], footer }
export function resultCard(data, { width = 1080 } = {}) {
  const pad = 48, inner = width - pad * 2;
  const font = (size, weight = 400) => `${weight} ${size}px ${CARD.font}`;
  const measure = document.createElement('canvas').getContext('2d');

  // 预先排版，算出总高度
  const grid = montage(data.frames, { cols: 5, gap: 6, background: CARD.dark });
  const gridH = Math.round(grid.height * (inner / grid.width));
  const items = data.priorities.map((p) => {
    measure.font = font(30, 700);
    const title = wrapText(measure, p.title, inner - 120);
    measure.font = font(26);
    const body = wrapText(measure, p.detail, inner - 60);
    const fix = p.fix ? wrapText(measure, `怎么改：${p.fix}`, inner - 60) : [];
    return { ...p, title, body, fix, h: 28 + title.length * 40 + 10 + (body.length + fix.length) * 36 + 24 };
  });
  const headerH = 250;
  const prioH = items.length ? 70 + items.reduce((s, it) => s + it.h + 16, 0) : 130;
  const height = pad + headerH + 30 + gridH + 30 + prioH + 70;

  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = CARD.bg;
  ctx.fillRect(0, 0, width, height);
  let y = pad;

  // 标题 + 评分环
  ctx.fillStyle = CARD.text;
  ctx.font = font(48, 800);
  ctx.textBaseline = 'top';
  ctx.fillText('我的挥杆分析', pad, y);
  ctx.fillStyle = CARD.muted;
  ctx.font = font(26);
  ctx.fillText('P1–P10 逐位置对比职业模板', pad, y + 64);
  const cx = width - pad - 90, cy = y + 90, r = 78;
  ctx.lineWidth = 16;
  ctx.strokeStyle = CARD.line;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = CARD.accent;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ((data.score ?? 0) / 100)); ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.fillStyle = CARD.text;
  ctx.textAlign = 'center';
  ctx.font = font(56, 800);
  ctx.fillText(String(data.score ?? '–'), cx, cy - 36);
  ctx.fillStyle = CARD.muted;
  ctx.font = font(22);
  ctx.fillText('综合评分', cx, cy + 26);
  ctx.textAlign = 'left';

  // 基本信息
  let fx = pad, fy = y + 130;
  for (const [k, v] of data.facts) {
    ctx.font = font(22);
    ctx.fillStyle = CARD.muted;
    ctx.fillText(k, fx, fy);
    ctx.font = font(28, 600);
    ctx.fillStyle = CARD.text;
    ctx.fillText(v, fx, fy + 30);
    fx += 230;
  }
  if (data.counts) {
    ctx.font = font(24);
    let x = pad;
    const yy = y + headerH - 30;
    for (const [label, n, color] of [['达标', data.counts.good, CARD.good], ['接近', data.counts.warn, CARD.warn], ['需改进', data.counts.bad, CARD.bad]]) {
      const text = `${label} ${n}`;
      const w = ctx.measureText(text).width + 28;
      ctx.fillStyle = color;
      roundRect(ctx, x, yy - 4, w, 38, 19); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(text, x + 14, yy + 2);
      x += w + 12;
    }
  }
  y += headerH + 30;

  // 关键帧拼图
  ctx.save();
  roundRect(ctx, pad, y, inner, gridH, 16); ctx.clip();
  ctx.drawImage(grid, pad, y, inner, gridH);
  ctx.restore();
  y += gridH + 30;

  // 最需要改进的 3 点
  ctx.fillStyle = CARD.text;
  ctx.font = font(34, 800);
  ctx.fillText(items.length ? '最需要改进的地方' : '各项检查都在职业区间内 👍', pad, y);
  y += 60;
  items.forEach((it, i) => {
    ctx.fillStyle = CARD.panel;
    roundRect(ctx, pad, y, inner, it.h, 18); ctx.fill();
    ctx.fillStyle = it.status === 'bad' ? CARD.bad : CARD.warn;
    ctx.beginPath(); ctx.arc(pad + 40, y + 46, 22, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = font(26, 800);
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), pad + 40, y + 32);
    ctx.textAlign = 'left';
    let ty = y + 28;
    ctx.fillStyle = CARD.text;
    ctx.font = font(30, 700);
    for (const l of it.title) { ctx.fillText(l, pad + 84, ty); ty += 40; }
    ty += 10;
    ctx.font = font(26);
    ctx.fillStyle = CARD.muted;
    for (const l of it.body) { ctx.fillText(l, pad + 30, ty); ty += 36; }
    ctx.fillStyle = CARD.text;
    for (const l of it.fix) { ctx.fillText(l, pad + 30, ty); ty += 36; }
    y += it.h + 16;
  });

  // 页脚
  ctx.fillStyle = CARD.muted;
  ctx.font = font(22);
  ctx.fillText(data.footer || '', pad, height - 50);
  return c;
}
