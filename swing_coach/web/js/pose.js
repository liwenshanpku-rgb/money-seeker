// 浏览器端姿态识别：MediaPipe Pose Landmarker 逐帧提取 33 个关键点。视频不会上传到服务器。

const VISION_VERSION = '0.10.14';
const VISION_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/vision_bundle.mjs`;
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/wasm`;
const MODELS = {
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  heavy: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task',
};

const cache = {};
const SNAP_HEIGHT = 720;

async function landmarker(model) {
  if (cache[model]) return cache[model];
  const { FilesetResolver, PoseLandmarker } = await import(VISION_URL);
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODELS[model], delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    cache[model] = await PoseLandmarker.createFromOptions(fileset, opts('GPU'));
  } catch {
    cache[model] = await PoseLandmarker.createFromOptions(fileset, opts('CPU'));
  }
  return cache[model];
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function once(el, events, ms) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); events.forEach((e) => el.removeEventListener(e, done)); resolve(); };
    const timer = setTimeout(done, ms);
    events.forEach((e) => el.addEventListener(e, done));
  });
}

// iPhone Safari 在视频播放过之前不会解码画面，直接跳帧会得到黑屏或卡住。
// 需在用户点击的同一事件里调用（不能先 await 别的东西），播一下再暂停，让浏览器把视频数据加载进来。
export function primeVideo(video) {
  video.muted = true;
  video.playsInline = true;
  const p = video.play();
  return Promise.resolve(p).then(() => video.pause()).catch(() => {});
}

export async function ensureReady(video) {
  if (video.readyState < 1) await once(video, ['loadedmetadata', 'error'], 8000);
  if (video.readyState < 2) await once(video, ['loadeddata', 'canplay', 'error'], 8000);
  if (video.readyState < 2) throw new Error('视频无法解码。iPhone 拍的 HEVC 视频在部分安卓或电脑浏览器上无法播放，请在拍摄设置里改用「兼容性最佳」（H.264）后重拍或转码');
}

// 跳到时间 t 并等这一帧真正解码出来。目标时间和当前时间相同时浏览器不会触发 seeked，需单独处理；
// 再加超时兜底，防止个别浏览器不触发事件导致卡死。
export async function seek(video, t) {
  if (Math.abs(video.currentTime - t) > 1e-4) {
    const done = once(video, ['seeked'], 3000);
    video.currentTime = t;
    await done;
  }
  if (video.readyState < 2) await once(video, ['loadeddata', 'canplay'], 1500);
  if ('requestVideoFrameCallback' in video && video.paused) {
    // Safari / Chrome 暂停状态下跳帧后会回调一次；没有回调也最多等 80ms
    await Promise.race([new Promise((r) => video.requestVideoFrameCallback(() => r())), wait(80)]);
  }
}

// 视频时长：MediaRecorder 等录出的文件 duration 可能是 Infinity
export function videoDuration(video, fallback = 15) {
  return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : fallback;
}

// 逐帧提取关键点。返回 [{t, lm: [{x, y, v}]}]，x 已乘宽高比（单位 = 视频高度）
export async function extractPoses(video, { fps = 30, start = 0, end, model = 'full', onProgress } = {}) {
  await ensureReady(video);
  const pl = await landmarker(model);
  const aspect = video.videoWidth / video.videoHeight;
  const stop = Math.min(end ?? videoDuration(video), videoDuration(video));
  const frames = [];
  const total = Math.max(1, Math.floor((stop - start) * fps));
  // 识别的同时把这一帧画面压缩存下来，之后画关键帧直接用它，保证画面和骨架是同一帧
  // （iPhone 上事后再跳转视频，常常画面还没解码就被截图，背景会停在旧画面）
  const snap = document.createElement('canvas');
  const k = Math.min(1, SNAP_HEIGHT / video.videoHeight);
  snap.width = Math.round(video.videoWidth * k);
  snap.height = Math.round(video.videoHeight * k);
  const sctx = snap.getContext('2d');
  let ts = (performance.now() | 0) + 1;
  for (let i = 0; i <= total; i++) {
    const t = Math.min(stop, start + i / fps);
    await seek(video, t);
    ts += Math.round(1000 / fps); // detectForVideo 要求时间戳严格递增
    const res = pl.detectForVideo(video, ts);
    const raw = res.landmarks?.[0];
    sctx.drawImage(video, 0, 0, snap.width, snap.height);
    const img = await new Promise((r) => snap.toBlob(r, 'image/jpeg', 0.82));
    frames.push({ t, img, lm: raw ? raw.map((p) => ({ x: p.x * aspect, y: p.y, v: p.visibility ?? 1 })) : null });
    onProgress?.((i + 1) / (total + 1));
  }
  return { frames, aspect };
}

// 没检测到人的帧用相邻帧填补（全部可见度设为 0，让平滑时插值）
export function fillMissing(frames) {
  const firstGood = frames.find((f) => f.lm);
  if (!firstGood) throw new Error('视频中没有检测到人体，请确认整个身体都在画面内');
  let last = firstGood.lm;
  const missing = frames.filter((f) => !f.lm).length;
  const out = frames.map((f) => {
    if (f.lm) { last = f.lm; return f; }
    return { ...f, lm: last.map((p) => ({ ...p, v: 0 })) };
  });
  return { frames: out, missingRatio: missing / frames.length };
}
