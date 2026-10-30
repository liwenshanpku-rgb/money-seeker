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

// 截取视频当前帧。iPhone Safari 用 2D 画布 drawImage 截视频时，有时只得到黑帧（尤其是 HDR 视频），
// 而 WebGL 上传纹理（姿态识别用的也是这条路）能拿到正确画面，所以优先走 WebGL，失败或全黑再换 2D。
function frameGrabber(width, height) {
  const out = document.createElement('canvas');
  out.width = width; out.height = height;
  const ctx2d = out.getContext('2d', { willReadFrequently: true });
  let gl = null, glCanvas = null;
  try {
    glCanvas = document.createElement('canvas');
    glCanvas.width = width; glCanvas.height = height;
    gl = glCanvas.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (gl) {
      const sh = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); return x; };
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, 'attribute vec2 p;varying vec2 uv;void main(){uv=vec2((p.x+1.)/2.,(1.-p.y)/2.);gl_Position=vec4(p,0.,1.);}'));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, 'precision mediump float;varying vec2 uv;uniform sampler2D t;void main(){gl_FragColor=texture2D(t,uv);}'));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link');
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
      for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      gl.viewport(0, 0, width, height);
    }
  } catch { gl = null; }

  // 抽样检查是否几乎全黑
  const isBlack = () => {
    const d = ctx2d.getImageData(0, 0, width, height).data;
    const step = Math.max(4, Math.floor(d.length / 4 / 400)) * 4;
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += step) { sum += d[i] + d[i + 1] + d[i + 2]; n++; }
    return sum / (n * 3) < 6;
  };
  const viaGL = (video) => {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    ctx2d.drawImage(glCanvas, 0, 0);
  };
  const via2D = (video) => ctx2d.drawImage(video, 0, 0, width, height);
  let order = gl ? [viaGL, via2D] : [via2D];

  return async (video) => {
    for (const grab of order) {
      try {
        ctx2d.clearRect(0, 0, width, height);
        grab(video);
        if (!isBlack()) {
          if (grab !== order[0]) order = [grab, ...order.filter((g) => g !== grab)]; // 记住有效的方式
          break;
        }
      } catch { /* 换下一种方式 */ }
    }
    return new Promise((r) => out.toBlob(r, 'image/jpeg', 0.82));
  };
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
  const k = Math.min(1, SNAP_HEIGHT / video.videoHeight);
  const grab = frameGrabber(Math.round(video.videoWidth * k), Math.round(video.videoHeight * k));
  let ts = (performance.now() | 0) + 1;
  for (let i = 0; i <= total; i++) {
    const t = Math.min(stop, start + i / fps);
    await seek(video, t);
    ts += Math.round(1000 / fps); // detectForVideo 要求时间戳严格递增
    const res = pl.detectForVideo(video, ts);
    const raw = res.landmarks?.[0];
    const img = await grab(video);
    const world = res.worldLandmarks?.[0];
    frames.push({
      t, img,
      lm: raw ? raw.map((p) => ({ x: p.x * aspect, y: p.y, v: p.visibility ?? 1 })) : null,
      // 3D 世界坐标（米，以髋部中点为原点），用来算髋、肩的转动
      wl: raw && world ? world.map((p, j) => ({ x: p.x, y: p.y, z: p.z, v: raw[j].visibility ?? 1 })) : null,
    });
    onProgress?.((i + 1) / (total + 1));
  }
  return { frames, aspect };
}

// 没检测到人的帧用相邻帧填补（全部可见度设为 0，让平滑时插值）
export function fillMissing(frames) {
  const firstGood = frames.find((f) => f.lm);
  if (!firstGood) throw new Error('视频中没有检测到人体，请确认整个身体都在画面内');
  let last = firstGood.lm, lastW = firstGood.wl;
  const missing = frames.filter((f) => !f.lm).length;
  const out = frames.map((f) => {
    if (f.lm) { last = f.lm; lastW = f.wl || lastW; return f; }
    return { ...f, lm: last.map((p) => ({ ...p, v: 0 })), wl: lastW ? lastW.map((p) => ({ ...p, v: 0 })) : null };
  });
  return { frames: out, missingRatio: missing / frames.length };
}
