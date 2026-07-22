# Tent Agent Rules

## 主 Agent 与 SubGrok

- 主 Agent 负责理解 user 意图、做产品与架构判断、守住边界、拆分任务、验收结果并完成最终整合。
- 凡是不要求主 Agent 亲自完成的繁重工作，默认优先交给 SubGrok，不要等 user 再次提醒。
- 应优先委派的工作包括：大范围代码实现、重复性修改、仓库调查、批量检索、长时间测试、代码审计、跨模块对照和资料整理。
- 可以并行且写入范围互不冲突时，并发派遣多个 SubGrok；不要让主 Agent 重复执行已经委派的同一工作。
- 主 Agent 仍需检查 SubGrok 的证据、改动和测试结果。委派不等于盲目接受，也不把产品决策或不可逆操作交给 SubGrok 自行决定。
- 立即阻塞当前关键路径、需要结合完整 user 上下文判断，或规模很小的工作，由主 Agent 直接处理即可。
- 所有 SubGrok ACP 调用都必须由 Tent 发起和管理，不得直接调用 provider adapter、ACP wrapper 或 `invoke-grok-acp.mjs` 绕过 Tent core。
- 长期协作绑定 Tent task/role/agent profile；临时调查使用 Tent 管理的临时 task/session，可以不认领长期 role，但仍需保留统一的运行状态、上下文与交付链路。

目标是节省主 Agent 的 token 与上下文，把它留给真正需要连续判断、与 user 对齐和最终验收的工作。
