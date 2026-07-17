# GitHub Issue Mapping
Epic: #1 - https://github.com/EricPrometheus/Ant-Forest/issues/1
Tasks:
- #2: vl_client.js 国产 VL 调用 (parallel: true)
- #3: perception.js 混合感知 (parallel: true)
- #4: main.js 子流程接口 call_sub (parallel: true)
- #5: executor.js 执行 VL 决策 (deps: #2/#4)
- #6: agent.js 主循环 (deps: #2/#3/#4/#5)
- #7: 收自己能量端到端实测 (deps: #6)
- #8: 扩展逛一逛/forest 集市 + 错误处理 (deps: #7)

Synced: 2026-07-17T17:23:09Z
Repo: EricPrometheus/Ant-Forest (fork of TonyJiangWJ/Ant-Forest)
