// 职业球员对比视频：只保存 YouTube 视频编号，用官方播放器嵌入播放（视频不经过本站，版权归原作者）。
// 加人：往列表里加一项即可。fo = 正面（face-on），dtl = 侧面（down-the-line）。
export const PROS = [
  {
    id: 'adam-scott', name: 'Adam Scott', tour: 'PGA 巡回赛',
    note: '公认最优美的挥杆之一：上杆宽、顶点稳定，下杆顺序非常清楚。',
    fo: 'y-unlrE7gd8', dtl: 'p7we9OPqT10',
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
