// 从职业球员视频中提取骨架数据（只保存关键点，不保存画面），生成 web/pros/<id>-<view>.json。
// 用和网页相同的 MediaPipe 模型在无头 Chromium 里跑识别。
//
// 用法：node swing_coach/tools/extract_pro.mjs <视频文件> <输出 json> --view fo|dtl [--name "Adam Scott"] [--fps 30]
//        [--start 秒] [--end 秒] [--P '{"P1":12}']   （--P 可手动修正自动识别的位置，按帧序号）
//        [--model full|heavy]  识别模型（默认 full）
//        [--slow 15]   慢动作视频的放慢倍数：时间换算回真实速度，P 位置检测和节奏才准

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '../web');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const [videoPath, outPath] = args;
if (!videoPath || !outPath) { console.error('用法见文件开头注释'); process.exit(2); }
const view = opt('view');
if (!['fo', 'dtl'].includes(view)) { console.error('--view 必须是 fo 或 dtl'); process.exit(2); }
const fps = Number(opt('fps', 30));
const start = Number(opt('start', 0));
const end = opt('end') ? Number(opt('end')) : undefined;
const manualP = opt('P') ? JSON.parse(opt('P')) : {};
const slow = Number(opt('slow', 1));
const model = opt('model', 'full');

// 只保存用到的关键点：鼻子、肩肘腕、髋膝踝、脚跟脚尖
export const KEEP = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
const r4 = (x) => Math.round(x * 1e4) / 1e4;

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = url === '/__video' ? path.resolve(videoPath) : path.join(webDir, url === '/' ? 'index.html' : url);
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  const type = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json' }[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${base}/index.html`);
const result = await page.evaluate(async ({ fps, start, end, model }) => {
  const blob = await (await fetch('/__video')).blob();
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.src = URL.createObjectURL(blob);
  await new Promise((r) => { v.onloadeddata = r; });
  const { extractPoses, fillMissing } = await import('/js/pose.js');
  const { frames, aspect } = await extractPoses(v, { fps, start, end, model, snapshots: false });
  const { frames: filled, missingRatio } = fillMissing(frames);
  return { frames: filled.map((f) => ({ t: f.t, lm: f.lm, wl: f.wl })), aspect, missingRatio };
}, { fps, start, end, model });
await browser.close();
server.close();

// 慢动作：t 换算成真实时间，videoT 保留视频里的时间（截图用）
for (const f of result.frames) { f.videoT = f.t; f.t /= slow; }
const { detectPhases } = await import(path.join(webDir, 'js/phases.js'));
const det = detectPhases(result.frames, { handed: 'right', view, club: opt('club', 'iron') });
const P = { ...det.P, ...manualP };

const data = {
  name: opt('name', ''), view, handed: 'right', club: opt('club', 'iron'), fps, slow, aspect: r4(result.aspect),
  keep: KEEP, P,
  frames: result.frames.map((f) => ({
    t: r4(f.t), vt: r4(f.videoT),
    lm: KEEP.map((i) => [r4(f.lm[i].x), r4(f.lm[i].y), r4(f.lm[i].v ?? 1)]),
    wl: f.wl ? KEEP.map((i) => [r4(f.wl[i].x), r4(f.wl[i].y), r4(f.wl[i].z)]) : null,
  })),
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(data));
console.log(JSON.stringify({ out: outPath, frames: data.frames.length, missingRatio: result.missingRatio, detectedView: det.view, P }));
