---
name: tent-role
description: 让 agent 进入现有 Tent 的长期 role session：读取稳定 init 与动态 task/manifest 指针，在真实 workspace 的 role worktree/branch 工作并提交，用 proposal、handoff、fork 协作，最后在聊天中报告 commit 等待 user 验收。
---

# tent-role

当 agent 要进入或恢复一顶现有 Tent 里的长期 role session 时使用。

## 模型

- Tent 用普通文件保存意图、上下文、状态和协作管道；Tent 本身不使用 Git。
- 一顶 Tent 只指向一个真实 workspace。真实代码、commit、branch、worktree 都发生在 workspace。
- 一个 role 是一个长期 session，并复用一个 workspace `worktree + branch`。一个 role 可以处理多个 box。
- 一个 box 是一个文件夹加同名 Markdown 身份笔记。`bx-` id 随移动保持稳定。层级表达服务关系。
- `manifest.yml` 解析 claim、readable、writable。它是 honor contract，不是安全沙箱。若任务指令和 manifest 边界冲突，停止并询问 user。
- report 首先是聊天回复。`tent report` 只是在 Tent 里放一份临时传输文本，供 user 在 UI 里验收；它没有持久 id，验收或中断后会清理。

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
- `prompt`：范围最大，用于任务说明、上下文、问题、决策点、检查清单、review 发现、后续待办、handoff 意图，以及大多数 user/agent 协作文本。
- `output`：用于产出或产出指针。产出可以是代码仓、文档、release、npm 包、截图、构建物、handoff 文件、workspace 指针等，重点是它代表或指向某个交付物。

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
- 具体代码、文档、release、npm 包、截图、构建物、handoff 文件等 output，优先创建在对应处理 box 的子级中。
- output 笔记可以写 `workspace`、`ref`、`path` 或 `paths`，用于指向真实 workspace 的 commit、文件或目录。
- 不要把普通任务记录写成 output；只有它代表或指向一个可验收产物时才使用 output。

## 协议

1. 确认工作目录就是 Tent 根目录，且包含 `RULES.md`、`.tent/`、`temp/`。否则停止并告诉 user。
2. 新 role session 只读一次 `temp/<role>/init.md`。它是稳定 role 上下文，设计上用于 prompt cache 复用。
3. 读取 user 给你的 task Markdown 路径，再读其中指向的 manifest、box 指针、user prompt，以及 user 明确选择的 handoff 指针。
4. 如果 user 没有给 task 文件而是在会话里直接口头指派（ad-hoc），照常工作：读 `RULES.md` 与所需上下文，只在既有授权或 user 明示的范围内写 Tent 文件；范围拿不准就先确认，不要因为没有 task 文件而拒绝或自己发明一份。
5. 如果 task 含 handoff 指针，读取那个文件作为 agent-authored task context。不要自己扫描 `temp/` 猜 handoff，也不要替 user 选择另一个 handoff。
6. 使用 task 里的 `worktree` 作为真实代码工作目录，使用 task 里的 `branch` 作为该 role 的长期分支。后续任务复用它们。
7. 读取 `RULES.md` 和完成任务必要的 manifest-readable 上下文。只在 manifest-writable 范围内写 Tent 文件。
8. 真实 workspace 的改动按 box 或独立可验收交付分批 commit。不要 commit Tent 状态。
9. 协作命令：
   - `tent roles`：读取共享 role 注册表，再选择 handoff 目标 role。
   - `tent new-box <name> <type> [parentId]`：创建 box 并获得防撞 id。CLI 只生成空身份笔记——建完立即补写正文（问题、方案、验收标准）和 `status`，不要留空壳框。
   - `tent propose <targetId> <role> <bodyFile|->`：给 readable target 写 agent-to-user 决策文本。
   - `tent handoff <fromBoxId> <targetId> <targetRole> <promptFile|->`：创建不可变 agent-to-agent prompt 指针，携带目标 box 和目标 role。它不改变 owner，也不 dispatch。user 后续派活时选择这个 handoff。
   - `tent fork <boxId>`：复制子树，只改变根名称，重发 ids，并清 owner/status。
10. 收尾时在聊天里报告：改了什么、还剩什么、跑了什么测试、workspace commit hash。报告只写你**实际验证过**的事实——测试贴运行结果，修复贴复现前后对比；命令打了 ✓ 不等于结果发生了，关键动作要回读状态确认。若有待 UI 验收的交付，用 `tent report <boxId> <bodyFile|-> --commits <sha,sha>` 提交同一份报告。

不要自己把 box 标记完成。只有 user 确认后，交付才算完成。

proposal 被采纳不会自动启动 agent。handoff 创建不会派活或转移 owner。`tent complete`、`tent stamp` 和 `tent force-release` 是 user 侧动作，除非 user 在会话中明确豁免。
