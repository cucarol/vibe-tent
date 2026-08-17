# Vibe Tent / 帷幄

> *vibe 于帷幄之中*

Vibe Tent 是跨 Harness 的上下文控制平面：Node 保存长期事实，Role 承担责任，Task 把选定 Node 与 prompt 冻结为同一份 Task Package，TaskResult 保存正式结果。Codex、Claude、Pi 或其他 Harness 都可消费这份输入；Session 只连接宿主执行，Agent Connection 只在需要 Tent 代为启动 ACP 时提供机器配置。Desktop 与 CLI 连接同一个 Local Service；真实代码、文档和 Git 历史仍留在项目 workspace。

<img width="1572" height="1076" alt="Vibe Tent demo" src="https://github.com/user-attachments/assets/2989b6ff-e249-435e-913e-c0267c05ffdf" />

## 快速开始

环境：Node.js 20+、Git。

把下面这段发给你的 coding agent 即可安装：

```text
Install Vibe Tent CLI, Desktop, and Skills for me (github.com/cucarol/vibe-tent):
1. Clone the repo and run `npm ci && npm run build && npm run build:desktop`.
2. Run `npm link`, then `tent skill-install` to sync the bundled Skills.
3. Verify `tent --help`; launch Desktop with `npm run desktop:start` when I ask.
Use only the CLI, Desktop, and bundled Skill installation paths above.
```

已有项目先使用 `tent-init` 提议初始 Node / Role 结构，并在你确认后物化。日常工作由 `tent-role` 保持 Role 连续性，由 `tent-task` 执行具体 Task。

## 当前模型

- **Node**：带稳定 `cx-` id 的 Markdown 事实与上下文；只有一个可选 `type` 标记。
- **Role**：跨 Session 持续对用户负责的主体。
- **Task**：一次工作与审阅单位，记录 prompt、有序且去重的 `nodeIds[]` roots（可为空）、requester 和 `currentResultId`，并导出确定性的 Task Package。
- **TaskResult**：Task 的不可变提交内容；每次正式提交生成新的 `rs-` 记录，review 针对 exact `resultId`。
- **Session**：可选的宿主执行连续性记录；不是 Task 或 Role 的替代品。
- **Agent Connection**：可选的机器本地 ACP 启动配置；不是身份或权限。
- **TaskInput / DecisionRequest / Proposal**：交互记录。Canvas 和 Inbox 只是权威事实的视图。

`blocked` 写入 Task `waiting` + `statusDetail`；明确终止失败写入 `failed` + `statusDetail`；需要用户选择时使用 DecisionRequest。正常非空 final report 直接提交 TaskResult。TaskResult 被接受后，用户或 Role 才可另行决定是否更新已有 Node，或创建 Output Node 并显式绑定该 Result。

## 架构

Tent 在 workspace 的 `.tent/` 中保存协作事实；它不是聊天记录，也不建立第二个代码仓库。

- **Core + Local Service**：领域规则与唯一 mutation authority。
- **Skills**：Role 与 Task 的 agent-facing 执行合同。
- **Desktop / CLI**：同一权威投影的客户端。

代码 Task 使用记录的 WorkspaceLane。Service 校验 commits、target head 与 integration CAS；客户端只发送 Protocol 10 RPC，并在 mutation 后重读权威投影。

## 贡献与安全

开发流程见 [`CONTRIBUTING.md`](CONTRIBUTING.md)，漏洞私密上报见 [`SECURITY.md`](SECURITY.md)。

## 许可证

[MIT](LICENSE)

## 友情链接

[Linux DO](https://linux.do)：连接开发者与技术爱好者的开放社区。
