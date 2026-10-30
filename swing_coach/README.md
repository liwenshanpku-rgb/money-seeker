# 挥杆教练：P1–P10 高尔夫挥杆分析

上传一段挥杆视频，网页会自动识别 P1–P10 十个关键位置，逐项对比职业挥杆模板，指出问题，并给出改进方法和练习。可以选用 Claude 生成教练式点评。

## 功能

- **浏览器本地姿态识别**：用 MediaPipe Pose 逐帧提取 33 个人体关键点，视频不离开本机。
- **自动定位 P1–P10**：根据手速峰值和双手最低点定 P7（击球），根据双手最高点定 P4（顶点），根据前后的静止段定 P1 和 P10；中间几个位置用特征越过阈值的时刻来定，阈值取自职业模板。自动识别不准时，可以拖动时间轴手动校正。
- **职业模板对比**：参数化的 3D 职业挥杆模型，按 P1–P10 的典型职业参数摆姿势，再按你的身高和站位对齐，叠加在每张关键帧上（绿色虚线）。也可以上传一段职业球员视频，与你的动作并排对比。
- **约 35 项检查**：
  - 正面（face-on）：站位宽度、脊柱侧倾、手位、骨盆侧移（sway）、头部稳定、肩部和髋部转动、反向脊柱角、重心转移、击球时手领先、前腿支撑、送杆伸展、收杆平衡。
  - 侧面（down-the-line）：脊柱前倾、膝盖弯曲、手臂下垂、脊柱角保持、头部高度、提前伸展（early extension）。
  - 两种视角都有：节奏（上杆和下杆用时之比，职业约 3 : 1）。

  每项都给出职业区间、问题诊断、改进要领和具体练习，并自动列出最需要改进的 3 点。
- **AI 教练点评（可选）**：把 10 张关键帧和测量数据发给 Claude，生成总体评价、逐位置点评、优先改进点和两周练习计划。

## 使用

纯静态页面，只用规则分析，不需要后端：

```bash
cd swing_coach/web && python -m http.server 8000
```

需要 AI 点评时，改用自带的服务（同时提供静态页面和 `/api/coach` 接口）：

```bash
pip install -r swing_coach/requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
python swing_coach/server.py   # 打开 http://localhost:8000
```

可以用环境变量 `SWING_COACH_MODEL` 改模型（默认 `claude-opus-5-5`）。

`web/` 目录可以直接部署到 GitHub Pages 或任何静态托管。部署到公网时，`server.py` 应放在有访问控制的反向代理后面，避免 API 额度被他人消耗。

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
web/js/app.js        页面逻辑
server.py            静态服务 + Claude 教练接口
tests/               node --test 单元测试（用合成挥杆验证相位检测和指标）
```

## 测试

```bash
node --test swing_coach/tests/*.test.mjs
python -m pytest tests/test_swing_coach_server.py
```
