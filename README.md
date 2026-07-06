# Tent / 帷幄

> *vibe 于帷幄之中*

user 和 coding agent 的协作，本质是把代表你意图的 **goal**，经由 **prompt** 交给 agent，最终得到 **output**。当你同时指挥多个 agent，这个过程很快会失控：谁在做什么、能改哪里、进行到哪一步、交付是否可信——都散落在各处。

**Tent（帷幄）承载这套协作**——在 Obsidian 中可视化地定义意图、划定 agent 权限、派活与验收，产出可追踪回真实代码仓。你运筹，agent 执行，决策权始终在你。

<!-- demo 截图 / 视频：在 GitHub 上拖拽上传后替换此处 -->

## 快速开始

**环境**：Node.js 20+、Git、Obsidian 1.5+（仅桌面端）。

安装有三种方式，任选其一。

**① 交给 agent 安装（推荐）** —— 把下面这段发给你的 coding agent（Claude Code / Codex），它会问你要 vault 路径并完成全部安装：

> Install the Tent plugin and CLI for me (github.com/cucarol/tent):
> 1. Clone the repo and run `npm ci && npm run build`.
> 2. Ask me for my Obsidian vault path, then copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/tent/`.
> 3. Run `npm link`, then run `tent skill-install`.
> When done, tell me to enable Tent in Obsidian's community-plugin settings.

**② 手动安装** —— 构建后把 `main.js`、`manifest.json`、`styles.css` 拷入 `<vault>/.obsidian/plugins/tent/`，在 Obsidian 第三方插件设置中启用。

**③ BRAT** —— 用 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 添加 `cucarol/tent`，自动安装并保持更新。

安装并启用后，
在你的 agent 里运行 `tent-genesis` 创建第一顶帐；
之后每个新会话运行 `tent-role` 进入工作。

## 架构与概念

Tent 在你的 Obsidian 中创建一个文件夹存放 markdown 文档；真实产出（代码、文档）所在的 workspace 由你指定。一顶 Tent 本质是一个 **OKF v0.1 bundle**——一批带 frontmatter 的 markdown，加一层治理。它由三部分组成：**core**（规则与文件契约）、**Obsidian UI**（可视化操作）、**agent 侧 skill 层**（agent 如何进入并使用一顶帐）。

<!-- 架构图：可自己画一张替换下面的 ASCII 示意 -->

```text
你 ──写意图 / 派活──▶  box 树（意图 / 权限 / 状态）
                          │
                任务 + 接力 prompt
                          ▼
                     agent · role ──在 worktree / branch 执行──▶  代码 · 真实产出
                          │
                report / proposal 投递
                          ▼
你 ◀──确认 / 驳回──   待裁
```

### 两个 skill

1. **`tent-genesis`（创建帐，一次性）** —— 让 agent 运行它，它会向你询问 Tent 区与 workspace 的路径，然后创建帐。
2. **`tent-role`（每个新会话一次）** —— 此后每开启一个 agent 会话，先让它运行 tent-role 进入某个 role：读取自己的信箱、已认领的框与权限，随后开始工作。

### 界面

打开面板，左侧是整棵 box 树，选中任一 box，右侧是它的详情面板。

- **box（框）** —— 每份 markdown 文档即一个 box，可带父子层级与一组属性；父子关系表达归属，正文是任务本体。
- **type / status / tags** —— 每个 box 具有 `type`（`goal` / `prompt` / `output`，决定语义与默认读写）、`status`（todo / doing / done，表示进度）、`tags`（横向检索主题）；读写权限（R/W）也在详情面板中设置。
- **三个 tab** —— **笔记**是 box 的正文；**派活**把该框交给某个 role；**待裁**收拢等待你裁决的项。

### 一个使用周期

1. 你在框里写下意图，在「派活」把它交给某个 role。派活会生成一份任务与一段接力 prompt；目标 agent 执行 `task-ack` 接手后，框进入占用态。
2. agent 在它专属的 `worktree + branch` 里执行——每个 role 一条独立车道，多个 agent 同时干活互不干扰。
3. 完成后，agent 把成果作为 **report** 交付、或把建议作为 **proposal** 提出，二者都落到你的「待裁」。
4. 你在「待裁」确认或驳回。确认一份带 commit 的 report，即把 agent 的改动合入你的 workspace，框随之标记完成。

全程你是唯一决策者——agent 的交付只有经你确认才生效。

### 可自定义

- **type**：除内置的 goal / prompt / output 外可自定义，包括默认 R/W 与描述。
- **role**：可自定义，除描述外还可附带一段专属 prompt，作为该 role 的稳定设定。

### 多 agent 与 A2A

派活不限于 user → agent（U2A），agent 也可派给 agent（A2A）。派活本质上是写入一份任务与一段接力 prompt，两种 A2A 情形的区别仅在于如何把这段 prompt 送达接收方：接收方为 GUI agent 时，由你手动复制粘贴，相当于替派活方完成一次输入；为 CLI agent 时，编排方可自行唤醒它并送入 prompt，直接接手。

Tent 本身只写入任务与接力 prompt，从不自动唤醒 agent——真实接手始终由目标 agent 的 `task-ack` 完成。

## 项目状态

- core、CLI 与 agent skill 均已实现。
- type 系统是扁平的、对齐 OKF 的注册表，支持用户自定义 type。
- OKF 索引/日志生成与 wiki-link 投影通过 `tent okf-sync` 提供。
- `temp/` 是系统管道，不是语义节点或 type。
- Obsidian UI 仍在迭代中。

## 贡献与安全

开发规则、仓库结构与本地开发流程见 [`CONTRIBUTING.md`](CONTRIBUTING.md)，漏洞私密上报指引见 [`SECURITY.md`](SECURITY.md)。

## 许可证

[MIT](LICENSE)
