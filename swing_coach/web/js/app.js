// 页面逻辑：上传 → 姿态识别 → P1–P10 检测 → 指标评估 → 渲染对比结果 →（可选）AI 教练点评

import { extractPoses, fillMissing, primeVideo, videoDuration } from './pose.js';
import { smoothFrames, detectPhases, findSwings } from './phases.js';
import { detectImpact } from './impact.js';
import { makeContext, evaluate, summarize, formatValue, transitionIndex, aggregateResults, representativeIndex } from './metrics.js';
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

// views：每个拍摄角度当前显示的一杆（多杆时带 group）；swings：所有识别出的挥杆；active：校正面板当前选中的角度
const state = { views: { fo: null, dtl: null }, swings: [], notes: [], active: null };
// 上传的视频：一个或多个，正面 / 侧面自动识别，长视频自动找出每一杆
const files = [];
let fileSeq = 0;

// 手机上逐帧识别较慢，默认 30fps
const isPhone = window.matchMedia?.('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
if (isPhone) $('fps').value = '30';

// 慢动作选项：iPhone 慢动作导出后都是 30fps，120 帧放慢 4 倍、240 帧放慢 8 倍
const SLOW_OPTIONS = { 120: 4, 240: 8 };

function settings() {
  return {
    handed: $('handed').value,
    club: $('club').value,
    // 「120 帧慢动作」：iPhone 导出的慢动作是放慢 4 倍的 30fps 视频，逐帧采样，时间除以 4 换算回真实时间
    fps: SLOW_OPTIONS[$('fps').value] ? 30 : Number($('fps').value),
    slow: SLOW_OPTIONS[$('fps').value] || 1,
    model: $('model').value,
  };
}

// 单段视频最长分析多久；超过 SINGLE_MAX 秒就当作「多杆长视频」，先粗扫找出每一杆
const MAX_LEN = 180, SINGLE_MAX = 8, MAX_SWINGS = 8;

const analyses = () => VIEWS.map((v) => state.views[v]).filter(Boolean);

// ---------- 上传（一个或多个视频，不用分正面侧面） ----------
const drop = $('drop-all');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  [...(e.dataTransfer.files || [])].forEach(addVideo);
});
$('file-all').addEventListener('change', (e) => {
  [...e.target.files].forEach(addVideo);
  e.target.value = ''; // 允许再次选择同一个文件
});
$('videoList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-remove]');
  if (b) removeVideo(Number(b.dataset.remove));
});

function addVideo(file) {
  if (!file.type.startsWith('video/') && !/\.(mov|mp4|m4v|webm)$/i.test(file.name)) return;
  const f = { id: ++fileSeq, name: file.name, url: URL.createObjectURL(file), duration: 0 };
  // 视频元素放在列表里当缩略预览；iPhone 需要元素在页面上才能稳定解码
  const video = document.createElement('video');
  Object.assign(video, { muted: true, playsInline: true, preload: 'auto' });
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  // 注意：不要在 blob 地址后加 #t= 之类的片段，iPhone Safari 会因此读不出视频
  video.src = f.url;
  f.video = video;
  files.push(f);
  video.onloadedmetadata = () => {
    f.duration = videoDuration(video);
    // 缩略图显示开头附近的一帧（有的浏览器停在第 0 帧是黑屏）
    try { video.currentTime = Math.min(0.1, f.duration / 2); } catch { /* 忽略 */ }
    renderVideoList();
  };
  video.onerror = () => {
    f.error = true;
    renderVideoList();
  };
  video.load();
  renderVideoList();
  hideError();
}

function removeVideo(id) {
  const i = files.findIndex((f) => f.id === id);
  if (i < 0) return;
  URL.revokeObjectURL(files[i].url);
  files.splice(i, 1);
  renderVideoList();
}

function renderVideoList() {
  const list = $('videoList');
  list.hidden = !files.length;
  drop.classList.toggle('compact', files.length > 0);
  // 每个视频的行只建一次，之后只更新文字：反复把 video 元素移出页面再放回，Safari 可能中断加载
  for (const li of [...list.children]) if (!files.some((f) => f.li === li)) li.remove();
  files.forEach((f, i) => {
    if (!f.li) {
      f.li = document.createElement('li');
      f.info = document.createElement('div');
      f.li.append(f.video, f.info);
    }
    if (list.children[i] !== f.li) list.insertBefore(f.li, list.children[i] || null);
    const long = f.duration > SINGLE_MAX;
    const state = f.error ? '<span class="bad-text">这个视频读不出来</span>'
      : f.duration ? `${f.duration.toFixed(1)} 秒` : '读取中…';
    const note = f.error ? '可以移除后重新选择，或换一段视频'
      : long ? `长视频：自动找出每一杆${f.duration > MAX_LEN ? `（只分析前 ${MAX_LEN / 60} 分钟）` : ''}` : '一杆';
    f.info.innerHTML = `<b>视频 ${i + 1}</b> <span class="muted small">${state}</span>
      <div class="muted small">${note}</div>
      <button type="button" class="link-btn" data-remove="${f.id}">移除</button>`;
  });
  updateAnalyzeButton();
}

function updateAnalyzeButton() {
  const ok = files.filter((f) => !f.error).length;
  $('analyze').disabled = ok === 0;
  $('analyze').textContent = ok > 1 ? `开始分析（${ok} 个视频）` : '开始分析';
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
  while (files.length) removeVideo(files[0].id);
  state.views = { fo: null, dtl: null };
  state.swings = [];
  state.notes = [];
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
  a.phaseWarning = phaseSanity(a);
  score(a);
  return a;
}

// P 位置明显不合理时提醒（挥杆识别错了，结果会全部跑偏）
function phaseSanity(a) {
  const t = (p) => a.frames[a.P[p]].t;
  const same = ['P2', 'P3', 'P4', 'P5', 'P6', 'P7'].some((p, i, arr) => i > 0 && a.P[p] === a.P[arr[i - 1]]);
  // 慢动作视频的时间被拉长了，不按用时判断
  const badTime = !isSlowMo(a) && (t('P4') - t('P1') > 3.5 || t('P7') - t('P4') > 2.5);
  if (same || badTime || a.P.P1 === 0 && a.P.P2 <= 2) {
    return `${VIEW_SHORT[a.view] || ''}视频里这一杆的关键位置可能识别有误（例如两个位置落在同一帧、上杆或下杆用时不合理）。请对照下面的画面检查，可以在「P 位置校正」里手动调整。`;
  }
  return null;
}

// 看起来是没换算的慢动作：真人下杆不超过约 0.5 秒，超过 0.8 秒只能是放慢了。
// 节奏是比例，均匀放慢不影响；只有用时需要在「采样帧率」里选慢动作换算
// 从下杆开始（双手下降 6%）算，顶点真正的停顿不计入，避免把在顶点停一下的真人挥杆当成慢动作
const downswingTime = (a) => a.frames[a.P.P7].t - a.frames[transitionIndex(a.frames, a.P, a.settings.handed)].t;
const isSlowMo = (a) => !a.pro && downswingTime(a) > 0.8;

function score(a) {
  const impact = a.impact ? { frame: a.impact.frame, ball: a.impact.ballLm } : null;
  // 姿态模型的延迟约一帧（视频时间 0.033 秒）；慢动作换算成真实时间后要除以放慢倍数
  const lagSec = 0.033 / (a.settings.slow || 1);
  const ctx = makeContext(a.frames, a.P, { view: a.view, dir: a.dir, handed: a.settings.handed, club: a.settings.club, impact, lagSec });
  a.slowMo = isSlowMo(a);
  a.results = evaluate(ctx).map((r) => ({ ...r, view: a.view }));
  a.oblique = a.view === 'fo' && ctx.oblique();
  a.summary = summarize(a.results);
  a.ref = { lm: a.frames[a.P.P1].lm, dir: a.dir };
  if (a.group) regroup(a.group);
}

// 一个角度的结果：多杆时是各杆综合，单杆就是这一杆
const resultsOf = (a) => a.group?.results || a.results;

// 多杆：逐杆结果综合，选出最有代表性的一杆用来显示关键帧
function makeGroup(swings) {
  const group = { swings, index: 0 };
  regroup(group);
  group.index = representativeIndex(swings.map((a) => a.results), group.results);
  for (const a of swings) a.group = group;
  return group;
}
function regroup(group) {
  group.results = aggregateResults(group.swings.map((a) => a.results));
}

// 所有角度合在一起的结果
function combined() {
  // 参考类指标（转动角度等）只显示数值，不打分，也不和职业球员比较：
  // 单机位估算的误差因视频而异（同样转得很充分，有的视频估出 90°，有的只有 25°），比较会产生误报
  const results = analyses().flatMap(resultsOf);
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
  toRealTime(filled, s);
  let a = analyzeFrames(filled, s, { aspect, source: frameSource(filled) });
  // 没选慢动作、但看起来是慢动作（顶点到击球在视频里超过 0.8 秒）：按下杆用时估计放慢倍数，换算后重新分析。
  // 真人下杆约 0.25–0.45 秒，视频里 2.4 秒以内按 4 倍（120 帧），更长按 8 倍（240 帧）
  if ((s.slow || 1) === 1 && isSlowMo(a)) {
    const factor = downswingTime(a) < 2.4 ? 4 : 8;
    const s2 = { ...s, slow: factor, autoSlow: true };
    toRealTime(filled, s2);
    a = analyzeFrames(filled, s2, { aspect, source: frameSource(filled) });
  }
  a.missingRatio = missingRatio;
  setProgress(1, `${label}确定击球帧…`);
  await locateImpact(a, filled);
  return a;
}

// 用画面里的球确定击球帧：找到了就用它作为 P7（比按手速判断准），并用于杆身前倾
async function locateImpact(a, frames) {
  if (!frames[a.P.P1]?.img) return;
  const cache = new Map();
  const canvas = document.createElement('canvas');
  const c2d = canvas.getContext('2d', { willReadFrequently: true });
  const gray = async (i) => {
    if (cache.has(i)) return cache.get(i);
    const bmp = await createImageBitmap(frames[i].img);
    canvas.width = bmp.width; canvas.height = bmp.height;
    c2d.drawImage(bmp, 0, 0);
    bmp.close?.();
    const px = c2d.getImageData(0, 0, canvas.width, canvas.height).data;
    const data = new Float32Array(canvas.width * canvas.height);
    for (let k = 0, j = 0; k < data.length; k++, j += 4) data[k] = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];
    const g = { data, w: canvas.width, h: canvas.height };
    cache.set(i, g);
    return g;
  };
  try {
    const res = await detectImpact(a.frames, a.P, { gray, view: a.view, dir: a.dir });
    if (!res) return;
    const H = (await gray(a.P.P1)).h;
    a.impact = { frame: res.frame, ballLm: { x: res.ball.x / H, y: res.ball.y / H } };
    // 击球帧在 P6 和 P8 之间才替换 P7，避免打乱位置顺序
    if (res.frame > a.P.P6 && res.frame < a.P.P8) a.P.P7 = a.autoP.P7 = res.frame;
    score(a);
  } catch (err) {
    console.warn('击球帧识别失败', err);
  }
}

// 慢动作视频：视频里的时间除以放慢倍数，换算成真实时间（之后的节奏、用时和各种按秒的判断都用真实时间）
function toRealTime(frames, s) {
  if ((s.slow || 1) > 1) for (const f of frames) f.t /= s.slow;
  return frames;
}

// 一个视频：短视频当作一杆；长视频先低帧率粗扫找出每一杆，再逐杆分析。每一杆各自识别正面 / 侧面
async function analyzeFile(f, s, label) {
  const dur = Math.min(f.duration || videoDuration(f.video), MAX_LEN);
  if (!(dur > SINGLE_MAX)) {
    const a = await analyzeVideo(f.video, { ...s, start: 0, end: dur }, label);
    return [Object.assign(a, { fileNo: f.no })];
  }
  setProgress(0, `${label}加载姿态识别模型…`);
  const { frames } = await extractPoses(f.video, {
    fps: 12, start: 0, end: dur, model: s.model, snapshots: false,
    onProgress: (x) => setProgress(x, `${label}寻找每一杆 ${Math.round(x * 100)}%`),
  });
  if (frames.filter((x) => x.lm).length < frames.length * 0.2) throw new Error(`${label}大部分画面没有识别到人体，请确保全身在画面中、光线充足`);
  // 找杆按真实时间判断（两杆间隔、上杆时长），找到的窗口再换回视频时间去截取
  const slow = s.slow || 1;
  const found = findSwings(toRealTime(fillMissing(frames).frames, s), { handed: s.handed })
    .map((w) => ({ start: w.start * slow, end: w.end * slow, peak: w.peak * slow }));
  if (!found.length) throw new Error(`${label}没有找到完整的挥杆（需要上杆到双手过肩）`);
  const windows = found.slice(0, MAX_SWINGS);
  if (found.length > windows.length) state.notes.push(`${label}找到 ${found.length} 杆，只分析了前 ${MAX_SWINGS} 杆`);
  const out = [];
  for (const [k, w] of windows.entries()) {
    try {
      const a = await analyzeVideo(f.video, { ...s, start: w.start, end: w.end }, `${label}第 ${k + 1}/${windows.length} 杆：`);
      out.push(Object.assign(a, { fileNo: f.no, swingAt: w.peak }));
    } catch (err) {
      console.warn('跳过一杆', w, err);
      state.notes.push(`${label}${w.peak.toFixed(1)} 秒处的一杆没能完成分析`);
    }
  }
  if (!out.length) throw new Error(`${label}找到 ${windows.length} 杆，但都没能完成分析，请确认全身在画面中、光线充足`);
  return out;
}

// 按识别出的角度分组：每组一杆就直接用，多杆则综合并选出代表的一杆
function groupByView(swings) {
  const views = { fo: null, dtl: null };
  for (const v of VIEWS) {
    const list = swings.filter((a) => a.view === v);
    list.forEach((a, i) => { delete a.group; a.swingNo = i + 1; });
    if (list.length === 1) views[v] = list[0];
    else if (list.length > 1) views[v] = list[makeGroup(list).index];
  }
  return views;
}

$('analyze').addEventListener('click', async () => {
  // 必须在点击事件里同步调用（iPhone 要求播放由用户手势触发）
  const todo = files.filter((f) => !f.error);
  const primed = todo.map((f) => primeVideo(f.video));
  hideError();
  $('analyze').disabled = true;
  try {
    await Promise.all(primed);
    const s = settings();
    state.notes = [];
    const swings = [];
    const errors = [];
    for (const [k, f] of todo.entries()) {
      f.no = k + 1;
      const label = todo.length > 1 ? `视频 ${k + 1}：` : '';
      try {
        swings.push(...await analyzeFile(f, s, label));
      } catch (err) {
        console.error(err);
        errors.push(err.message || String(err));
      }
    }
    if (!swings.length) throw new Error(errors.join(' '));
    state.notes.unshift(...errors);
    state.swings = swings;
    state.views = groupByView(swings);
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
  const warnings = list.map((a) => a.viewWarning || a.phaseWarning).filter(Boolean);
  const auto = list.find((a) => a.settings.autoSlow);
  if (auto) warnings.push(`已自动识别为慢动作视频，按约 ${auto.settings.slow} 倍换算成真实时间（iPhone 慢动作导出后都是 30 帧：120 帧放慢约 4 倍、240 帧约 8 倍）。如果倍数不对，请在「采样帧率」里手动选择后重新分析。`);
  if (list.some((a) => a.slowMo)) warnings.push('看起来是慢动作视频：节奏比例照常计算；上杆 / 下杆用时是放慢后的视频时间。如果是 120 帧慢动作，在「采样帧率」里选「120 帧慢动作」再分析，就会换算成真实时间。');
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
  const r = resultsOf(a).find((x) => x.id === 'tempo');
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
    ['拍摄角度', list.map((a) => VIEW_SHORT[a.view] + (a.group ? ` ${a.group.swings.length} 杆` : '')).join(' + ') + (list.length === 1 ? '（可再传另一个角度）' : '')],
    ['球杆 / 惯用手', `${CLUB_TEXT[first.settings.club]} · ${first.settings.handed === 'left' ? '左手' : '右手'}`],
    ['节奏 上杆:下杆', list.map((a) => (multi() ? `${VIEW_SHORT[a.view]} ${tempoText(a)}` : tempoText(a))).join('，')],
    ...list.map((a) => {
      const t = (p) => a.frames[a.P[p]].t;
      // 和节奏一致：下杆从双手开始下落算起
      const tt = a.frames[transitionIndex(a.frames, a.P, a.settings.handed)].t;
      const which = [multi() ? VIEW_SHORT[a.view] : '', a.group ? `第 ${a.swingNo} 杆` : ''].filter(Boolean).join(' ');
      return [`上杆 / 下杆用时${which ? `（${which}）` : ''}`, `${(tt - t('P1')).toFixed(2)}s / ${(t('P7') - tt).toFixed(2)}s${a.slowMo ? '（慢动作，未换算）' : ''}`];
    }),
    ...(first.demo ? [['数据来源', '示例合成挥杆']] : []),
    ['对比模板', state.pro ? `内置职业模板 + ${state.pro.name}` : '内置职业模板'],
  ].map(([k, v]) => `<div>${k}<b>${v}</b></div>`).join('');
  // 只有一个角度时，说明另一个角度才能看的项目，避免误以为这些都没问题
  const only = list.length === 1 ? list[0].view : null;
  $('missingView').hidden = !only;
  if (only) $('missingView').innerHTML = `<b>这次没有${only === 'dtl' ? '正面' : '侧面'}视频，以下项目没有检查：</b>${MISSING_TEXT[only]}。`;
  renderSwingPicker();
  $('counts').innerHTML = ['good', 'warn', 'bad', 'na', 'ref'].filter((s) => s !== 'ref' || counts.ref)
    .map((s) => `<div><span class="chip ${s}">${STATUS_TEXT[s]}</span> ${counts[s]} 项</div>`).join('');
}

// 多杆：说明评分是综合结果，并可切换下面关键帧、轨迹、逐帧查看显示的是哪一杆
// 识别出的每一杆：按正面 / 侧面分组列出，可切换关键帧显示的那一杆；角度认错了可以改
function renderSwingPicker() {
  const list = analyses();
  $('swingPicker').hidden = isDemo() || !list.length;
  if (isDemo()) return;
  const many = new Set(state.swings.map((a) => a.fileNo)).size > 1;
  const where = (a) => [many ? `视频 ${a.fileNo}` : '', a.swingAt != null ? `${a.swingAt.toFixed(1)} 秒处` : ''].filter(Boolean).join(' ');
  const lines = list.map((a) => {
    const all = a.group ? a.group.swings : [a];
    const other = a.view === 'fo' ? 'dtl' : 'fo';
    const chips = all.length > 1
      ? `关键帧显示：${all.map((x, i) => `<button type="button" class="swing-btn${x === a ? ' on' : ''}" data-view="${a.view}" data-i="${i}" title="${where(x)}">第 ${x.swingNo} 杆${i === a.group.index ? '（代表）' : ''}</button>`).join('')}`
      : '';
    return `<div><b>${VIEW_SHORT[a.view]} ${all.length} 杆</b>${all.length > 1 ? '，评分和检查项取各杆中位数' : ''}。${chips}
      <span class="muted">${all.length > 1 ? '当前这一杆' : ''}${where(a) ? `来自${where(a)}` : ''}</span>
      <button type="button" class="link-btn flip" data-flip="${a.view}">这一杆其实是${VIEW_SHORT[other]}？</button></div>`;
  });
  const notes = state.notes.map((n) => `<div class="muted">${n}</div>`);
  $('swingPicker').innerHTML = [...lines, ...notes].join('');
}
$('swingPicker').addEventListener('click', async (e) => {
  const b = e.target.closest('.swing-btn');
  if (b) {
    const a = state.views[b.dataset.view];
    state.views[b.dataset.view] = a.group.swings[Number(b.dataset.i)];
    await renderAll({ scroll: false });
    return;
  }
  const flip = e.target.closest('[data-flip]');
  if (!flip) return;
  // 把当前显示的这一杆按另一个角度重新分析，再重新分组
  const a = state.views[flip.dataset.flip];
  const other = a.view === 'fo' ? 'dtl' : 'fo';
  const b2 = analyzeFrames(a.raw, { ...a.settings, view: other }, {
    aspect: a.aspect, source: a.source, missingRatio: a.missingRatio, fileNo: a.fileNo, swingAt: a.swingAt,
  });
  state.swings[state.swings.indexOf(a)] = b2;
  state.views = groupByView(state.swings);
  state.views[other] = b2;
  await renderAll({ scroll: false });
});

const MISSING_TEXT = {
  dtl: '站位宽度、骨盆左右移动和重心转移、头部左右移动、脊柱侧倾、击球时手领先、前腿支撑、送杆伸展。侧面视频拍不出朝目标方向的动作，这些只能从正面看；下次可以请朋友站到你正前方拍一杆',
  fo: '脊柱前倾和保持、提前伸展（臀部靠近球）、头部高度变化、膝盖弯曲、下杆双手路径（由外向内）。这些只能从侧面看；下次可以请朋友站到你身后、沿目标线方向拍一杆',
};

function renderPriorities() {
  const pr = combined().summary.priorities;
  if (!pr.length) {
    const tip = multi() ? '继续保持！' : '可以再拍另一个角度（正面 / 侧面）检查一次。';
    $('priorities').innerHTML = `<li><b>各项检查都在职业区间内，继续保持！</b><div class="detail">${tip}</div></li>`;
    return;
  }
  $('priorities').innerHTML = pr.map((r) => `
    <li>
      <b>${viewTag(r)}${r.pos} ${POSITION_INFO[r.pos].name} · ${r.advice.issue}</b> <span class="chip ${r.status}">${STATUS_TEXT[r.status]}</span>${tpiTag(r)}
      <div class="detail">${r.metric.name}：${formatValue(r.metric, r.value)}（职业区间 ${fmtRange(r)}）。${r.advice.why}</div>
      <div class="drill"><b>怎么改：</b>${r.advice.fix}</div>
      <div class="drill"><b>练习：</b>${r.advice.drill}</div>
      ${r.tpi ? `<div class="drill"><b>身体自测：</b>${r.tpi.screen}</div>` : ''}
    </li>`).join('');
}

// TPI 常见挥杆问题的名称（方便和教练、TPI 资料对照）
const tpiTag = (r) => (r.tpi ? ` <span class="tpi">TPI · ${r.tpi.name}</span>` : '');

function fmtRange(r) {
  const m = r.metric;
  const [lo, hi] = r.range;
  if (m.format) return `${m.format(lo)} – ${m.format(hi)}`;
  if (hi > 180) return `≥ ${lo}${m.unit}`;
  return `${lo} – ${hi} ${m.unit}`;
}


// 各杆的最小 ~ 最大值（单位只写一次）
function spreadText(r) {
  const m = r.metric, [lo, hi] = r.spread;
  if (m.format) return `${m.format(lo)} ~ ${m.format(hi)}`;
  return `${lo.toFixed(m.digits)} ~ ${hi.toFixed(m.digits)}${m.unit ? ` ${m.unit}` : ''}`;
}

function renderTable() {
  const onlyIssues = $('onlyIssues').checked;
  const rows = combined().results.filter((r) => !onlyIssues || r.status === 'warn' || r.status === 'bad');
  const proName = state.pro?.name;
  const note = (r) => (r.advice
    ? `<b>${r.advice.issue}</b>${tpiTag(r)}：${r.advice.why}<br><b>改进：</b>${r.advice.fix}<br><b>练习：</b>${r.advice.drill}${r.tpi ? `<br><b>身体自测：</b>${r.tpi.screen}` : ''}`
    : r.status === 'ref' ? `参考值：单机位视频估算这一项的误差较大（不同视频之间也不稳定），只显示数值，不计入评分，请结合画面判断。<details><summary>说明</summary>${r.metric.about}</details>`
    : r.oblique ? '正面相机没有正对胸口（斜着拍），无法估算转动角度。请把相机放在正前方、与目标线垂直后重拍。'
    : r.noImpact ? '没有在画面里找到球（或球在上杆时就被挡住），无法确定击球的那一帧。拍摄时让球在画面里、清晰可见即可。'
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
        <td class="num c-val"><span class="lbl">你的数值 </span>${formatValue(r.metric, r.value)}${r.spread && r.of > 1 ? `<span class="spread">${r.n} 杆：${spreadText(r)}</span>` : ''}</td>
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
  $('proLegend').textContent = pro ? `每组右边是 ${pro.name} 的同一位置（绿色骨架）${credit ? `，${credit}` : ''}` : '';
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
function proValue(r) {
  const p = proResult(r);
  return p && Number.isFinite(p.value) ? formatValue(p.metric, p.value) : null;
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
      swings: Object.fromEntries(list.filter((a) => a.group).map((a) => [VIEW_SHORT[a.view], { count: a.group.swings.length, shown: a.swingNo }])),
    },
    note: $('coachNote').value.trim(),
    score: summary.score,
    timing: list.length === 1 ? timing(first) : Object.fromEntries(list.map((a) => [VIEW_SHORT[a.view], timing(a)])),
    metrics: results.map((r) => ({
      view: VIEW_SHORT[r.view], pos: r.pos, name: r.metric.name, pro_range: fmtRange(r),
      value: formatValue(r.metric, r.value) + (r.spread && r.of > 1 ? `（${spreadText(r)}）` : ''),
      status: r.status, issue: r.advice ? r.advice.issue + (r.tpi ? `（TPI：${r.tpi.name}）` : '') : null,
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
