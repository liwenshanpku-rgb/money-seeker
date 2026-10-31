// 页面逻辑：上传 → 姿态识别 → P1–P10 检测 → 指标评估 → 渲染对比结果 →（可选）AI 教练点评

import { extractPoses, fillMissing, primeVideo, videoDuration } from './pose.js';
import { smoothFrames, detectPhases, detectView } from './phases.js';
import { makeContext, evaluate, summarize, formatValue, compareToPro } from './metrics.js';
import { POSITIONS, POSITION_INFO, PRO_PARAMS, PRO_TIMING, syntheticSwing } from './template.js';
import {
  alignTemplate, templateHandPath, cropBox, drawFrame, drawHandPath, drawTimeline, frameSource, blankSource, imageSource, COLORS,
} from './render.js';
import { GitHubCoach, guessRepo, store } from './github.js';
import { buildShareText, montage, canvasToBlob, copyText, resultCard } from './share.js';
import { PROS, embedURL, loadProFrames, pickProData, CLUB_NAME, versioned } from './pros.js';

const $ = (id) => document.getElementById(id);
const STATUS_TEXT = { good: '达标', warn: '接近', bad: '需改进', na: '无法判断', ref: '参考' };
const CLUB_TEXT = { iron: '铁杆', driver: '一号木' };

const VIEWS = ['fo', 'dtl'];
const VIEW_SHORT = { fo: '正面', dtl: '侧面' };

// views：每个拍摄角度一份分析结果；active：校正面板当前选中的角度
const state = { views: { fo: null, dtl: null }, active: null };
const slots = Object.fromEntries(VIEWS.map((v) => [v, { url: null, video: $(`video-${v}`) }]));

// 手机上逐帧识别较慢，默认 30fps
const isPhone = window.matchMedia?.('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
if (isPhone) $('fps').value = '30';

function settings() {
  return {
    handed: $('handed').value,
    club: $('club').value,
    fps: Number($('fps').value),
    model: $('model').value,
  };
}

const analyses = () => VIEWS.map((v) => state.views[v]).filter(Boolean);
const hasVideo = (v) => !!slots[v].url;

// ---------- 上传（正面、侧面两个位置，各自可选） ----------
for (const v of VIEWS) {
  const drop = $(`drop-${v}`);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer.files?.[0];
    if (f) loadVideo(v, f);
  });
  $(`file-${v}`).addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = ''; // 允许再次选择同一个文件
    if (f) loadVideo(v, f);
  });
}
document.querySelectorAll('[data-clear]').forEach((btn) => btn.addEventListener('click', () => clearSlot(btn.dataset.clear)));

function loadVideo(v, file) {
  const slot = slots[v];
  if (slot.url) URL.revokeObjectURL(slot.url);
  slot.url = URL.createObjectURL(file);
  const video = slot.video;
  video.src = slot.url;
  video.load();
  video.onloadedmetadata = () => {
    $(`drop-${v}`).classList.add('has-video');
    $(`foot-${v}`).hidden = false;
    $(`start-${v}`).value = 0;
    $(`end-${v}`).value = Math.min(videoDuration(video), 15).toFixed(1);
    if (videoDuration(video) > 15) showError(`${VIEW_SHORT[v]}视频超过 15 秒，默认只分析前 15 秒；可以调整区间只包含一次挥杆。`);
    else hideError();
    updateAnalyzeButton();
  };
}

function clearSlot(v) {
  const slot = slots[v];
  if (slot.url) URL.revokeObjectURL(slot.url);
  slot.url = null;
  slot.video.removeAttribute('src');
  slot.video.load();
  $(`drop-${v}`).classList.remove('has-video');
  $(`foot-${v}`).hidden = true;
  updateAnalyzeButton();
}

function updateAnalyzeButton() {
  const n = VIEWS.filter(hasVideo).length;
  $('analyze').disabled = n === 0;
  $('analyze').textContent = n === 2 ? '开始分析（正面 + 侧面）' : '开始分析';
}

// 结果页的「分析新视频」：清掉旧结果，回到上传区
function hideResults() {
  $('results').hidden = true;
  $('coach').disabled = true;
  $('prepareShare').disabled = true;
  $('coachOut').innerHTML = '';
  hideError();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$('newAnalysis').addEventListener('click', () => {
  VIEWS.forEach(clearSlot);
  state.views = { fo: null, dtl: null };
  state.saved = null;
  hideResults();
});

// ---------- 分析流程 ----------
function analyzeFrames(rawFrames, s, extra = {}) {
  const smoothed = smoothFrames(rawFrames);
  const det = detectPhases(rawFrames, { handed: s.handed, view: s.view, club: s.club, smoothed });
  const a = {
    ...extra, settings: s, raw: rawFrames, frames: smoothed, speed: det.speed,
    view: det.view, dir: det.dir, autoP: { ...det.P }, P: { ...det.P },
  };
  // 用户指定了角度但画面看起来不像：提醒一下（仍按用户指定的角度分析）
  if (s.view) {
    const guess = detectView(smoothed[det.P.P1].lm, s.handed);
    if (guess !== s.view) a.viewWarning = `${VIEW_SHORT[s.view]}位置的视频看起来更像${VIEW_SHORT[guess]}拍摄，请确认放对了位置。`;
  }
  score(a);
  return a;
}

function score(a) {
  const ctx = makeContext(a.frames, a.P, { view: a.view, dir: a.dir, handed: a.settings.handed, club: a.settings.club });
  a.results = evaluate(ctx).map((r) => ({ ...r, view: a.view }));
  a.oblique = a.view === 'fo' && ctx.oblique();
  a.summary = summarize(a.results);
  a.ref = { lm: a.frames[a.P.P1].lm, dir: a.dir };
}

// 所有角度合在一起的结果
function combined() {
  // 示例数据来自合成模板（没有识别误差），和真实识别出的职业数据不可比，参考类指标不做对比
  const results = analyses().flatMap((a) => (a.demo ? a.results : a.results.map((r) => compareToPro(r, proNum(r)))));
  return { results, summary: summarize(results) };
}

async function analyzeVideo(video, s, label = '') {
  setProgress(0, `${label}加载姿态识别模型…`);
  const { frames, aspect } = await extractPoses(video, {
    fps: s.fps, start: s.start, end: s.end, model: s.model,
    onProgress: (f) => setProgress(f, `${label}识别姿态 ${Math.round(f * 100)}%`),
  });
  const { frames: filled, missingRatio } = fillMissing(frames);
  if (missingRatio > 0.4) throw new Error(`${label}超过 40% 的帧没有识别到人体，请确保全身在画面中、光线充足`);
  const a = analyzeFrames(filled, s, { aspect, source: frameSource(filled) });
  a.missingRatio = missingRatio;
  return a;
}

$('analyze').addEventListener('click', async () => {
  // 必须在点击事件里同步调用（iPhone 要求播放由用户手势触发）
  const todo = VIEWS.filter(hasVideo);
  const primed = todo.map((v) => primeVideo(slots[v].video));
  hideError();
  $('analyze').disabled = true;
  try {
    await Promise.all(primed);
    const s = settings();
    const views = { fo: null, dtl: null };
    for (const v of todo) {
      const video = slots[v].video;
      const start = Number($(`start-${v}`).value) || 0;
      const end = Number($(`end-${v}`).value) || undefined;
      views[v] = await analyzeVideo(video, { ...s, view: v, start, end }, todo.length > 1 ? `${VIEW_SHORT[v]}：` : '');
    }
    state.views = views;
    state.saved = null;
    setProgress(1, '完成');
    await renderAll();
  } catch (err) {
    console.error(err);
    showError(err.message || String(err));
  } finally {
    updateAnalyzeButton();
    setTimeout(() => { $('progress').hidden = true; }, 800);
  }
});

// 示例：带典型业余问题的合成挥杆（反向脊柱角、重心没转移、下杆转髋不够、节奏偏快），正面 + 侧面各一段
$('demo').addEventListener('click', async () => {
  hideError();
  // 先把用户自己的分析结果存起来，退出示例时恢复
  if (analyses().length && !isDemo()) state.saved = state.views;
  const s = settings();
  const table = structuredClone(PRO_PARAMS);
  Object.assign(table.P4, { tilt: -6, shiftX: 0.02, shoulder: 78, bend: 33 });
  Object.assign(table.P5, { shiftX: 0.0, tilt: 4, hip: 30, shoulder: 52 });
  Object.assign(table.P6, { shiftX: 0.0, tilt: 8, hip: 10, shoulder: 14 });
  Object.assign(table.P7, { shiftX: 0.005, tilt: 12, arm: 10, hip: -12, shoulder: -10 });
  Object.assign(table.P8, { shiftX: 0.01 });
  Object.assign(table.P10, { shiftX: 0.02, tilt: 26 });
  const timing = { ...PRO_TIMING, P2: 0.2, P3: 0.4, P4: 0.62, P5: 0.76, P6: 0.83, P7: 0.9, P8: 0.98, P9: 1.1, P10: 1.5 };
  const views = {};
  for (const v of VIEWS) {
    const { frames } = syntheticSwing({ fps: 60, view: v, club: s.club, handed: s.handed, table, timing, noise: 0.002, seed: v === 'fo' ? 1 : 7 });
    views[v] = analyzeFrames(frames, { ...s, view: v }, { aspect: 16 / 9, source: blankSource(), demo: true });
  }
  state.views = views;
  await renderAll();
});

$('exitDemo').addEventListener('click', async () => {
  if (state.saved) {
    state.views = state.saved;
    state.saved = null;
    await renderAll();
  } else {
    state.views = { fo: null, dtl: null };
    hideResults();
  }
});

// ---------- 渲染 ----------
let renderRun = 0;
async function renderAll({ scroll = true } = {}) {
  const run = ++renderRun;
  const list = analyses();
  if (!list.length) return;
  await loadSelectedPro();
  if (run !== renderRun) return;
  $('results').hidden = false;
  $('demoBanner').hidden = !isDemo();
  $('coach').disabled = false;
  $('prepareShare').disabled = false;
  $('sharePanel').hidden = true;
  $('cardPanel').hidden = true;
  for (const a of list) {
    // 关键帧：紧贴人裁剪；手部轨迹：正方形，把上杆顶点和收杆时高举的双手也包进来
    a.crop = cropBox(POSITIONS.map((p) => a.frames[a.P[p]].lm), a.aspect);
    a.pathCrop = cropBox(POSITIONS.map((p) => a.frames[a.P[p]].lm), a.aspect, { ratio: 1, pad: 0.1 });
  }
  const warnings = list.map((a) => a.viewWarning).filter(Boolean);
  if (list.some((a) => a.oblique)) warnings.push('正面视频看起来是斜着拍的：髋部、肩部转动几项已标为「无法判断」，站位宽度和侧倾也可能有偏差。正面请把相机放在正前方、胸口高度、与目标线垂直。');
  if (warnings.length) showError(warnings.join(' '));
  renderSummary();
  renderPriorities();
  renderPros();
  renderTable();
  setupScrub();
  await renderPositions();
  const paths = $('paths');
  paths.innerHTML = '';
  for (const a of list) {
    if (run !== renderRun) return;
    const c = document.createElement('canvas');
    c.width = 560; c.height = 560;
    paths.appendChild(c);
    await drawHandPath(c, a.source, a.frames, a.P, a.pathCrop, {
      handed: a.settings.handed, templatePath: templateHandPath(a.ref, opts(a)),
      label: list.length > 1 ? `手部轨迹 · ${VIEW_SHORT[a.view]}` : undefined,
    });
  }
  if (scroll) $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const opts = (a) => ({ view: a.view, club: a.settings.club, handed: a.settings.handed });
const multi = () => analyses().length > 1;
const viewTag = (r) => (multi() ? `<span class="tag">${VIEW_SHORT[r.view]}</span>` : '');

function tempoText(a) {
  const r = a.results.find((x) => x.id === 'tempo');
  return r && Number.isFinite(r.value) ? `${r.value.toFixed(1)} : 1` : '—';
}

function renderSummary() {
  const list = analyses();
  const { summary } = combined();
  const { score: sc, counts } = summary;
  $('score').textContent = sc ?? '–';
  $('ring').style.strokeDashoffset = String(327 * (1 - (sc ?? 0) / 100));
  const first = list[0];
  $('facts').innerHTML = [
    ['拍摄角度', list.map((a) => VIEW_SHORT[a.view]).join(' + ') + (list.length === 1 ? '（可再传另一个角度）' : '')],
    ['球杆 / 惯用手', `${CLUB_TEXT[first.settings.club]} · ${first.settings.handed === 'left' ? '左手' : '右手'}`],
    ['节奏 上杆:下杆', list.map((a) => (multi() ? `${VIEW_SHORT[a.view]} ${tempoText(a)}` : tempoText(a))).join('，')],
    ...list.map((a) => {
      const t = (p) => a.frames[a.P[p]].t;
      return [`上杆 / 下杆用时${multi() ? `（${VIEW_SHORT[a.view]}）` : ''}`, `${(t('P4') - t('P1')).toFixed(2)}s / ${(t('P7') - t('P4')).toFixed(2)}s`];
    }),
    ...(first.demo ? [['数据来源', '示例合成挥杆']] : []),
    ['对比模板', state.pro ? `内置职业模板 + ${state.pro.name}` : '内置职业模板'],
  ].map(([k, v]) => `<div>${k}<b>${v}</b></div>`).join('');
  $('counts').innerHTML = ['good', 'warn', 'bad', 'na', 'ref'].filter((s) => s !== 'ref' || counts.ref)
    .map((s) => `<div><span class="chip ${s}">${STATUS_TEXT[s]}</span> ${counts[s]} 项</div>`).join('');
}

function renderPriorities() {
  const pr = combined().summary.priorities;
  if (!pr.length) {
    const tip = multi() ? '继续保持！' : '可以再拍另一个角度（正面 / 侧面）检查一次。';
    $('priorities').innerHTML = `<li><b>各项检查都在职业区间内，继续保持！</b><div class="detail">${tip}</div></li>`;
    return;
  }
  $('priorities').innerHTML = pr.map((r) => `
    <li>
      <b>${viewTag(r)}${r.pos} ${POSITION_INFO[r.pos].name} · ${r.advice.issue}</b> <span class="chip ${r.status}">${STATUS_TEXT[r.status]}</span>
      <div class="detail">${r.metric.name}：${formatValue(r.metric, r.value)}（${r.vsPro !== undefined ? `${state.pro.name} ${proValue(r)}，${vsProText(r)}` : `职业区间 ${fmtRange(r)}`}）。${r.advice.why}</div>
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


function renderTable() {
  const onlyIssues = $('onlyIssues').checked;
  const rows = combined().results.filter((r) => !onlyIssues || r.status === 'warn' || r.status === 'bad');
  const proName = state.pro?.name;
  const note = (r) => (r.advice
    ? `${r.vsPro !== undefined ? `<b>${vsProText(r)}。</b>` : ''}<b>${r.advice.issue}</b>：${r.advice.why}<br><b>改进：</b>${r.advice.fix}<br><b>练习：</b>${r.advice.drill}`
    : r.status === 'ref' ? `参考值：单机位视频估算这一项的误差较大，不计入评分。${isDemo() ? '示例数据不和职业球员对比。' : '在上面「对比职业球员」里选一位有骨架数据的球员，就能用同一方法和这位球员比较。'}<details><summary>说明</summary>${r.metric.about}</details>`
    : r.vsPro !== undefined ? `和 ${state.pro.name} 接近（${vsProText(r)}）。<details><summary>说明</summary>${r.metric.about}</details>`
    : r.oblique ? '正面相机没有正对胸口（斜着拍），无法估算转动角度。请把相机放在正前方、与目标线垂直后重拍。'
    : r.lowVis ? '关键点在这一帧不够清晰，无法可靠测量。'
    : `<details><summary>说明</summary>${r.metric.about}</details>`);
  // 手机上每一行显示为一张小卡片（见 style.css），各单元格用 class 定位
  $('metricsTable').innerHTML = `
    <thead><tr>${multi() ? '<th>视角</th>' : ''}<th>位置</th><th>检查项</th><th>你的数值</th>${proName ? `<th>${proName}</th>` : ''}<th>职业区间</th><th>结果</th><th>说明与建议</th></tr></thead>
    <tbody>${rows.length ? rows.map((r) => `
      <tr class="row-${r.status}">
        ${multi() ? `<td class="c-view">${VIEW_SHORT[r.view]}</td>` : ''}
        <td class="c-pos">${multi() ? `<span class="tag m-only">${VIEW_SHORT[r.view]}</span>` : ''}${r.pos}</td>
        <td class="c-name">${r.metric.name}</td>
        <td class="num c-val"><span class="lbl">你的数值 </span>${formatValue(r.metric, r.value)}</td>
        ${proName ? `<td class="num c-pro"><span class="lbl">${proName} </span>${proValue(r) ?? '—'}</td>` : ''}
        <td class="num c-range"><span class="lbl">职业区间 </span>${fmtRange(r)}</td>
        <td class="c-status"><span class="chip ${r.status}">${STATUS_TEXT[r.status]}</span></td>
        <td class="advice c-advice">${note(r)}</td>
      </tr>`).join('') : '<tr><td colspan="8" class="muted">没有需要改进的项 👍</td></tr>'}</tbody>`;
}
$('onlyIssues').addEventListener('change', () => analyses().length && renderTable());

let positionsRun = 0;
async function renderPositions() {
  // 切换球员等操作会在上一次渲染还没画完时重新渲染；旧的那次发现自己过期就停下，避免往新列表里插卡片
  const run = ++positionsRun;
  const list = analyses();
  const show = $('showTemplate').checked;
  const box = $('positions');
  const byPos = combined().summary.byPos;
  box.innerHTML = '';
  // 每张卡片：各角度的画面；选了有骨架数据的职业球员时，同角度的职业动作紧挨在右边
  const pro = state.pro;
  const panes = [];
  for (const a of list) {
    panes.push({ a });
    if (pro?.views[a.view]) panes.push({ a: pro.views[a.view], pro: true, mirror: pro.views[a.view].dir !== a.dir });
    else if (pro) panes.push({ a, empty: true }); // 占位，保持「你 | 他」一一对应
  }
  box.classList.toggle('multi', panes.length > 1);
  const credit = pro && [...new Set(Object.values(pro.views).map((a) => a.credit).filter(Boolean))]
    .map((c, i) => (i ? c.replace('画面来源：', '') : c)).join('、');
  $('proLegend').textContent = pro ? `　·　每组右边是 ${pro.name} 的同一位置（绿色骨架）${credit ? `，${credit}` : ''}` : '';
  for (const pos of POSITIONS) {
    const card = document.createElement('div');
    card.className = 'pos-card';
    const items = byPos[pos] || [];
    const times = list.map((a) => `${multi() ? VIEW_SHORT[a.view] + ' ' : ''}${a.frames[a.P[pos]].t.toFixed(2)}s`).join(' · ');
    card.innerHTML = `
      <div class="imgs n${panes.length}">${panes.map(() => '<canvas width="360" height="420"></canvas>').join('')}</div>
      <div class="body">
        <h3>${pos} ${POSITION_INFO[pos].name}<span>${times}</span></h3>
        <div class="muted" style="font-size:12.5px">${POSITION_INFO[pos].desc}</div>
        <ul>${items.map((r) => `<li><span>${viewTag(r)}${r.metric.name}</span><span>${formatValue(r.metric, r.value)} <span class="chip ${r.status}">${STATUS_TEXT[r.status]}</span></span></li>`).join('')}</ul>
      </div>`;
    if (run !== positionsRun) return;
    box.appendChild(card);
    const canvases = card.querySelectorAll('canvas');
    for (let i = 0; i < panes.length; i++) {
      const { a, pro: isPro, mirror, empty } = panes[i];
      if (empty) {
        const g = canvases[i].getContext('2d');
        g.fillStyle = '#0d1512'; g.fillRect(0, 0, canvases[i].width, canvases[i].height);
        g.fillStyle = '#93a39a'; g.font = '600 18px system-ui, sans-serif'; g.textAlign = 'center';
        g.fillText(`暂无 ${pro.name}`, canvases[i].width / 2, canvases[i].height / 2 - 12);
        g.fillText(`${VIEW_SHORT[a.view]}数据`, canvases[i].width / 2, canvases[i].height / 2 + 16);
      } else if (isPro) {
        await drawFrame(canvases[i], mirror ? a.sourceMirror : a.source, mirrorFrame(a.frames[a.P[pos]], a.crop, mirror), a.crop, {
          label: `${pro.name} · ${multi() ? VIEW_SHORT[a.view] + ' ' : ''}${pos}`,
          color: COLORS.pro, joint: '#c9f5df',
        });
      } else {
        await drawFrame(canvases[i], a.source, a.frames[a.P[pos]], a.crop, {
          template: alignTemplate(pos, a.ref, opts(a)), showTemplate: show,
          label: `${pro ? '你 · ' : ''}${multi() ? VIEW_SHORT[a.view] + ' ' : ''}${pos}`,
        });
      }
    }
    card.dataset.pos = pos;
  }
}

$('showTemplate').addEventListener('change', () => analyses().length && renderPositions());

// ---------- 对比职业球员：骨架数据逐位置左右对比 + 原视频 ----------
const KEY_PRO = 'swingCoach.pro';
$('proSelect').innerHTML = '<option value="">不对比</option>' + PROS.map((p) => `<option value="${p.id}">${p.name}（${p.tour}）${p.data ? ' · ' + Object.keys(p.data).map((c) => CLUB_NAME[c]).join(' / ') : ' · 仅视频'}</option>`).join('');
{
  const saved = store.get(KEY_PRO);
  $('proSelect').value = saved === '' || PROS.some((p) => p.id === saved) ? saved : (PROS.find((p) => p.data) || PROS[0]).id;
}
$('proSelect').addEventListener('change', async () => {
  store.set(KEY_PRO, $('proSelect').value);
  if (analyses().length) await renderAll({ scroll: false });
});

// 把职业球员的骨架数据当作一次「分析」：用数据里人工核对过的 P1–P10，指标用同一套算法
async function loadSelectedPro() {
  const info = PROS.find((p) => p.id === $('proSelect').value);
  const club = analyses()[0]?.settings.club || $('club').value;
  const pick = pickProData(info, club);
  if (!pick) { state.pro = null; return; }
  if (state.pro?.id === info.id && state.pro.club === pick.club) return;
  const views = {};
  for (const v of VIEWS) {
    if (!pick.files[v]) continue;
    const d = await loadProFrames(pick.files[v]);
    const a = analyzeFrames(d.frames, { handed: d.handed, club: d.club, view: v }, { aspect: d.aspect, pro: true });
    a.P = { ...d.P };
    score(a);
    a.crop = cropBox(POSITIONS.map((p) => a.frames[a.P[p]].lm), a.aspect);
    if (d.images) {
      // 有原画面：各 P 位置的截图（只在用到时下载）
      const byTime = new Map(Object.entries(d.images).map(([pos, url]) => [a.frames[d.P[pos]].t, versioned(url)]));
      a.source = imageSource(byTime);
      a.sourceMirror = imageSource(byTime, { mirror: true });
      a.credit = d.imageCredit;
    } else {
      const ankle = (POSITIONS.map((p) => a.frames[a.P[p]].lm)).flatMap((lm) => [lm[27].y, lm[28].y]);
      a.source = a.sourceMirror = blankSource(Math.max(...ankle) + 0.01);
    }
    views[v] = a;
  }
  state.pro = { id: info.id, name: info.name, views, club: pick.club, fallback: pick.fallback };
}

// 职业球员和用户朝向不同时（左手球员、相机在另一侧）水平翻转骨架
function mirrorFrame(frame, crop, mirror) {
  if (!mirror) return frame;
  const cx = crop.x + crop.w / 2;
  return { ...frame, lm: frame.lm.map((p) => ({ ...p, x: 2 * cx - p.x })) };
}

function proResult(r) {
  const a = state.pro?.views[r.view];
  if (!a || r.id === 'tempo') return null; // 职业视频可能经过剪辑变速，节奏不作对比
  return a.results.find((x) => x.id === r.id) || null;
}
function proNum(r) { return proResult(r)?.value ?? NaN; }
function proValue(r) {
  const p = proResult(r);
  return p && Number.isFinite(p.value) ? formatValue(p.metric, p.value) : null;
}
// 和职业球员对比的说明，如「比 Adam Scott 少 25°」
function vsProText(r) {
  if (r.vsPro === undefined || !state.pro) return '';
  const d = r.vsPro;
  const unit = r.metric.unit === '°' ? '°' : ` ${r.metric.unit}`;
  return `比 ${state.pro.name} ${d < 0 ? '少' : '多'} ${Math.abs(d).toFixed(r.metric.digits)}${unit}`;
}

// 和你上传的角度相同的视频排在前面
function renderPros() {
  const info = PROS.find((p) => p.id === $('proSelect').value);
  $('proExtra').hidden = !info;
  if (!info) return;
  const mine = analyses().map((a) => a.view);
  const order = [...VIEWS].sort((x, y) => mine.includes(y) - mine.includes(x));
  const pick = pickProData(info, analyses()[0]?.settings.club || $('club').value);
  const missing = pick ? mine.filter((v) => !pick.files[v]) : [];
  $('proNote').textContent = info.note + (pick
    ? `${pick.fallback ? `（这位球员还没有${CLUB_NAME[analyses()[0]?.settings.club] || ''}数据，用的是${CLUB_NAME[pick.club]}挥杆）` : `（${CLUB_NAME[pick.club]}挥杆）`}`
      + (missing.length ? `暂无${missing.map((v) => VIEW_SHORT[v]).join('、')}数据。` : ' 下面每个 P 位置的右边就是这位球员的同一位置。')
    : ' 这位球员的骨架数据还没有，暂时只能看视频。');
  $('proVideos').innerHTML = order.filter((v) => info[v]).map((v) => `
    <div class="pro-video">
      <b>${info.name} · ${VIEW_SHORT[v]}${mine.includes(v) ? '<span class="tag">对应你的视频</span>' : ''}</b>
      <div class="frame"><iframe src="${embedURL(info[v])}" title="${info.name} ${VIEW_SHORT[v]}挥杆" loading="lazy"
        allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen></iframe></div>
    </div>`).join('');
}

// ---------- 手动校正 ----------
const activeA = () => state.views[state.active] || analyses()[0];

function setupScrub() {
  const list = analyses();
  if (!state.views[state.active]) state.active = list[0].view;
  const sel = $('scrubView');
  sel.hidden = list.length < 2;
  sel.innerHTML = list.map((a) => `<option value="${a.view}">${VIEW_SHORT[a.view]}视频</option>`).join('');
  sel.value = state.active;
  const u = activeA();
  const sl = $('scrub');
  sl.max = u.frames.length - 1;
  sl.value = u.P[$('assignPos').value] ?? u.P.P4;
  if (!$('assignPos').options.length) {
    $('assignPos').innerHTML = POSITIONS.map((p) => `<option value="${p}">${p} ${POSITION_INFO[p].name}</option>`).join('');
    $('assignPos').value = 'P4';
    sl.value = u.P.P4;
  }
  drawScrub();
}
$('scrubView').addEventListener('change', () => { state.active = $('scrubView').value; setupScrub(); });

let scrubBusy = false, scrubPending = false;
async function drawScrub() {
  if (scrubBusy) { scrubPending = true; return; }
  scrubBusy = true;
  const u = activeA();
  const i = Math.min(Number($('scrub').value), u.frames.length - 1);
  const at = POSITIONS.filter((p) => u.P[p] === i);
  await drawFrame($('scrubCanvas'), u.source, u.frames[i], u.crop, { label: `第 ${i} 帧 · ${u.frames[i].t.toFixed(2)}s${at.length ? ` · ${at.join(' / ')}` : ''}` });
  drawTimeline($('timeline'), u.speed, u.frames, u.P, i);
  scrubBusy = false;
  if (scrubPending) { scrubPending = false; drawScrub(); }
}
$('scrub').addEventListener('input', drawScrub);
$('assignPos').addEventListener('change', () => { $('scrub').value = activeA().P[$('assignPos').value]; drawScrub(); });

$('assign').addEventListener('click', async () => {
  activeA().P[$('assignPos').value] = Number($('scrub').value);
  await rescore();
});
$('resetPhases').addEventListener('click', async () => {
  const u = activeA();
  u.P = { ...u.autoP };
  await rescore();
});

async function rescore() {
  score(activeA());
  const keep = $('scrub').value;
  await renderAll();
  $('scrub').value = keep;
  drawScrub();
}

// ---------- AI 教练（GitHub Actions + Claude Code，订阅额度） ----------
const KEY_REPO = 'swingCoach.repo', KEY_TOKEN = 'swingCoach.token', KEY_LAST = 'swingCoach.lastRequest';
$('ghRepo').value = store.get(KEY_REPO) || guessRepo();
$('ghToken').value = store.get(KEY_TOKEN) || '';
if (!$('ghToken').value) $('ghSetup').open = true;
else $('autoMethod').open = true;
$('ghRepo').addEventListener('change', () => store.set(KEY_REPO, $('ghRepo').value.trim()));
$('ghToken').addEventListener('change', () => store.set(KEY_TOKEN, $('ghToken').value.trim()));
$('coachLast').hidden = !store.get(KEY_LAST);

function coachClient() {
  return new GitHubCoach($('ghRepo').value.trim(), $('ghToken').value.trim());
}

// 关键帧（所有角度）：withVideo 为 false 时只画骨架（不含视频画面）
async function keyframeCanvases(withVideo, { width = 480, height = 560, labelSize = 15 } = {}) {
  const out = [];
  for (const a of analyses()) {
    const source = withVideo ? a.source : blankSource();
    for (const pos of POSITIONS) {
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const label = `${multi() ? VIEW_SHORT[a.view] + ' ' : ''}${pos} ${POSITION_INFO[pos].name}`;
      await drawFrame(canvas, source, a.frames[a.P[pos]], a.crop, {
        template: alignTemplate(pos, a.ref, opts(a)), label, labelSize,
      });
      out.push({ canvas, pos, view: a.view });
    }
  }
  return out;
}

async function keyframeImages(withVideo) {
  return (await keyframeCanvases(withVideo)).map((k) => ({ pos: k.pos, view: k.view, data: k.canvas.toDataURL('image/jpeg', 0.8) }));
}

const isDemo = () => !!analyses()[0]?.demo;

// 发给 AI 的测量数据（两种方式共用，包含所有角度）
function coachData(withVideo) {
  const list = analyses();
  const first = list[0];
  const timing = (a) => Object.fromEntries(POSITIONS.map((p) => [p, Number(a.frames[a.P[p]].t.toFixed(3))]));
  const { results, summary } = combined();
  return {
    settings: {
      handed: first.settings.handed, club: first.settings.club,
      view: list.length === 1 ? first.view : 'both', views: list.map((a) => a.view),
      demo: isDemo(), skeletonOnly: !withVideo,
    },
    note: $('coachNote').value.trim(),
    score: summary.score,
    timing: list.length === 1 ? timing(first) : Object.fromEntries(list.map((a) => [VIEW_SHORT[a.view], timing(a)])),
    metrics: results.map((r) => ({
      view: VIEW_SHORT[r.view], pos: r.pos, name: r.metric.name, value: formatValue(r.metric, r.value), pro_range: fmtRange(r),
      status: r.status, issue: r.advice?.issue ?? null,
      pro_value: proValue(r) ? `${state.pro.name} ${proValue(r)}` : null,
    })),
  };
}

// ---------- 分享给朋友：结果卡片 ----------
const card = { file: null, url: null };

$('makeCard').addEventListener('click', async () => {
  const list = analyses();
  if (!list.length) return;
  $('makeCard').disabled = true;
  try {
    const withVideo = $('cardFrames').checked && !isDemo();
    const { summary } = combined();
    const first = list[0];
    const canvas = resultCard({
      score: summary.score,
      counts: summary.counts,
      facts: [
        ['拍摄角度', list.map((a) => VIEW_SHORT[a.view]).join(' + ')],
        ['球杆', `${CLUB_TEXT[first.settings.club]} · ${first.settings.handed === 'left' ? '左手' : '右手'}`],
        ['节奏 上杆:下杆（职业约 3:1）', list.map((a) => tempoText(a)).join(' / ')],
      ],
      priorities: summary.priorities.map((r) => ({
        status: r.status,
        title: `${multi() ? `[${VIEW_SHORT[r.view]}] ` : ''}${r.pos} ${POSITION_INFO[r.pos].name} · ${r.advice.issue}`,
        detail: `${r.metric.name}：${formatValue(r.metric, r.value)}，职业区间 ${fmtRange(r)}`,
        fix: r.advice.fix,
      })),
      frames: (await keyframeCanvases(withVideo, { width: 360, height: 420, labelSize: 30 })).map((k) => k.canvas),
      footer: `${isDemo() ? '示例数据 · ' : ''}挥杆教练 P1–P10 分析 · ${location.host}${location.pathname}`,
    });
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.9);
    if (card.url) URL.revokeObjectURL(card.url);
    card.url = URL.createObjectURL(blob);
    card.file = new File([blob], 'swing-result.jpg', { type: 'image/jpeg' });
    $('cardImg').src = card.url;
    $('saveCard').href = card.url;
    $('shareCard').hidden = !(navigator.canShare && navigator.canShare({ files: [card.file] }));
    $('cardPanel').hidden = false;
    $('cardPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    showError(`生成卡片失败：${err.message || err}`);
  } finally {
    $('makeCard').disabled = false;
  }
});

// 只分享图片：微信等应用在图文一起分享时常常丢掉文字或图片
$('shareCard').addEventListener('click', () => {
  if (!card.file) return;
  navigator.share({ files: [card.file] }).catch((err) => {
    if (err.name !== 'AbortError') $('cardStatus').textContent = `分享失败：${err.message}，请用「保存图片」后再发送。`;
  });
});

// ---------- 方式一：发给 Claude App ----------
let coachPrompt = null;
const share = { text: '', file: null, url: null };

$('prepareShare').addEventListener('click', async () => {
  if (!analyses().length) return;
  $('prepareShare').disabled = true;
  $('shareStatus').textContent = '';
  try {
    coachPrompt ||= await fetch(versioned('coach-prompt.md')).then((r) => { if (!r.ok) throw new Error('读取提示词失败'); return r.text(); });
    const withVideo = $('shareFrames').checked && !isDemo();
    const big = montage((await keyframeCanvases(withVideo, { width: 360, height: 420, labelSize: 22 })).map((k) => k.canvas));
    const blob = await canvasToBlob(big);
    if (share.url) URL.revokeObjectURL(share.url);
    share.url = URL.createObjectURL(blob);
    share.file = new File([blob], 'swing-p1-p10.jpg', { type: 'image/jpeg' });
    share.text = buildShareText(coachPrompt, coachData(withVideo));
    $('shareImg').src = share.url;
    $('saveImg').href = share.url;
    $('sharePanel').hidden = false;
    $('shareBtn').hidden = !(navigator.canShare && navigator.canShare({ files: [share.file] }));
    $('sharePanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    $('shareStatus').textContent = err.message || String(err);
    $('sharePanel').hidden = false;
  } finally {
    $('prepareShare').disabled = false;
  }
});

// 复制和分享都必须直接在点击里发起（iPhone 要求用户手势），所以不在调用前 await 其他操作
$('shareBtn').addEventListener('click', () => {
  if (!share.file) return;
  const copied = copyText(share.text);
  navigator.share({ files: [share.file], text: share.text })
    .then(async () => {
      $('shareStatus').textContent = (await copied)
        ? '文字已复制。在 Claude 输入框长按「粘贴」后发送。'
        : '分享完成。如果 Claude 里没有文字，请点「复制文字」再粘贴。';
    })
    .catch(async (err) => {
      if (err.name === 'AbortError') return;
      $('shareStatus').textContent = `分享失败：${err.message}。请用「保存图片」和「复制文字」手动发送。`;
    });
});

$('copyBtn').addEventListener('click', async () => {
  $('shareStatus').textContent = (await copyText(share.text))
    ? '点评请求文字已复制，到 Claude 里粘贴即可。'
    : '复制失败，请长按下面的文字手动复制。';
});

async function waitAndShow(gh, id) {
  const out = $('coachOut');
  const r = await gh.waitFor(id, {
    onTick: (s) => { out.innerHTML = `<p class="muted">已提交（编号 ${id}），Claude 正在看你的关键帧… 已等待 ${s} 秒。可以先离开页面，稍后点「查看上次点评」。</p>`; },
  });
  if (r.text) out.innerHTML = markdown(r.text);
  else if (r.error) out.innerHTML = `<p class="error">${escapeHTML(r.error)}</p>`;
  else out.innerHTML = '<p class="error">等待超时。请到仓库的 Actions 页面查看 Swing coach review 是否运行成功，稍后再点「查看上次点评」。</p>';
}

$('coach').addEventListener('click', async () => {
  if (!analyses().length) return;
  const out = $('coachOut');
  $('coach').disabled = true;
  try {
    const gh = coachClient();
    store.set(KEY_REPO, gh.repo);
    store.set(KEY_TOKEN, gh.token);
    out.innerHTML = '<p class="muted">正在生成关键帧并提交…</p>';
    const withVideo = $('sendFrames').checked && !isDemo();
    const payload = { ...coachData(withVideo), images: await keyframeImages(withVideo) };
    const id = await gh.submit(payload);
    store.set(KEY_LAST, id);
    $('coachLast').hidden = false;
    await waitAndShow(gh, id);
  } catch (err) {
    out.innerHTML = `<p class="error">${escapeHTML(err.message || String(err))}</p>`;
  } finally {
    $('coach').disabled = false;
  }
});

$('coachLast').addEventListener('click', async () => {
  const id = store.get(KEY_LAST);
  if (!id) return;
  try { await waitAndShow(coachClient(), id); } catch (err) { $('coachOut').innerHTML = `<p class="error">${escapeHTML(err.message)}</p>`; }
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
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { close(); const h = Math.min(4, m[1].length + 1); html += `<h${h}>${inline(m[2])}</h${h}>`; }
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
