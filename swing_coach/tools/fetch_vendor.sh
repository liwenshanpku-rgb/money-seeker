#!/usr/bin/env bash
# 把 MediaPipe 识别程序和模型下载到 web/vendor/mediapipe/，和网页一起发布。
# 这样网页不用再去 jsDelivr / Google 下载（国内访问不了 Google），也不依赖第三方 CDN。
# 发布流程（Pages / 服务器）里自动运行；本地调试时手动运行一次即可。文件较大，不提交到仓库。
set -euo pipefail
VERSION=0.10.14
dir="$(cd "$(dirname "$0")/.." && pwd)/web/vendor/mediapipe"
mkdir -p "$dir/wasm"
npm="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}"
models="https://storage.googleapis.com/mediapipe-models/pose_landmarker"
get() { [ -s "$2" ] || curl -fsSL --retry 3 -o "$2" "$1"; }
get "$npm/vision_bundle.mjs" "$dir/vision_bundle.mjs"
for f in vision_wasm_internal.js vision_wasm_internal.wasm vision_wasm_nosimd_internal.js vision_wasm_nosimd_internal.wasm; do
  get "$npm/wasm/$f" "$dir/wasm/$f"
done
for m in full heavy; do
  get "$models/pose_landmarker_${m}/float16/1/pose_landmarker_${m}.task" "$dir/pose_landmarker_${m}.task"
done
# 去掉 source map 引用，避免浏览器去请求不存在的 .map 文件
sed -i.bak '/sourceMappingURL/d' "$dir/vision_bundle.mjs" && rm -f "$dir/vision_bundle.mjs.bak"
du -sh "$dir"
