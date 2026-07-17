---
name: ai-agent-forest
description: 把蚂蚁森林 AutoJS 脚本从死板规则改造成 AI agent（国产VL 决策+混合感知+复用 main.js），自适应新 UI
status: backlog
created: 2026-07-17T17:23:09Z
---

# PRD: ai-agent-forest

## Executive Summary
把现有蚂蚁森林自动化脚本（AutoJS 无障碍+OpenCV 图像识别，硬编码坐标/文本/图像）改造成 AI agent 方式：在困鱼 AutoJS 内跑 agent 主循环，用国产视觉大模型（VL）理解界面+决策，混合感知（无障碍树+截图），任务级自主（LLM 拆任务→调度子流程/操作），复用已验证的 main.js 收能量/逛一逛子流程。解决"UI 变就坏"的根本问题。

## Problem Statement
当前脚本依赖固定坐标/文本/图像匹配，支付宝改 UI/活动就失效：
- forest 集市：新版从"浏览商品15s"变成"点击商品N次"，browseAds 逻辑失效（决定10）
- 森林寻宝：活动下线/整合，深链进不去寻宝界面（决定10）
- 能量球区域：陈旧 autoDetect 配置 + 右下角按钮误检，手动调试多轮（决定2/4）

根本原因：脚本是"规则匹配"，UI 一变就废。需要"理解+决策"的自适应能力（AI agent）。

## User Stories
1. **作为脚本使用者**，我希望脚本在新版蚂蚁森林界面自适应工作（不因 UI 变就坏），不用每次手动调试坐标/文本。
   - 验收：新版 forest 集市（点击商品）能识别+操作；好友页转场（滑动）能识别+操作。
2. **作为脚本使用者**，我希望 agent 完成核心功能（收自己能量、逛一逛收好友），复用已验证逻辑（167g）。
   - 验收：agent 驱动收自己能量端到端跑通；逛一逛转场+收好友通。
3. **作为脚本维护者**，我希望新 UI/活动变更时 agent 自适应（不用改代码），最多调 VL prompt。
   - 验收：换分辨率/活动改版，agent 仍能工作（VL 理解新界面）。

## Functional Requirements
1. **agent 主循环**（`lib/agent/agent.js`）：感知 → VL 决策 → 执行 → 反馈，循环到任务完成。
2. **混合感知**（`lib/agent/perception.js`）：uiautomator dump 无障碍树（text/resource-id 结构）+ screencap 截图（视觉/坐标），合并喂 VL。
3. **VL 决策**（`lib/agent/vl_client.js`）：http 调国产 VL（通义千问 VL / 智谱 GLM-4V），传截图+树摘要+任务+历史，返回结构化 JSON 动作。
4. **执行器**（`lib/agent/executor.js`）：执行 VL 决策——AutoJS click/swipe（坐标）、或调度 main.js 子流程（收能量/逛一逛）。
5. **VL 决策格式**（结构化 JSON 防幻觉）：`{action: click|swipe|call_sub|finish|wait, params: {x,y}|{sub}, reason: "..."}`
6. **复用 main.js 子流程**：收自己能量、逛一逛（BaseScanner/StrollScanner，已验证 167g），agent 调度它们，不重写。
7. **任务级入口**：agent 接收高级任务（"收能量"/"逛一逛"/"森林集市"），VL 拆解为步骤。
8. **错误处理**：VL 超时/幻觉→重试+降级（无障碍树定位）；执行失败→反馈 VL 重决策；连续失败 N 次→退出报错。

## Non-Functional Requirements
- **环境**：MuMu 模拟器 Android 12（1440×2560）、困鱼 AutoJS（免费版，无 onnxruntime/YOLO）、支付宝小号已登录。
- **LLM**：国产 VL API（通义千问 VL / 智谱 GLM-4V），国内访问畅；用户提供 API key。
- **响应**：VL 决策单步 < 10 秒。
- **成本**：复用 main.js 子流程省 VL 调用（重复操作不走 VL），仅新 UI/异常/任务拆解调 VL。
- **可维护**：agent 逻辑集中在 `lib/agent/`，VL prompt 模板可独立调整。
- **不依赖**：YOLO/onnxruntime（困鱼不支持）、Shizuku（MuMu 无 root）、PC 端常驻（agent 在 AutoJS 内单端跑）。

## Success Criteria
1. agent 驱动"收自己能量"任务端到端跑通（VL 拆解+调度/操作+收取成功，能量增加）。
2. agent 自适应新版 UI（不依赖硬编码坐标/文本）——在 forest 集市新版或好友页转场上，agent 不改代码能识别+操作。
3. 复用 main.js 子流程（收能量/逛一逛通过 call_sub 调用，不重写）。
4. 单任务 VL 调用次数合理（收自己能量 < 10 次 VL 调用）。
5. 错误处理有效（VL 幻觉/超时不卡死，降级或重试）。

## Constraints & Assumptions
- 困鱼免费版无 YOLO（决定9）——agent 不依赖 YOLO，纯 VL+无障碍+坐标。
- 国产 VL API key 用户自备（通义/智谱）。
- MuMu 1440×2560 分辨率（坐标基于此）。
- main.js 子流程接口可被 agent 调用（需暴露函数/命令入口）。
- 假设：国产 VL 视觉理解能力足够识别蚂蚁森林界面元素（需实测验证）。

## Out of Scope
- YOLO 依赖功能（神奇海洋领奖励等——决定9 Pro 上限）。
- 多账号切换（配置依赖，用户提供账号才做）。
- Shizuku 集成（MuMu 无 root，决定8）。
- 重写 main.js 核心逻辑（复用，不重写）。
- 拼手速（纯手动触发，决定11）。
- PC 端 agent（架构选 AutoJS 内）。

## Dependencies
- 国产 VL API（通义千问 VL / 智谱 GLM-4V）+ key
- 困鱼 AutoJS（http.client 调 VL API）
- 现有 main.js + core/BaseScanner + StrollScanner（复用子流程）
- uiautomator dump + screencap（混合感知，已验证可用）
