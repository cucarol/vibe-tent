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
3. Run `npm link`, then run `tent skill-install`.
When done, tell me to enable Tent in Obsidian's community-plugin settings.
```

**2） BRAT** —— 用 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 添加 `cucarol/tent`，自动安装并保持更新。

**3） 手动安装** —— 构建后把 `main.js`、`manifest.json`、`styles.css` 拷入 `<vault>/.obsidian/plugins/tent/`。

以上任一方式装好后，在 Obsidian 第三方插件设置中启用 Tent；
在你的 agent 里运行 `tent-genesis` 创建第一顶帐，
之后每个新会话运行 `tent-role` 进入工作。

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
- **派活与认领** —— `tent dispatch <boxId> <role> --prompt <text>` 只写入一份任务信封和一段接力 prompt，并不替 agent 占用；目标 agent 执行 `tent task-ack` 才真正认领，框转入占用态。派活既可 user → agent（U2A），也可 agent → agent（A2A）；Tent 从不自动唤醒 agent，接手始终由目标 agent 的 `task-ack` 完成。
- **执行与隔离** —— dispatch 会从 Tent 唯一的 workspace 指针自动解析并创建 `worktree + branch`，每个 role 一条独立车道，多个 agent 同时干活互不干扰。真实代码、commit、branch 都发生在 workspace，Tent 侧只存状态。
- **交付与裁决** —— 完成后 agent 用 `tent report <boxId> --commits <sha>` 交付成果、或用 `tent propose <boxId>` 提议，二者都投递到「待裁」；你确认（`tent complete`）或驳回。确认一份带 commit 的 report 即把改动合入 workspace，框标记完成。全程你是唯一决策者，agent 的交付只有经你确认才生效。

### skill

agent 侧有两个 skill，覆盖「创建」和「进入」两件事。

1. **`tent-genesis`（每个项目一次）** —— 用于创建并初始化帐，agent 寻求 **帐** 与 **工作区** 的路径，然后创建一顶帐。
2. **`tent-role`（每个会话一次）** —— 一个 agent 会话运行该 skill 创建或者认领某个 role：读取自己的信箱、已认领的框与权限，再开始工作。

### Obsidian UI

可选的可视化层，把上面这套 core 摊在面板里操作：左侧是整棵 box 树，右侧是选中 box 的详情面板，含三个 tab——**笔记**（box 正文）、**派活**（把框交给某个 role）、**待裁**（逐个确认或驳回 report / proposal）。

https://github.com/user-attachments/assets/092cec70-e68d-4298-a2fc-c5d58921a14d

## 贡献与安全

开发规则、仓库结构与本地开发流程见 [`CONTRIBUTING.md`](CONTRIBUTING.md)，漏洞私密上报指引见 [`SECURITY.md`](SECURITY.md)。

## 许可证

[MIT](LICENSE)
