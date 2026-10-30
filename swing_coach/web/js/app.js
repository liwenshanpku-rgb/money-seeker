// 页面逻辑：上传 → 姿态识别 → P1–P10 检测 → 指标评估 → 渲染对比结果 →（可选）AI 教练点评

import { extractPoses, fillMissing } from './pose.js';
import { smoothFrames, detectPhases } from './phases.js';
import { makeContext, evaluate, summarize, formatValue } from './metrics.js';
import { POSITIONS, POSITION_INFO, PRO_PARAMS, PRO_TIMING, syntheticSwing } from './template.js';
import {
  alignTemplate, templateHandPath, cropBox, drawFrame, drawHandPath, drawTimeline, videoSource, blankSource,
} from './render.js';

const $ = (id) => document.getElementById(id);
const STATUS_TEXT = { good: '达标', warn: '接近', bad: '需改进', na: '无法判断' };
const VIEW_TEXT = { fo: '正面（Face-on）', dtl: '侧面（Down-the-line）' };
const CLUB_TEXT = { iron: '铁杆', driver: '一号木' };

const state = { user: null, pro: null, videoURL: null, proURL: null };

function settings() {
  return {
    handed: $('handed').value,
    club: $('club').value,
    view: $('view').value === 'auto' ? undefined : $('view').value,
    fps: Number($('fps').value),
    model: $('model').value,
    start: Number($('start').value) || 0,
    end: Number($('end').value) || undefined,
  };
}

// ---------- 上传 ----------
const drop = $('drop');
drop.addEventListener('click', () => $('file').click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer.files?.[0];
  if (f) loadVideo(f);
});
$('file').addEventListener('change', (e) => e.target.files[0] && loadVideo(e.target.files[0]));

function loadVideo(file) {
  if (state.videoURL) URL.revokeObjectURL(state.videoURL);
  state.videoURL = URL.createObjectURL(file);
  const v = $('video');
  v.src = state.videoURL;
  v.onloadedmetadata = () => {
    drop.classList.add('has-video');
    $('start').value = 0;
    $('end').value = Math.min(v.duration, 15).toFixed(1);
    $('analyze').disabled = false;
    if (v.duration > 15) showError('视频超过 15 秒，默认只分析前 15 秒；可以调整「分析区间」只包含一次挥杆。');
    else hideError();
  };
}

$('proFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (state.proURL) URL.revokeObjectURL(state.proURL);
  state.proURL = URL.createObjectURL(file);
  const v = $('proVideo');
  v.src = state.proURL;
  await new Promise((r) => { v.onloadedmetadata = r; });
  $('proStatus').textContent = `已选择：${file.name}，分析时会一并处理`;
  if (state.user && !state.user.demo) {
    try {
      state.pro = await analyzeVideo(v, { ...settings(), start: 0, end: Math.min(v.duration, 15) }, '职业视频');
      await renderAll();
    } catch (err) { showError(`职业视频分析失败：${err.message}`); }
  }
});

// ---------- 分析流程 ----------
function analyzeFrames(rawFrames, s, extra = {}) {
  const smoothed = smoothFrames(rawFrames);
  const det = detectPhases(rawFrames, { handed: s.handed, view: s.view, club: s.club, smoothed });
  const a = {
    ...extra, settings: s, raw: rawFrames, frames: smoothed, speed: det.speed,
    view: det.view, dir: det.dir, autoP: { ...det.P }, P: { ...det.P },
  };
  score(a);
  return a;
}

function score(a) {
  const ctx = makeContext(a.frames, a.P, { view: a.view, dir: a.dir, handed: a.settings.handed, club: a.settings.club });
  a.results = evaluate(ctx);
  a.summary = summarize(a.results);
  a.ref = { lm: a.frames[a.P.P1].lm, dir: a.dir };
}

async function analyzeVideo(video, s, label = '') {
  setProgress(0, `${label}加载姿态识别模型…`);
  const { frames, aspect } = await extractPoses(video, {
    fps: s.fps, start: s.start, end: s.end, model: s.model,
    onProgress: (f) => setProgress(f, `${label}识别姿态 ${Math.round(f * 100)}%`),
  });
  const { frames: filled, missingRatio } = fillMissing(frames);
  if (missingRatio > 0.4) throw new Error('超过 40% 的帧没有识别到人体，请确保全身在画面中、光线充足');
  const a = analyzeFrames(filled, s, { aspect, source: videoSource(video) });
  a.missingRatio = missingRatio;
  return a;
}

$('analyze').addEventListener('click', async () => {
  hideError();
  $('analyze').disabled = true;
  try {
    const s = settings();
    state.user = await analyzeVideo($('video'), s);
    state.pro = null;
    if ($('proVideo').src) {
      const pv = $('proVideo');
      state.pro = await analyzeVideo(pv, { ...s, view: state.user.view, start: 0, end: Math.min(pv.duration, 15) }, '职业视频：');
    }
    setProgress(1, '完成');
    await renderAll();
  } catch (err) {
    console.error(err);
    showError(err.message || String(err));
  } finally {
    $('analyze').disabled = false;
    setTimeout(() => { $('progress').hidden = true; }, 800);
  }
});

// 示例：一个带典型业余问题的合成挥杆（反向脊柱角、重心没转移、翻腕、节奏偏快）
$('demo').addEventListener('click', async () => {
  hideError();
  const s = { ...settings(), view: 'fo' };
  const table = structuredClone(PRO_PARAMS);
  Object.assign(table.P4, { tilt: -6, shiftX: 0.02, shoulder: 78 });
  Object.assign(table.P5, { shiftX: 0.0, tilt: 4 });
  Object.assign(table.P6, { shiftX: 0.0, tilt: 8 });
  Object.assign(table.P7, { shiftX: 0.005, tilt: 12, arm: 10, hip: -18 });
  Object.assign(table.P8, { shiftX: 0.01 });
  Object.assign(table.P10, { shiftX: 0.02, tilt: 26 });
  const timing = { ...PRO_TIMING, P2: 0.2, P3: 0.4, P4: 0.62, P5: 0.76, P6: 0.83, P7: 0.9, P8: 0.98, P9: 1.1, P10: 1.5 };
  const { frames } = syntheticSwing({ fps: 60, view: 'fo', club: s.club, handed: s.handed, table, timing, noise: 0.002 });
  state.user = analyzeFrames(frames, s, { aspect: 16 / 9, source: blankSource(), demo: true });
  state.pro = null;
  await renderAll();
});

// ---------- 渲染 ----------
async function renderAll() {
  const u = state.user;
  $('results').hidden = false;
  u.crop = cropBox(POSITIONS.map((p) => u.frames[u.P[p]].lm).concat(
    POSITIONS.map((p) => alignTemplate(p, u.ref, opts(u)).landmarks)), u.aspect);
  if (state.pro) state.pro.crop = cropBox(POSITIONS.map((p) => state.pro.frames[state.pro.P[p]].lm), state.pro.aspect);
  renderSummary();
  renderPriorities();
  renderTable();
  setupScrub();
  await renderPositions();
  await drawHandPath($('pathCanvas'), u.source, u.frames, u.P, u.crop, {
    handed: u.settings.handed, templatePath: templateHandPath(u.ref, opts(u)),
  });
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const opts = (a) => ({ view: a.view, club: a.settings.club, handed: a.settings.handed });

function renderSummary() {
  const u = state.user;
  const { score: sc, counts } = u.summary;
  $('score').textContent = sc ?? '–';
  $('ring').style.strokeDashoffset = String(327 * (1 - (sc ?? 0) / 100));
  const tempo = u.results.find((r) => r.id === 'tempo');
  const t = (p) => u.frames[u.P[p]].t;
  $('facts').innerHTML = [
    ['拍摄角度', VIEW_TEXT[u.view]],
    ['球杆 / 惯用手', `${CLUB_TEXT[u.settings.club]} · ${u.settings.handed === 'left' ? '左手' : '右手'}`],
    ['节奏 上杆:下杆', tempo && Number.isFinite(tempo.value) ? `${tempo.value.toFixed(1)} : 1` : '—'],
    ['上杆 / 下杆用时', `${(t('P4') - t('P1')).toFixed(2)}s / ${(t('P7') - t('P4')).toFixed(2)}s`],
    ...(u.demo ? [['数据来源', '示例合成挥杆']] : []),
    ...(state.pro ? [['对比模板', '职业模板 + 你上传的职业视频']] : [['对比模板', '内置职业模板']]),
  ].map(([k, v]) => `<div>${k}<b>${v}</b></div>`).join('');
  $('counts').innerHTML = ['good', 'warn', 'bad', 'na']
    .map((s) => `<div><span class="chip ${s}">${STATUS_TEXT[s]}</span> ${counts[s]} 项</div>`).join('');
}

function renderPriorities() {
  const pr = state.user.summary.priorities;
  if (!pr.length) {
    $('priorities').innerHTML = '<li><b>各项检查都在职业区间内，继续保持！</b><div class="detail">可以拍另一个角度（正面 / 侧面）再检查一次。</div></li>';
    return;
  }
  $('priorities').innerHTML = pr.map((r) => `
    <li>
      <b>${r.pos} ${POSITION_INFO[r.pos].name} · ${r.advice.issue}</b> <span class="chip ${r.status}">${STATUS_TEXT[r.status]}</span>
      <div class="detail">${r.metric.name}：${formatValue(r.metric, r.value)}（职业区间 ${fmtRange(r)}）。${r.advice.why}</div>
      <div class="drill"><b>怎么改：</b>${r.advice.fix}</div>
      <div class="drill"><b>练习：</b>${r.advice.drill}</div>
    </li>`).join('');
}

function fmtRange(r) {
  const m = r.metric;
  const [lo, hi] = r.range;
  if (m.format) return `${m.format(lo)} – ${m.format(hi)}`;
  if (hi > 180) return `≥ ${lo}${m.unit}`;
  return `${lo} – ${hi} ${m.unit}`;
}

function proValue(id) {
  const r = state.pro?.results.find((x) => x.id === id);
  return r ? formatValue(r.metric, r.value) : null;
}

function renderTable() {
  const rows = state.user.results;
  const hasPro = !!state.pro;
  $('metricsTable').innerHTML = `
    <thead><tr><th>位置</th><th>检查项</th><th>你的数值</th>${hasPro ? '<th>职业视频</th>' : ''}<th>职业区间</th><th>结果</th><th>说明与建议</th></tr></thead>
    <tbody>${rows.map((r) => `
      <tr>
        <td>${r.pos}</td>
        <td>${r.metric.name}</td>
        <td class="num">${formatValue(r.metric, r.value)}</td>
        ${hasPro ? `<td class="num">${proValue(r.id) ?? '—'}</td>` : ''}
        <td class="num">${fmtRange(r)}</td>
        <td><span class="chip ${r.status}">${STATUS_TEXT[r.status]}</span></td>
        <td class="advice">${r.advice
          ? `<b>${r.advice.issue}</b>：${r.advice.why}<br><b>改进：</b>${r.advice.fix}<br><b>练习：</b>${r.advice.drill}`
          : r.lowVis ? '关键点在这一帧不够清晰，无法可靠测量。' : r.metric.about}</td>
      </tr>`).join('')}</tbody>`;
}

async function renderPositions() {
  const u = state.user;
  const show = $('showTemplate').checked;
  const box = $('positions');
  box.innerHTML = '';
  for (const pos of POSITIONS) {
    const card = document.createElement('div');
    card.className = 'pos-card';
    const items = u.summary.byPos[pos] || [];
    card.innerHTML = `
      <div class="imgs ${state.pro ? 'with-pro' : ''}"><canvas width="360" height="420"></canvas>${state.pro ? '<canvas width="360" height="420"></canvas>' : ''}</div>
      <div class="body">
        <h3>${pos} ${POSITION_INFO[pos].name}<span>${u.frames[u.P[pos]].t.toFixed(2)}s</span></h3>
        <div class="muted" style="font-size:12.5px">${POSITION_INFO[pos].desc}</div>
        <ul>${items.map((r) => `<li><span>${r.metric.name}</span><span>${formatValue(r.metric, r.value)} <span class="chip ${r.status}">${STATUS_TEXT[r.status]}</span></span></li>`).join('')}</ul>
      </div>`;
    box.appendChild(card);
    const [c1, c2] = card.querySelectorAll('canvas');
    await drawFrame(c1, u.source, u.frames[u.P[pos]], u.crop, {
      template: alignTemplate(pos, u.ref, opts(u)), showTemplate: show, label: state.pro ? `你 · ${pos}` : pos,
    });
    if (c2) {
      const p = state.pro;
      await drawFrame(c2, p.source, p.frames[p.P[pos]], p.crop, { label: `职业 · ${pos}` });
    }
    card.dataset.pos = pos;
  }
}

$('showTemplate').addEventListener('change', () => state.user && renderPositions());

// ---------- 手动校正 ----------
function setupScrub() {
  const u = state.user;
  const sl = $('scrub');
  sl.max = u.frames.length - 1;
  sl.value = u.P.P4;
  $('assignPos').innerHTML = POSITIONS.map((p) => `<option value="${p}">${p} ${POSITION_INFO[p].name}</option>`).join('');
  $('assignPos').value = 'P4';
  drawScrub();
}

let scrubBusy = false, scrubPending = false;
async function drawScrub() {
  if (scrubBusy) { scrubPending = true; return; }
  scrubBusy = true;
  const u = state.user;
  const i = Number($('scrub').value);
  const at = POSITIONS.filter((p) => u.P[p] === i);
  await drawFrame($('scrubCanvas'), u.source, u.frames[i], u.crop, { label: `第 ${i} 帧 · ${u.frames[i].t.toFixed(2)}s${at.length ? ` · ${at.join(' / ')}` : ''}` });
  drawTimeline($('timeline'), u.speed, u.frames, u.P, i);
  scrubBusy = false;
  if (scrubPending) { scrubPending = false; drawScrub(); }
}
$('scrub').addEventListener('input', drawScrub);
$('assignPos').addEventListener('change', () => { $('scrub').value = state.user.P[$('assignPos').value]; drawScrub(); });

$('assign').addEventListener('click', async () => {
  const u = state.user;
  u.P[$('assignPos').value] = Number($('scrub').value);
  await rescore();
});
$('resetPhases').addEventListener('click', async () => {
  state.user.P = { ...state.user.autoP };
  await rescore();
});

async function rescore() {
  score(state.user);
  const keep = $('scrub').value;
  await renderAll();
  $('scrub').value = keep;
  drawScrub();
}

// ---------- AI 教练 ----------
$('coach').addEventListener('click', async () => {
  const u = state.user;
  if (!u) return;
  const out = $('coachOut');
  $('coach').disabled = true;
  out.innerHTML = '<p class="muted">Claude 正在看你的 10 张关键帧并撰写点评，通常需要 30–90 秒…</p>';
  try {
    const images = [...document.querySelectorAll('.pos-card')].map((card) => ({
      pos: card.dataset.pos,
      data: card.querySelector('canvas').toDataURL('image/jpeg', 0.82),
    }));
    const payload = {
      settings: { handed: u.settings.handed, club: u.settings.club, view: u.view, demo: !!u.demo },
      note: $('coachNote').value.trim(),
      score: u.summary.score,
      timing: Object.fromEntries(POSITIONS.map((p) => [p, Number(u.frames[u.P[p]].t.toFixed(3))])),
      metrics: u.results.map((r) => ({
        pos: r.pos, name: r.metric.name, value: formatValue(r.metric, r.value), pro_range: fmtRange(r),
        status: r.status, issue: r.advice?.issue ?? null, pro_value: proValue(r.id),
      })),
      images,
    };
    const res = await fetch('api/coach', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      throw new Error('当前页面不是通过 server.py 启动的，无法调用 AI 教练。请运行 python swing_coach/server.py 后打开 http://localhost:8000');
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `服务器错误 ${res.status}`);
    out.innerHTML = markdown(data.text);
  } catch (err) {
    out.innerHTML = `<p class="error">${escapeHTML(err.message)}</p>`;
  } finally {
    $('coach').disabled = false;
  }
});

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 极简 Markdown 渲染（标题、粗体、列表、段落）
function markdown(src) {
  const lines = escapeHTML(src).split('\n');
  let html = '', list = null;
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const line of lines) {
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { close(); const h = Math.min(4, m[1].length + 2); html += `<h${h}>${inline(m[2])}</h${h}>`; }
    else if ((m = line.match(/^\s*[-*]\s+(.*)/))) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; }
    else if (line.trim() === '') close();
    else { close(); html += `<p>${inline(line)}</p>`; }
  }
  close();
  return html;
}

// ---------- 工具 ----------
function setProgress(f, text) {
  $('progress').hidden = false;
  $('bar').style.width = `${Math.round(f * 100)}%`;
  $('progressText').textContent = text;
}
function showError(msg) { $('error').hidden = false; $('error').textContent = msg; }
function hideError() { $('error').hidden = true; }
