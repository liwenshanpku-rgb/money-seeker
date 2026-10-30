# 挥杆教练：P1–P10 高尔夫挥杆分析

上传正面和 / 或侧面的挥杆视频（两个角度一起上传结果最完整，只有一个角度也能分析），网页会自动识别 P1–P10 十个关键位置，逐项对比职业挥杆模板，指出问题，并给出改进方法和练习。可以选用 Claude 生成教练式点评。

## 功能

- **浏览器本地姿态识别**：用 MediaPipe Pose 逐帧提取 33 个人体关键点，视频不离开本机。
- **自动定位 P1–P10**：根据手速峰值和双手最低点定 P7（击球），根据双手最高点定 P4（顶点），根据前后的静止段定 P1 和 P10；中间几个位置用特征越过阈值的时刻来定，阈值取自职业模板。自动识别不准时，可以拖动时间轴手动校正。
- **职业模板对比**：参数化的 3D 职业挥杆模型，按 P1–P10 的典型职业参数摆姿势，再按你的身高和站位对齐，叠加在每张关键帧上（绿色虚线）。
- **对比职业球员**：结果页下拉选择职业球员。有骨架数据的球员（目前是 Adam Scott）会在每个 P 位置和你左右并排显示（他的骨架为绿色），检查表多一列他的数值；其他球员暂时只能看嵌入的 YouTube 视频。
  - 骨架数据放在 `web/pros/*.json`，只有关键点坐标和 P1–P10 帧号，不含任何画面。用 `node swing_coach/tools/extract_pro.mjs <视频> web/pros/<id>-<fo|dtl>.json --view fo|dtl --name "名字"` 从挥杆视频生成，核对 P1–P10 后在 `web/js/pros.js` 里加上 `data` 即可。
  - 单机位视频估算的髋、肩转动角度（以及正面上杆顶点的前臂角度）误差较大：用职业球员本人的数据检验，这几项明显偏小。因此它们只作「参考」，不按绝对区间打分；选了有骨架数据的球员时，改为和他用同一方法测出的数值对比（差 15° 以内算接近）。
- **四十多项检查**：
  - 正面（face-on）：站位宽度、脊柱侧倾、手位、骨盆侧移（sway）、头部稳定、肩部和髋部转动、反向脊柱角、重心转移、下杆转髋与「髋先肩后」顺序、击球时手领先、前腿支撑、送杆伸展、收杆平衡。
  - 侧面（down-the-line）：脊柱前倾、膝盖弯曲、手臂下垂、上杆髋 / 肩转动、脊柱角保持、头部高度、下杆转髋与「髋先肩后」顺序、提前伸展（early extension）。
  - 两种视角都有：节奏（上杆和下杆用时之比，职业约 3 : 1）。

  每项都给出职业区间、问题诊断、改进要领和具体练习，并自动列出最需要改进的 3 点。
- **分享给朋友**：一键生成结果卡片（综合评分、节奏、P1–P10 拼图、最需要改进的地方），通过手机分享面板发微信，或保存到相册。
- **AI 教练点评（可选，都不走 API 计费）**，生成总体评价、逐位置点评、优先改进点和两周练习计划：
  - **方式一：发给 Claude App**（免费，无需设置）：网页生成一张 P1–P10 拼图和一段点评请求文字，通过手机分享面板发到 Claude App，粘贴后发送。用的是 Claude App 里正常聊天的额度。
  - **方式二：自动点评**：网页把关键帧和测量数据推到仓库的 `swing-coach` 分支，由 GitHub Actions 里的 Claude Code（订阅额度）写出点评，网页自动取回显示。需要配置两个 token。

## 部署与使用

### 1. 发布网页（GitHub Pages）

1. 把本分支合并到 `main`。
2. 仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
3. `.github/workflows/pages.yml` 会把 `swing_coach/web/` 发布到 `https://<用户名>.github.io/<仓库名>/`，之后每次改动网页都会自动更新。

手机浏览器打开这个地址即可上传视频分析。姿态识别和全部规则分析都在手机浏览器里完成，视频不会上传。

### 2. 开启自动点评（方式二，可选，只需一次）

方式一「发给 Claude App」不需要任何设置。下面只针对方式二。

1. 在装了 Claude Code 的电脑上运行 `claude setup-token`，把生成的 token 添加到仓库 **Settings → Secrets and variables → Actions**，名称为 `CLAUDE_CODE_OAUTH_TOKEN`。这样使用的是你 Claude 订阅里的额度。
2. 在 GitHub **Settings → Developer settings → Fine-grained tokens** 新建一个 token：只选这个仓库，权限 **Contents** 选 **Read and write**。在网页的「GitHub 设置」里填入。这个 token 只保存在该设备的浏览器里。
3. 分析完成后点「生成 AI 点评」，通常 2–5 分钟出结果。可以先关掉页面，稍后回来点「查看上次点评」。

流程：网页把请求写到 `swing-coach` 分支的 `requests/<编号>.json`，并触发 `.github/workflows/swing-coach.yml`。工作流运行 `swing_coach/coach_task.py` 解出图片、生成任务说明，再用 `claude -p` 查看关键帧并写出点评。结果存到 `reviews/<编号>.md`。

隐私：仓库是公开的，所以默认只上传骨架图，不含视频画面。勾选「上传真实视频画面」后，画面在处理的几分钟内对外可见。每次处理完，工作流会删除已完成的请求，并把 `swing-coach` 分支压成单个提交强制推送，图片不会留在分支历史里。

### 本地运行

```bash
cd swing_coach/web && python -m http.server 8000   # 打开 http://localhost:8000
```

## 拍摄建议

- 正面：相机正对胸口，高度约在腰部。侧面：相机在球员身后的目标线延长线上，对准双手。
- 用三脚架固定相机，全身入镜，一段视频只包含一次挥杆。最好用 60fps 以上或慢动作拍摄。
- 测量来自单机位 2D 视频，有透视误差，请关注明显偏差和变化趋势。

## 代码结构

```
web/index.html, style.css
web/js/geometry.js   关键点索引与 2D 几何
web/js/template.js   参数化 3D 职业模板、投影、合成挥杆（演示和测试用）
web/js/phases.js     平滑、拍摄角度识别、P1–P10 检测
web/js/metrics.js    检查项定义、职业区间、诊断与练习、评分
web/js/pose.js       MediaPipe 逐帧提取
web/js/render.js     关键帧、模板叠加、手部轨迹、时间轴
web/js/pros.js       职业球员列表（YouTube 视频编号、骨架数据路径）
web/pros/            职业球员骨架数据（只有关键点坐标）
tools/extract_pro.mjs 从职业球员视频提取骨架数据
web/js/app.js        页面逻辑
web/js/share.js      方式一：拼图、点评请求文字、分享
web/js/github.js     方式二：推送 AI 点评请求、取回结果
web/coach-prompt.md  教练提示词（两种方式共用）
coach_task.py        Actions 中把请求整理成 Claude Code 任务
tests/               node --test 单元测试（用合成挥杆验证相位检测和指标）
```

## 测试

```bash
node --test swing_coach/tests/*.test.mjs
python -m pytest tests/test_swing_coach_task.py
```
