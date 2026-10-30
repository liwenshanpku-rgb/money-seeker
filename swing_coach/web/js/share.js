// 「发给 Claude App」：把关键帧拼成一张图 + 生成可粘贴的点评请求文字。
// 不需要任何 token，用的是 Claude App 里正常对话的额度。

const STATUS = { good: '达标', warn: '接近', bad: '需改进', na: '无法判断' };

export function buildShareText(prompt, { settings, score, timing, metrics, note }) {
  const lines = [
    prompt.trim(),
    '',
    '# 基本信息',
    `惯用手：${settings.handed === 'left' ? '左手' : '右手'}；球杆：${settings.club === 'driver' ? '一号木' : '铁杆'}；` +
      `拍摄角度：${settings.view === 'fo' ? '正面（face-on）' : '侧面（down-the-line）'}；程序综合评分：${score ?? '—'}`,
  ];
  if (timing) {
    lines.push(`各位置时间（秒）：${Object.entries(timing).map(([p, t]) => `${p} ${t}`).join('，')}`);
  }
  if (settings.demo) lines.push('注意：这是程序合成的示例挥杆（只有骨架，没有真实画面）。');
  lines.push('', '# 程序测量结果（2D 视频估算）');
  for (const m of metrics) {
    let s = `- ${m.pos} ${m.name}：${m.value}（职业区间 ${m.pro_range}）→ ${STATUS[m.status] || m.status}`;
    if (m.issue) s += `，${m.issue}`;
    if (m.pro_value) s += `；职业视频 ${m.pro_value}`;
    lines.push(s);
  }
  const n = (note || '').trim();
  if (n) lines.push('', `# 我的补充`, n.slice(0, 500));
  lines.push('', '请看附图（P1–P10 关键帧拼图）并给出教练点评。');
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
