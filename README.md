# Tent / 帷幄

> *vibe 于帷幄之中*

user 和 coding agent 的协作，本质是把代表你意图的 **goal**，经由 **prompt** 交给 agent，最终得到 **output**。当你同时指挥多个 agent，这个过程很快会失控：谁在做什么、能改哪里、进行到哪一步、交付是否可信——都散落在各处。

**Tent（帷幄）承载这套协作**——在 Obsidian 中可视化地管理 **goal**、**prompt** 和 **output**，划定 agent 权限、派活与验收，产出可追踪回真实代码仓。你运筹，agent 执行，决策权始终在你。

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

Tent 在你的 Obsidian 中创建一个文件夹存放 markdown 文档；真实产出（代码、文档）所在的 workspace 由你指定。

它由三部分组成：**core**（规则与文件契约）、**agent 侧 skill 层**（agent 如何进入并使用一顶帐）、**Obsidian UI**（可视化操作）。

OKF 兼容：一顶 Tent（帐） 本质是一个 OKF v0.1 bundle；`tent okf-sync` 生成 OKF 索引/日志并投影 wiki-link，让这批 markdown 同时是一份可被其它工具读取的开放知识库。
https://github.com/GoogleCloudPlatform/knowledge-catalog

### core

<img width="1938" height="525" alt="image" src="https://github.com/user-attachments/assets/3f9beeae-ac0e-4307-8f62-0c0e43283111" />

core 是 Tent（帐） 的地基：一套纯文件约定，加上操作它的 `tent` CLI。状态、意图、权限、协作管道全部落在带 frontmatter 的 markdown 和 `.tent/` 注册表里——不依赖 Obsidian，也不用 Git 存状态。UI 只是它的可视化外壳，整套流程用 CLI 就能跑完。

- **box（框）** —— 每份带 frontmatter 的 markdown 即一个 box：`bx-` id 随移动保持稳定，父子层级表达归属，正文是任务本体。`tent new-box <name> <type> [parentId]` 建框，`tent fork <boxId>` 复制整棵子树。
- **type / status / tags / 权限** —— `type`（`goal` / `prompt` / `output`）决定语义与默认读写，`status`（todo / doing / done）表进度，`tags` 做横向检索，每个 box 另有 R/W 权限。type 存在 `.tent/types.json`，可自定义名称、默认 R/W 与描述。
- **派活与认领** —— Desktop / 外部 agent 优先走 **Local Service RPC**：`tent task list|get|claim|deliver`（attach 当前 workspace 的同一 service；CLI 退出不杀 service）。窗口关掉后仍可 claim/deliver，Desktop 看到同一状态。详见 [`docs/desktop/cli-service.md`](docs/desktop/cli-service.md)。
- **Legacy CLI** —— `tent dispatch` / `tent task-ack` / `tent complete` 等仍可在 external root 直写 core（迁移窗口 / 离线测试）；**不要**与 Desktop 共置时当第二写路径。正式交付只有 Delivery 单轨（`task.deliver`），无 `tent report`。
- **执行与隔离** —— dispatch 会从 in-workspace tent 解析并创建 `worktree + branch`，每个 role 一条独立车道。真实代码、commit、branch 都发生在 workspace，Tent 侧只存协作状态。
- **交付与裁决** —— agent 用 `tent task deliver <taskPath> --summary …`（RPC）提交 Delivery（`summary` 即给 user 读的 report 正文）；你在 Desktop 或 `tent task accept/reject` 裁决。全程你是唯一决策者。

### skill

Agent 侧只有两个可组合行为合同：**`tent-role`** 负责创建、进入或恢复持久 Role，以及下游编排和审查；**`tent-task`** 负责任何 Agent 的 Task claim、A2U/U2A、工作区边界与 Delivery 生命周期。

### Obsidian UI

可选的可视化层，把上面这套 core 摊在面板里操作：左侧是整棵 box 树，右侧是选中 box 的详情面板，含三个 tab——**笔记**（box 正文）、**派活**（把框交给某个 role）、**待裁**（逐个确认或驳回 Delivery / proposal）。

https://github.com/user-attachments/assets/092cec70-e68d-4298-a2fc-c5d58921a14d

## 贡献与安全

开发规则、仓库结构与本地开发流程见 [`CONTRIBUTING.md`](CONTRIBUTING.md)，漏洞私密上报指引见 [`SECURITY.md`](SECURITY.md)。

## 许可证

[MIT](LICENSE)

## 友情链接

[Linux DO](https://linux.do)：连接开发者与技术爱好者的开放社区。
