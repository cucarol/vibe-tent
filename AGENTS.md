# Tent Agent Rules

## 主 Agent 与 SubGrok

- 主 Agent 既是决策者也是执行者：负责理解 user 意图、做产品与架构判断、守住边界，也可以亲自完成与当前上下文紧密相关的实现、验证和收尾。
- 不要单纯为了节省 token 或 usage 机械委派。应比较实现规模、上下文交接成本、连续判断需求和并行收益，再决定由主 Agent 直接完成还是交给 SubGrok。
- 中小型、边界集中、立即阻塞关键路径、需要频繁结合 user 上下文判断，或交接成本高于实现成本的工作，优先由主 Agent 直接完成。
- 大范围代码实现、重复性修改、仓库调查、批量检索、长时间测试、独立代码审计、跨模块对照和资料整理等繁重工作，仍默认优先交给 SubGrok。
- 可以并行且写入范围互不冲突时，并发派遣多个 SubGrok；不要让主 Agent 重复执行已经委派的同一工作。
- 主 Agent 仍需检查 SubGrok 的证据、改动和测试结果。委派不等于盲目接受，也不把产品决策或不可逆操作交给 SubGrok 自行决定。
- SubGrok 结果存在缺口时，主 Agent 可以直接做窄修、补测和整合，不必为很小的剩余工作再次制造 Task 与交接。
- 所有 SubGrok ACP 调用都必须由 Tent 发起和管理，不得直接调用 provider adapter、ACP wrapper 或 `invoke-grok-acp.mjs` 绕过 Tent core。
- 长期协作绑定 Tent task/role/agent profile；临时调查使用 Tent 管理的临时 task/session，可以不认领长期 role，但仍需保留统一的运行状态、上下文与交付链路。

目标是在保持主 Agent 连续判断与执行能力的同时，把真正繁重、可独立和可并行的工作交给 SubGrok，减少等待、重复劳动与无意义的沟通摩擦。

## Project Conventions

- Use Conventional Commits: `feat|fix|chore|ci|test|refactor(scope): description`.
- Durable Role branches use `tent-role/<role>`. Release tags exactly match `manifest.json.version` and do not use a `v` prefix.
- Put rule and authority semantics in `src/core/` and `docs/SPEC.md`; keep CLI and plugin layers thin.
- `.tent/` is local collaboration state and must not be committed to the product repository.
- Ask cuca before changing unresolved product or architecture decisions.
