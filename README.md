# Vibe Tent / 帷幄

> *vibe 于帷幄之中*

user 和 coding agent 的协作，本质是把代表你意图的 **goal**，经由 **prompt** 交给 agent，最终得到 **output**。当你同时推进多项工作，这个过程很快会失控：长期事实在哪里、谁在承担责任、某次执行能改什么、交付是否可信——都散落在各处。

**Vibe Tent（帷幄）承载这套协作**——用持久 Node 保存意图与事实，用 Task、Session 和 Delivery 管理一次次执行与验收，并把产出追踪回真实 workspace 和 Git。Desktop 与 CLI 都连接同一个 Local Service；你运筹，Role 承担长期责任，临时 ACP Session 执行具体工作，决策权始终在你。

**示例demo**：
<img width="1572" height="1076" alt="image" src="https://github.com/user-attachments/assets/2989b6ff-e249-435e-913e-c0267c05ffdf" />

## 快速开始

**环境**：Node.js 20+、Git。

**prompt agent 安装（推荐）** —— 把下面这段发给你的 coding agent（Claude Code / Codex）：

```
Install Vibe Tent CLI, Desktop, and Skills for me (github.com/cucarol/vibe-tent):
1. Clone the repo and run `npm ci && npm run build && npm run build:desktop`.
2. Run `npm link`, then `tent skill-install` to sync the bundled Skills.
3. Verify `tent --help`; launch Desktop with `npm run desktop:start` when I ask.
Use only the CLI, Desktop, and bundled Skill installation paths above.
```

也可以手动执行上述四条 npm / CLI 命令。
已有项目先使用 `tent-init` 提议初始 Node / Role 结构，并在你确认后物化。日常协作组合两个 Skill：`tent-role` 负责持久 Role 的连续性与编排，`tent-task` 负责具体 Task 的执行与交付；Role 执行 Task 时同时加载两者。

## 架构与概念

<img width="1721" height="834" alt="image" src="https://github.com/user-attachments/assets/b3cd6e0d-8990-464a-ab51-9fd071c16bf4" />

Tent 在项目 workspace 的 `.tent/` 中保存协作事实；真实产出（代码、文档）和 Git 历史仍在原 workspace。`.tent/` 不建立第二个仓库，也不是 Agent 的聊天记录。

它由三部分组成：**Core + Local Service**（领域规则和唯一 mutation 路径）、**Agent Skills**（Role 与 Task 的执行合同）、**Desktop / CLI**（同一事实的客户端）。

### Core 与 Local Service

<img width="1938" height="525" alt="image" src="https://github.com/user-attachments/assets/3f9beeae-ac0e-4307-8f62-0c0e43283111" />

Core 定义 Node、Role、Task、Session 与 Delivery 的领域规则；Local Service 是 mounted workspace 的唯一 mutation authority。客户端只发 RPC 并重新读取权威投影，不直接改 `.tent/temp/`。

- **Node** —— 带稳定 `cx-` id 的 Markdown 知识与上下文。父子结构表达归属，正文保存跨 Session 仍成立的事实；`goal`、`prompt`、`output` 是主要语义类型。
- **Role** —— 对用户长期负责的主体。Role 可跨 Session 恢复，但不能靠聊天历史代替 Node、Task、Delivery 与 Git。
- **Task** —— 针对 exact work Nodes 与 shared context Nodes 的一次工作与审阅单位。Role 用 `task claim --work-node … --prompt …` 创建并认领自己的执行 Task；`task dispatch --target …` 只把工作交给另一个 Role，或通过 Agent Connection 创建 exact temporary ACP Session。同一 work Node 同时只能被一个 active Task 占用。
- **Session** —— 一次可终止、恢复或显式替换的执行。`--target role:<roleId>` 创建 queued Role handoff；`--target connection:<connectionId>` 从机器 Settings 读取非身份化的 Agent Connection，并为该 Task 创建唯一 Session。Connection 只提供启动配置，不是 Task 身份、Role 或 ACL。
- **Delivery** —— Task 的正式结果。自然非空 ACP final report 默认形成可审阅 Delivery；`blocked` / `needs-input` 是可选控制信号，不是成功交付。
- **Git lane** —— 代码 Task 在记录的 Role 或 Task lane 中工作。Service 校验 commits、target head 与 integration CAS；客户端不手动移动协作状态。

### skill

Agent 侧只有两个可组合行为合同：**`tent-role`** 负责进入或恢复持久 Role、维护 Node 上下文并审查下游交付；**`tent-task`** 负责任何执行者的 Task、A2U/U2A、工作区边界与 Delivery 生命周期。

### Desktop UI

可视化层把同一合同摊在面板里操作：浏览 Node、查看 active Task 与 Session、通过 Agent Connection 启动临时执行，并确认或驳回 Delivery。关闭窗口不会创建第二份状态，也不会停止 Local Service。

https://github.com/user-attachments/assets/092cec70-e68d-4298-a2fc-c5d58921a14d

## 贡献与安全

开发规则、仓库结构与本地开发流程见 [`CONTRIBUTING.md`](CONTRIBUTING.md)，漏洞私密上报指引见 [`SECURITY.md`](SECURITY.md)。

## 许可证

[MIT](LICENSE)

## 友情链接

[Linux DO](https://linux.do)：连接开发者与技术爱好者的开放社区。
