// 浏览器端姿态识别：MediaPipe Pose Landmarker 逐帧提取 33 个关键点。视频不会上传到服务器。

const VISION_VERSION = '0.10.14';
const VISION_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/vision_bundle.mjs`;
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/wasm`;
const MODELS = {
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  heavy: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task',
};

const cache = {};

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

export function seek(video, t) {
  return new Promise((resolve) => {
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

// 逐帧提取关键点。返回 [{t, lm: [{x, y, v}]}]，x 已乘宽高比（单位 = 视频高度）
export async function extractPoses(video, { fps = 30, start = 0, end, model = 'full', onProgress } = {}) {
  const pl = await landmarker(model);
  const aspect = video.videoWidth / video.videoHeight;
  const stop = Math.min(end ?? video.duration, video.duration);
  const frames = [];
  const total = Math.max(1, Math.floor((stop - start) * fps));
  let ts = (performance.now() | 0) + 1;
  for (let i = 0; i <= total; i++) {
    const t = Math.min(stop, start + i / fps);
    await seek(video, t);
    ts += Math.round(1000 / fps); // detectForVideo 要求时间戳严格递增
    const res = pl.detectForVideo(video, ts);
    const raw = res.landmarks?.[0];
    if (raw) {
      frames.push({ t, lm: raw.map((p) => ({ x: p.x * aspect, y: p.y, v: p.visibility ?? 1 })) });
    } else {
      frames.push({ t, lm: null });
    }
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
    return { t: f.t, lm: last.map((p) => ({ ...p, v: 0 })) };
  });
  return { frames: out, missingRatio: missing / frames.length };
}
