---
name: tent-role
description: 让 agent 进入现有 Tent 的长期 role session：从 task envelope 信箱接活，读取稳定 init 与动态 manifest，在真实 workspace 的 role worktree/branch 工作并提交，最后报告 commit 等待验收。
---

# tent-role

当 agent 要进入或恢复一顶现有 Tent 里的长期 role session 时使用。

## 路径与布局（in-workspace）

Desktop / 共置 agent 使用 **in-workspace** 布局：

| 名称 | 含义 | 示例 |
| --- | --- | --- |
| **workspace root** | 真实项目根；在此运行 `tent` CLI | `C:/proj/MyRepo` |
| **system root** | Tent 系统根 = `workspaceRoot/.tent` | `C:/proj/MyRepo/.tent` |
| **CLI taskPath** | 相对 **system root**（不带 `.tent/` 前缀） | `temp/<role>/tasks/….md` |
| **直接文件读取** | 相对 workspace root 用 `.tent/…`，或绝对 system root | `.tent/temp/<role>/init.md` |

硬规则：

- 工作区根包含 `.tent/`。**RULES、temp、roles/types 注册表都在 `.tent/` 内**。
- **不要**把 operational 路径拼成 `<workspaceRoot>/temp` 或 `<workspaceRoot>/RULES.md`。
- CLI 参数 `taskPath` / 多数 core 相对路径仍是 `temp/...`（相对 `.tent`）。读磁盘文件时用 `.tent/temp/...`。
- Context Card / bootstrap 若写了 `workspaceRoot` + `systemRoot`，以它们为准；`tentRoot` 若出现，表示 **system root**（`.tent`），不是 workspace。

## 模型

- Tent 用普通文件保存意图、上下文、状态和协作管道；Tent 本身不使用 Git。
- 一顶 Tent 只指向一个真实 workspace。真实代码、commit、branch、worktree 都发生在 workspace。
- 一个 role 是一个长期 session，并复用一个 workspace `worktree + branch`。一个 role 可以处理多个 box。
- 一个 box 是一个文件夹加同名 Markdown 身份笔记。`bx-` id 随移动保持稳定。层级表达服务关系。
- box = 任务本体；envelope = 机器投递状态载体。一句话版：内容住 box，状态住 envelope。
- `manifest.yml` 解析 claim、readable、writable。它是 honor contract，不是安全沙箱。若任务指令和 manifest 边界冲突，停止并询问 user。
- `manifest.yml` 的 `preloaded` 字段只是应加载内容的清单，不是正文已经进入模型上下文的证明。role 必须实际读取所需文件，不能仅凭清单名称声称已知内容。
- 交付与验收走 **Local Service** 的 `tent task deliver` / Desktop accept；聊天里的总结是给人看的，不是第二写路径。

## Role Init

如果 user 要你创建或初始化一个尚未清晰定义的 role，先做一次很轻量的追问校准。

- 目标是把 role 的责任和边界追清楚一点，但只问一两个问题。
- 先问：这个 role 大概负责什么？
- 最多再追问一次：它明显不要做什么，或者什么情况下必须停下来问 user？
- 如果 user 说“都可以”“你定”或把判断交给你，就根据当前 Tent 上下文草拟。
- 草拟 `description`、`prompt`、可选 `color`，给 user 确认后再写 `.tent/roles.json`。
- 写完后运行 `tent role-init <role>`。
- 一旦 role 足够清楚就停，不要发明复杂权限、预设、slot 或工作流理论。

## Type 选择

创建 box 时必须有意识地选择 type。不要把所有东西都默认塞进 `goal`，也不要机械地给所有待办补二级 type。

最终以当前 Tent 的 `.tent/types.json` 为准。user 可以修改默认 type 的名称、R/W 和描述；下面是内置默认 type 的语义倾向，不是不可变枚举。

一级 type 通常表达 box 的主语义：

- `goal`：只用于真正的目标、最终要达成的结果、核心方向。它应该回答“我们要完成什么”。不要把普通待办、检查项、问题记录都写成 goal。
- `prompt`：范围最大，用于任务说明、上下文、问题、提案、检查清单、review 发现、后续待办、派活意图，以及大多数 user/agent 协作文本。
- `output`：用于产出或产出指针。产出可以是代码仓、文档、release、npm 包、截图、构建物、task envelope、workspace 指针等，重点是它代表或指向某个交付物。

二级 type 通常是可选修饰，不是默认补全项。

- 只有当当前注册表里的二级 type 符号语义真的重要，或需要它覆盖一级 type 的 R/W 默认值时，才写 `goal-open`、`prompt-reference`、`output-asset` 这类复合 type。
- 不要因为“还没做完”就自动加 `open`。进度属于 `status`。
- 不要因为“做完了”就自动加 `sealed`。`sealed` 是语义封存或隔离，不等于 done。
- 不确定时，优先用合适的一级 type；必要时停下来问 user。

进度用 `status: todo | doing | done` 表达。type 表达语义和 R/W，不替代 status。

## Tags 选择

tags 是跨树检索索引，用来帮助 user 和 agent 之后找回同主题 box。它不替代 type，也不替代层级。

- 创建、整理或交付 box 时，给需要被横向检索的 box 打 1-3 个稳定主题 tag。
- 优先复用 `.tent/tags.json` 里已有 tag；只有没有合适 tag 时才新建。
- tag 应表达长期主题或检索入口，例如 `open-source`、`release`、`npm`、`ui`、`security`、`code-health`、`workspace`。
- 不要把一次性短语、完整句子、临时任务名、过细文件名都做成 tag。
- 如果同一批 box 都属于同一主题，复用同一个 tag；不要为了每个 box 都发明一个近义 tag。

简化判断：type 表达主语义和 R/W，status 表达进度，层级表达归属关系，tags 表达横向检索主题。

## Output 位置

`output` 表示真实产出或产出指针。

- 全局 workspace 指针可以作为顶层 output。
- 具体代码、文档、release、npm 包、截图、构建物等 output，优先创建在对应处理 box 的子级中。
- output 笔记可以写 `workspace`、`ref`、`path` 或 `paths`，用于指向真实 workspace 的 commit、文件或目录。
- 不要把普通任务记录写成 output；只有它代表或指向一个可验收产物时才使用 output。

## agent 向 user 提提案

提案就是 agent 针对某个 box 给 user 提的一段 prompt，投递到待裁，交给 user 确认或驳回。默认自己拿主意，真正需要 user 过目或拍板的才提。

提法：

```bash
tent propose <boxId> <file|->
```

正文写清想说的；有选项就给 2-4 个；写出你的推荐和影响。提案出现在该 box 的待裁，user 确认或驳回后解消。

## 协议（service task lifecycle）

Desktop 共置与 Local Service 路径使用 **`tent task *`**（经 Service RPC）。不要把 legacy `task-ack` / `report` 当主流程。

1. 确认 **CLI 工作目录是 workspace root**，且存在 `.tent/RULES.md` 与 `.tent/`。否则停止并告诉 user。
2. 进入或恢复会话时可运行 `tent status` 快速定向：看待裁提案、待 claim / running task、认领态，以及 workspace / system 两个路径。
3. 新 role session 只读一次 **role init**：
   - 文件：`.tent/temp/<role>/init.md`
   - CLI 相对 system root：`temp/<role>/init.md`
   它是稳定 role 上下文，设计上用于 prompt cache 复用。新建或恢复 role session 时还必须显式读取 `.tent/RULES.md`；如果任务进入真实 workspace，还必须读取该 workspace 的项目规则文件（例如 `AGENTS.md`、`CLAUDE.md` 或仓库明确指定的等价文件）。
4. 每次唤醒或恢复 role 时：
   - **若 bootstrap / Context Card 写明 service 已 claim（`task.startSession` 路径）**：不要 `tent task claim`，用 `tent task get <taskPath>` 检查任务，再读 envelope / manifest / claimed box，最终 `tent task deliver`。
   - **若是外部手动唤醒 / 剪贴板 relay（任务仍 queued）**：先 `tent task claim <taskPath>`，再读 envelope 与 box，最终 deliver。
   - user 直接给了 task 路径时以该路径为准；否则用 `tent task list` 或检查 `.tent/temp/<role>/tasks/*.md`。
5. 接任务后读取 envelope 指向的 manifest 与 claimed box；box 正文才是任务定义，envelope 只是不可变指针。复制 relay prompt 不是消费事件；只有 `task claim`（或 service 代 claim）会把任务改成 `running`。
6. 粗 box 可以直接派活。claim 后先对齐任务：读 box 正文和必要子框；不清楚就问 user；对齐结论写回 box 正文。box 的细节是在推进中长出来的，不是派活门槛。
7. 如果 user 没有给 task 文件而是在会话里直接口头指派（ad-hoc），仍先扫描信箱；没有 pending/queued task 时再按口头范围工作。读 `.tent/RULES.md` 与所需上下文，只在既有授权或 user 明示的范围内写 Tent 文件；范围拿不准就先确认。
8. 使用 task 里的 `worktree` 作为真实代码工作目录，使用 task 里的 `branch` 作为该 role 的长期分支。后续任务复用它们。这三个字段由 dispatch 自动生成：从 Tent 唯一的 workspace 指针框解析 workspace，按 `tent-role/<role>` 与 `<workspace>-worktrees/<role>` 命名并实际创建 worktree——派活者不手填，接活者不自建。若 envelope 没有这些字段，说明该 Tent 没有 workspace 指针框：这是合法的纯 Tent 任务（只做 Tent 侧工作，不碰代码仓），不是派活出错。
9. 读取 `.tent/RULES.md` 和完成任务必要的 manifest-readable 上下文。只在 manifest-writable 范围内写 Tent 文件。
10. 真实 workspace 的改动按 box 或独立可验收交付分批 commit。不要 commit Tent 状态（`.tent/`）。
11. 协作命令：
   - `tent roles`：读取共享 role 注册表，再选择派活目标 role。
   - `tent task dispatch` / Desktop 派活：生成该 role 的 queued task envelope。user prompt 必填；真正认领发生在目标 agent `tent task claim`，或 Desktop/service `task.startSession` 代 claim。
   - `tent new-box <name> <type> [parentId]`：创建 box 并获得防撞 id。CLI 只生成空身份笔记——建完立即补写正文（问题、方案、验收标准）和 `status`，不要留空壳框。
   - `tent fork <boxId>`：复制子树，只改变根名称，重发 ids，并清 owner/status。
12. 收尾时在聊天里报告：改了什么、还剩什么、跑了什么测试、workspace commit hash。报告只写你**实际验证过**的事实——测试贴运行结果，修复贴复现前后对比；命令打了 ✓ 不等于结果发生了，关键动作要回读状态确认。交付用：

```bash
tent task deliver <taskPath> --summary <text> [--commits sha,sha]
```

## 编排者手册

编排不是另一个 A2A 专属 skill；仍然使用 tent-role。

标准链路是：dispatch -> spawn/唤醒 -> claim（或 startSession 代 claim）-> deliver -> review -> accept。

- dispatch：写 manifest 和 queued task envelope，不写 owner/status。派活不要求你对目标 box 有 readable 或 writable——claim 权独立于读写权，唯一的门是占用拓扑：目标及其祖先、子孙没有 owner，也没有 active task envelope，且不是归档/失效子树。编排 role 可以把任何无占用冲突的框派给别的 role；manifest 的写权是为接活 role 生成的，与派活者无关。
- workspace 契约：任意位置的框只要其一级/base type 在 `.tent/types.json` 开启了 `workspacePointer`，且 frontmatter 有非空 `workspace`（或正文有 `workspace: ...` 行），就是 workspace 指针；框名与 type 字面名称（是否叫 `output`）不参与识别，二级 type 跟随一级。CLI 据此自动创建/复用 `tent-role/<role>` 与 `<workspace>-worktrees/<role>`，派活者不手填 envelope 的 workspace/worktree/branch。开启能力但未填 `workspace` 的框只是普通框。
- claim：目标 agent 执行 `tent task claim <taskPath>`（Service RPC）后，envelope 变为 running，并把目标 box owner 设为该 role、status 设为 doing。**`task.startSession` 会在 user 路径上先 claim，bootstrap 会写明已 claim——agent 不要再 claim。**
- deliver：完成后执行 `tent task deliver <taskPath> --summary …`；user 用 Desktop 或 `tent task accept/reject` 裁决。
- A2A：role 是否可 `startSession` 由 `.tent/roles.json` 的 `a2aPolicy: allow|ask|deny`（默认 deny）服务端硬执行；不要把 secret 写入 role。
- manifest 是 dispatch 时刻的快照；派活后修改 box 的 readable、writable 或 type 不影响已发出的 manifest，需要释放后重新 dispatch 才刷新。
- spawn/唤醒：把 **relay prompt**（含 claim）交给外部/手动唤醒的会话；或由 service **startSession bootstrap**（已 claim，get + deliver）推给 ACP 会话。
- review / accept：读 delivery、commit、diff；不满意就 reject 或继续追问。只有 user（或被明确授权的编排）可 accept。

不要自己把 box 标记完成。只有 user 确认后，交付才算完成。

dispatch 只写入 envelope，不会唤醒目标 agent；由 user 或已授权的 orchestrator 唤醒目标会话。

## Legacy（仅离线 / 非 Desktop 共置）

直写 core 的 `tent dispatch` / `tent task-ack` / `tent report` / `tent complete` 仍可用于离线测试与旧文档兼容。

- **不要**在 Desktop 共置、Local Service 已挂载时作为第二写路径使用。
- 新架构协作生命周期以 service 为唯一 mutation entry：`tent task claim|get|deliver|…`。
- 若你的本机 skill 仍主推 `task-ack` / `tent report` 作为默认接活/收尾，请用仓库内 `tent skill-install --force` 覆盖安装本 bundled 版本。
