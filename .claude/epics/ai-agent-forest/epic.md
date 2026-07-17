---
name: ai-agent-forest
status: in-progress
created: 2026-07-17T17:23:09Z
updated: 2026-07-17T17:23:09Z
progress: 0%
prd: .claude/prds/ai-agent-forest.md
github: https://github.com/EricPrometheus/Ant-Forest/issues/1
---

# Epic: ai-agent-forest

## Overview
在困鱼 AutoJS 内实现任务级 AI agent，替换死板的规则匹配。agent 主循环：混合感知（无障碍树+截图）→ 国产 VL 决策（结构化 JSON）→ 执行（click/swipe/调 main.js 子流程）→ 反馈。复用已验证的 main.js 收能量/逛一逛，新增 `lib/agent/` 四个核心组件。

## Architecture Decisions
1. **agent 跑在 AutoJS 内**（非 PC 端）——单端，复用 AutoJS 全部能力（无障碍/截图/click/main.js）。
2. **混合感知**——无障碍树给 VL"有什么元素+文本"（结构），截图给"在哪+状态"（视觉）。H5 bounds 0,0 时靠截图视觉补坐标。
3. **任务级自主**——VL 拆解高级任务为步骤，调度子流程或直接操作。不全自主（省 token），保留 main.js 已验证流程。
4. **国产 VL**——通义千问 VL / 智谱 GLM-4V（国内访问畅），用户备 key。
5. **结构化 JSON 决策**——VL 返回 `{action, params, reason}`，强制约束防幻觉。
6. **复用 main.js**——收能量/逛一逛通过 call_sub 调度，不重写。

## Technical Approach

### 核心组件（lib/agent/）
- `agent.js` — 主循环：`run(task) { while not finish: perceive → decide(vl) → execute → feedback }`
- `perception.js` — `perceive()` 返回 `{tree_summary, screenshot_path}`（无障碍 dump + screencap）
- `vl_client.js` — `decide(task, perception, history)` http POST VL API，返回 JSON 动作
- `executor.js` — `execute(action)` 派发 click/swipe/call_sub

### 复用层（main.js 子流程接口）
- 把 main.js 的"收自己能量"、"逛一逛"暴露为可调用函数（agent call_sub 入口）
- agent 通过 call_sub 调度，不重写这些已验证流程

### VL 决策协议
- 输入：任务描述 + 无障碍树摘要（text/resource-id 列表）+ 截图（base64）+ 历史动作
- 输出：`{action: click|swipe|call_sub|finish|wait, params: {x,y}|{dx,dy}|{sub}, reason: string}`
- system prompt：约束 VL 只返回 JSON + 蚂蚁森林领域知识（能量球/树/好友/找能量按钮等）

### 错误处理
- VL 超时：重试 3 次，降级无障碍树定位
- VL 幻觉（非法 JSON/坐标越界）：重试 + 校验
- 执行失败：反馈 VL 重决策
- 连续失败 5 次：退出 + 报错日志

## Implementation Strategy
分阶段（任务级验证）：
1. 基础设施（vl_client/perception/executor 骨架 + main.js 子流程接口）
2. 单任务端到端（"收自己能量"，VL 驱动）
3. 扩展（逛一逛转场、forest 集市新版自适应）
4. 错误处理 + 实测调优

## Task Breakdown Preview
- T1: `vl_client.js`（http 调国产 VL + JSON 解析）—— 基础，独立
- T2: `perception.js`（无障碍 dump + 截图 + 树摘要）—— 基础，独立
- T3: main.js 子流程接口（暴露收能量/逛一逛为 call_sub）—— 基础，独立
- T4: `executor.js`（click/swipe/call_sub 执行）—— 依赖 T1/T3
- T5: `agent.js` 主循环（感知→VL→执行→反馈）—— 依赖 T1-T4
- T6: 单任务端到端（收自己能量）+ 实测 —— 依赖 T5
- T7: 扩展（逛一逛/forest 集市自适应）+ 错误处理 —— 依赖 T6

**并行点**：T1/T2/T3 独立基础组件可并行；T4/T5 串行；T6/T7 实测调优。

## Dependencies
- 国产 VL API key（用户提供，通义/智谱）
- 困鱼 http.client 访问 VL API（国内直连，不走代理）
- main.js 子流程可暴露为函数

## Success Criteria (Technical)
- agent 主循环跑通（感知→VL→执行→反馈）
- VL 返回结构化 JSON（合法率 > 95%）
- 收自己能量端到端（VL 调度/操作 + 能量增加）
- 复用 main.js（call_sub 调收能量/逛一逛）
- 错误处理（超时/幻觉不卡死，降级或重试）

## Estimated Effort
- T1-T3（基础）：各 1-2 小时，可并行
- T4-T5（主循环）：2-3 小时
- T6-T7（实测+扩展）：3-5 小时（实测调优占大头）
- 总：~10-15 小时

## Tasks Created
- [ ] 001.md - vl_client.js 国产 VL 调用 (parallel: true)
- [ ] 002.md - perception.js 混合感知 (parallel: true)
- [ ] 003.md - main.js 子流程接口 call_sub (parallel: true)
- [ ] 004.md - executor.js 执行 VL 决策 (parallel: false, deps: 001/003)
- [ ] 005.md - agent.js 主循环 (parallel: false, deps: 001-004)
- [ ] 006.md - 收自己能量端到端实测 (parallel: false, deps: 005)
- [ ] 007.md - 扩展逛一逛/forest 集市 + 错误处理 (parallel: false, deps: 006)

Total tasks: 7
Parallel tasks: 3 (001/002/003 独立基础组件)
Sequential tasks: 4 (004→005→006→007)
Estimated total effort: ~15 hours
