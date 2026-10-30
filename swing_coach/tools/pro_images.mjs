// 按骨架数据里的 P1–P10，从同一段视频截取各位置的原画面，写入 web/pros/img/，并在 json 里记录路径。
// 用法：node swing_coach/tools/pro_images.mjs <视频> <web/pros/xxx.json> [--credit "画面来源：…"]
// 需要 ffmpeg。截图高 640 像素。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [video, jsonPath, ...rest] = process.argv.slice(2);
if (!video || !jsonPath) { console.error('用法见文件开头注释'); process.exit(2); }
const credit = rest[rest.indexOf('--credit') + 1] && rest.includes('--credit') ? rest[rest.indexOf('--credit') + 1] : undefined;
const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const d = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const base = path.basename(jsonPath, '.json');
const imgDir = path.join(webDir, 'pros/img');
fs.mkdirSync(imgDir, { recursive: true });
d.images = {};
for (const [pos, i] of Object.entries(d.P)) {
  const f = d.frames[i];
  const out = path.join(imgDir, `${base}-${pos}.jpg`);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', video, '-ss', String(f.vt ?? f.t), '-frames:v', '1', '-vf', 'scale=-2:640', '-q:v', '5', out]);
  d.images[pos] = path.relative(webDir, out);
}
if (credit) d.imageCredit = credit;
fs.writeFileSync(jsonPath, JSON.stringify(d));
console.log(`写入 ${Object.keys(d.images).length} 张截图`);
