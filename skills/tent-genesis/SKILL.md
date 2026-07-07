---
name: tent-genesis
description: 创建全新的 Tent / 帷幄：轻量追问帐名、Obsidian vault、唯一真实 workspace、首批框与 role，scaffold 无 Git 的 Tent，并初始化或连接真实 workspace Git 仓库。
---

# tent-genesis

当 user 要从零创建一顶新的 Tent / 帷幄时使用。

## 目标

轻量追问出足够信息，创建一顶能立刻工作的 Tent：

- Tent 名称与落点
- Obsidian vault 路径或显式 Tent 路径
- 唯一真实 workspace
- 第一批真实 box
- 第一批 role

Tent 只保存上下文和状态，不使用 Git。真实 workspace 才使用 Git。

## Role Init

定义初始 role 时，做一次很轻量的追问校准。

- 每个 role 只问一两个问题。
- 先问：这个 role 大概负责什么？
- 最多再追问一次：它明显不要做什么，或什么情况下必须停下来问 user？
- 如果 user 说“都可以”“你定”或把判断交给你，就根据这顶 Tent 的目标草拟。
- 草拟 `description`、`prompt`、可选 `color`，给 user 确认后再写 role 定义。
- 不要引入 skill slots、预设、复杂权限或工作流理论。

## Type 选择

创建 box 时必须有意识地选择 type。不要把所有东西都默认塞进 `goal`，也不要机械地给所有待办补二级 type。

最终以当前 Tent 的 `.tent/types.json` 为准。user 可以修改默认 type 的名称、R/W 和描述；下面是内置默认 type 的语义倾向，不是不可变枚举。

一级 type 通常表达 box 的主语义：

- `goal`：只用于真正的目标、最终要达成的结果、核心方向。它应该回答“我们要完成什么”。
- `prompt`：范围最大，用于任务说明、上下文、问题、提案、检查清单、review 发现、后续待办、派活意图，以及大多数 user/agent 协作文本。
- `output`：用于产出或产出指针。产出可以是代码仓、文档、release、npm 包、截图、构建物、task envelope、workspace 指针等。

二级 type 通常是可选修饰，不是默认补全项。

- 只有当当前注册表里的二级 type 符号语义真的重要，或需要它覆盖一级 type 的 R/W 默认值时，才写复合 type。
- 不要因为“还没做完”就自动加 `open`。进度属于 `status`。
- 不要因为“做完了”就自动加 `sealed`。`sealed` 是语义封存或隔离，不等于 done。
- 不确定时，优先用合适的一级 type；必要时问 user。

进度用 `status: todo | doing | done` 表达。type 表达语义和 R/W，不替代 status。

## Tags 选择

tags 是跨树检索索引，用来帮助 user 和 agent 之后找回同主题 box。它不替代 type，也不替代层级。

- 初始化真实 box 树时，只给需要被横向检索的 box 打少量稳定主题 tag，通常 1-3 个。
- 优先复用同一顶 Tent 里已有 tag；只有没有合适 tag 时才新建。
- tag 应表达长期主题或检索入口，例如 `open-source`、`release`、`npm`、`ui`、`security`、`code-health`、`workspace`。
- 不要把一次性短语、完整句子、临时任务名、过细文件名都做成 tag。
- 如果多个 box 属于同一主题，复用同一个 tag；不要为了每个 box 都发明一个近义 tag。

简化判断：type 表达主语义和 R/W，status 表达进度，层级表达归属关系，tags 表达横向检索主题。

## Output 位置

`output` 表示真实产出或产出指针。

- 全局 workspace 指针可以作为顶层 output。
- 具体代码、文档、release、npm 包、截图、构建物等 output，优先创建在对应处理 box 的子级中。
- output 笔记可以写 `workspace`、`ref`、`path` 或 `paths`，用于指向真实 workspace 的 commit、文件或目录。
- 不要把普通任务记录写成 output；只有它代表或指向一个可验收产物时才使用 output。

## 协议

1. 轻量追问出 Tent 名称、Obsidian vault 路径、唯一真实 workspace、第一批具体目标/上下文/产出，以及初始 role 名称。
2. 对每个初始 role 做轻量 role init 校准，并让 user 确认 `description`、`prompt`、可选 `color`。
3. 运行 `tent new <tent-name> --vault <vault-path>`。CLI 会读取 vault 的 `tentsRoot` 设置；不要硬编码 `_tents`，也不要把 Tent 放在 vault 根目录。若 user 明确给出独立路径，可用 `tent new <explicit-path>`。
4. scaffold 只包含 `RULES.md`、`.tent/types.json`、`.tent/roles.json`、`.tent/tags.json`、`temp/`。不创建通用 zone，不初始化 Tent Git，不创建 `SPEC.md`、agent 配置文件或 `.gitignore`。
5. 初始化或连接真实 workspace。如果 workspace 还不是 Git 仓库，创建目录并 `git init`，优先使用 `main`。如果它已经是仓库，保留历史和配置。随后在 workspace 根放一份 agent 规则文件，让在这个仓里干活的 coding agent 知道它由 Tent 驱动：若仓里没有 `AGENTS.md`（也没有既有的等价文件如 `CLAUDE.md`），新建一份 `AGENTS.md`，写清「本仓由一顶 Tent / 帷幄驱动：任务在各 role 的 worktree/branch 上执行，交付通过 `tent report` / `tent propose` 回到 user 的待裁由 user 确认；不要直接 push 或自行合并，合入由 user 裁决」；若已存在这类规则文件，以清晰分隔的一段**幂等追加**同样说明（先检查是否已写过，写过就跳过），绝不覆盖原有内容。这属于 workspace 文件改动，按第 11 条 commit。
6. 根据追问结果创建真实 box 树。优先用 `tent new-box <name> <type> [parentId]` 创建——它生成防撞 id 并校验 type；创建后补写身份笔记正文。只有 CLI 不可用时才手写文件夹加同名笔记（frontmatter 至少含 `id: bx-<six random chars>` 与有意选择的 `type`）。
7. box 名称创建后视为不可在 Tent 内重命名。不要创建 legacy `kind`。
8. 创建一个 `output` box，把 Tent 映射到真实 workspace，写入 `workspace` 和可选当前 `ref`。一顶 Tent 不应指向多个 workspace。
9. 写 `.tent/roles.json`，格式为 `{ "roles": [{ "name", "description"?, "prompt"?, "color"? }] }`。
10. 把项目本地约定写入 `RULES.md`：workspace 路径、提交/命名约定、其他项目规矩。用追问出的实际值填写，不要留 `<填>` 之类的占位符——追问不出的条目写"暂无"并告知 user。机制规范属于 Tent 仓库文档，不复制进新 Tent。
11. 只有当 genesis 创建或有意修改了真实 workspace 文件时，才 commit workspace。永远不要 commit Tent。

不要创建 `.tent/skills.json`。不要创建 `for:` 链接。
