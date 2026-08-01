# Tent / 帷幄

> *vibe 于帷幄之中*

user 和 coding agent 的协作，本质是把代表你意图的 **goal**，经由 **prompt** 交给 agent，最终得到 **output**。当你同时推进多项工作，这个过程很快会失控：长期事实在哪里、谁在承担责任、某次执行能改什么、交付是否可信——都散落在各处。

**Tent（帷幄）承载这套协作**——用持久 Node 保存意图与事实，用 Task、Session 和 Delivery 管理一次次执行与验收，并把产出追踪回真实 workspace 和 Git。Desktop、CLI 与可选插件都连接同一个 Local Service；你运筹，Role 承担长期责任，临时 ACP Session 执行具体工作，决策权始终在你。

**示例demo**：
<img width="1572" height="1076" alt="image" src="https://github.com/user-attachments/assets/2989b6ff-e249-435e-913e-c0267c05ffdf" />

## 快速开始

**环境**：Node.js 20+、Git、Obsidian 1.5+（仅桌面端）。

安装有三种方式，任选其一。

**1） prompt agent 安装（推荐）** —— 把下面这段发给你的 coding agent（Claude Code / Codex），它会问你要 vault 路径并完成全部安装：

```
Install the Tent plugin and CLI for me (github.com/cucarol/tent):
1. Clone the repo and run `npm ci && npm run build`.
2. Ask me for my Obsidian vault path, then copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/tent/`.
3. Run `npm link`, then run `tent skill-install` (syncs bundled skills to `~/.claude/skills` and shared `~/.agents/skills`).
When done, tell me to enable Tent in Obsidian's community-plugin settings.
```

**2） BRAT** —— 用 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 添加 `cucarol/tent`，自动安装并保持更新。

**3） 手动安装** —— 构建后把 `main.js`、`manifest.json`、`styles.css` 拷入 `<vault>/.obsidian/plugins/tent/`。

以上任一方式装好后，在 Obsidian 第三方插件设置中启用 Tent；
在你的 Agent 里组合使用两个 Skill：`tent-role` 负责持久 Role 的连续性与编排，`tent-task` 负责所有具体 Task 的执行与交付；Role 执行 Task 时同时加载两者。

## 架构与概念

<img width="1721" height="834" alt="image" src="https://github.com/user-attachments/assets/b3cd6e0d-8990-464a-ab51-9fd071c16bf4" />

Tent 在项目 workspace 的 `.tent/` 中保存协作事实；真实产出（代码、文档）和 Git 历史仍在原 workspace。`.tent/` 不建立第二个仓库，也不是 Agent 的聊天记录。

它由三部分组成：**Core + Local Service**（领域规则和唯一 mutation 路径）、**Agent Skills**（Role 与 Task 的执行合同）、**Desktop / CLI / 可选插件**（同一事实的客户端）。

### Core 与 Local Service

<img width="1938" height="525" alt="image" src="https://github.com/user-attachments/assets/3f9beeae-ac0e-4307-8f62-0c0e43283111" />

Core 定义 Node、Role、Task、Session 与 Delivery 的领域规则；Local Service 是 mounted workspace 的唯一 mutation authority。客户端只发 RPC 并重新读取权威投影，不直接改 `.tent/temp/`。

- **Node** —— 带稳定 `cx-` id 的 Markdown 知识与上下文。父子结构表达归属，正文保存跨 Session 仍成立的事实；`goal`、`prompt`、`output` 是主要语义类型。
- **Role** —— 对用户长期负责的主体。Role 可跨 Session 恢复，但不能靠聊天历史代替 Node、Task、Delivery 与 Git。
- **Task** —— 针对一个或多个 exact Node 的一次工作与审阅单位。Role 用 `task claim --node … --prompt …` 直接创建并认领自己的执行 Task；`task dispatch --target …` 只把工作交给另一个 Role 或 Settings route。`nodeIds[]` 是唯一公开 Node 选择；同一 Node 同时只能被一个 active Task 占用。
- **Session** —— 一次可终止、恢复或重新连接的执行。`--target role:<roleId>` 创建 queued Role handoff；`--target route:<routeId>` 从 Settings 解析机器本地 route 并启动临时 ACP Session。临时 Session 不注册持久 worker，也不创建第二个 Role。
- **Delivery** —— Task 的正式结果。自然非空 ACP final report 默认形成可审阅 Delivery；`blocked` / `needs-input` 是可选控制信号，不是成功交付。
- **Git lane** —— 代码 Task 在记录的 Role 或 Task lane 中工作。Service 校验 commits、target head 与 integration CAS；客户端不手动移动协作状态。

### skill

Agent 侧只有两个可组合行为合同：**`tent-role`** 负责进入或恢复持久 Role、维护 Node 上下文并审查下游交付；**`tent-task`** 负责任何执行者的 Task、A2U/U2A、工作区边界与 Delivery 生命周期。

### Obsidian UI

可视化层把同一合同摊在面板里操作：浏览 Node、查看 active Task 与 Session、从 Settings route 派发工作，并确认或驳回 Delivery。关闭窗口不会创建第二份状态，也不会停止 Local Service。

https://github.com/user-attachments/assets/092cec70-e68d-4298-a2fc-c5d58921a14d

## 贡献与安全

开发规则、仓库结构与本地开发流程见 [`CONTRIBUTING.md`](CONTRIBUTING.md)，漏洞私密上报指引见 [`SECURITY.md`](SECURITY.md)。

## 许可证

[MIT](LICENSE)

## 友情链接

[Linux DO](https://linux.do)：连接开发者与技术爱好者的开放社区。
