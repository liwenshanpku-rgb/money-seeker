// 职业球员对比视频：只保存 YouTube 视频编号，用官方播放器嵌入播放（视频不经过本站，版权归原作者）。
// 加人：往列表里加一项即可。fo = 正面（face-on），dtl = 侧面（down-the-line）。
// data：可选，有骨架数据时可以和用户逐个 P 位置左右对比、逐项比数值。
export const PROS = [
  {
    id: 'adam-scott', name: 'Adam Scott', tour: 'PGA 巡回赛',
    note: '公认最优美的挥杆之一：上杆宽、顶点稳定，下杆顺序非常清楚。',
    fo: 'y-unlrE7gd8', dtl: 'p7we9OPqT10',
    // 骨架数据（只有关键点坐标，不含画面），由 tools/extract_pro.mjs 从挥杆视频中提取
    data: { fo: 'pros/adam-scott-fo.json', dtl: 'pros/adam-scott-dtl.json' },
  },
  {
    id: 'tommy-fleetwood', name: 'Tommy Fleetwood', tour: 'PGA / DP World 巡回赛',
    note: '节奏流畅，击球时双手领先、杆面控制稳定，铁杆击球扎实。',
    fo: 'OYnl_r0z498', dtl: 'OQm9jWyTFxA',
  },
  {
    id: 'nelly-korda', name: 'Nelly Korda', tour: 'LPGA',
    note: '准备姿势扎实，下杆先向前移再转髋，收杆平衡。',
    fo: 'JXvjacjuR2s', dtl: 'Gtb1kiQ1mFo',
  },
  {
    id: 'jeeno-thitikul', name: 'Jeeno Thitikul', tour: 'LPGA',
    note: '身材不高但非常高效：上杆紧凑，下半身带动转髋，力量来自地面。',
    fo: 'S-ZIus0Tt7U', dtl: 'gAvftC79qzM',
  },
];

export function embedURL(videoId) {
  return `https://www.youtube-nocookie.com/embed/${videoId}?rel=0&playsinline=1&modestbranding=1`;
}

const cache = new Map();

// 读取职业球员某个角度的骨架数据，补全成 33 个关键点的逐帧数组
export async function loadProFrames(url) {
  if (!cache.has(url)) {
    cache.set(url, fetch(url).then((r) => {
      if (!r.ok) throw new Error(`读取职业球员数据失败：${url}`);
      return r.json();
    }).then((d) => {
      const expand = (pts, withZ) => {
        const out = new Array(33);
        d.keep.forEach((k, j) => { const p = pts[j]; out[k] = withZ ? { x: p[0], y: p[1], z: p[2], v: 1 } : { x: p[0], y: p[1], v: p[2] }; });
        for (let k = 0; k < 33; k++) if (!out[k]) out[k] = { ...out[0] };
        return out;
      };
      return {
        ...d,
        frames: d.frames.map((f) => ({ t: f.t, lm: expand(f.lm, false), wl: f.wl ? expand(f.wl, true) : null })),
      };
    }));
  }
  return cache.get(url);
}
