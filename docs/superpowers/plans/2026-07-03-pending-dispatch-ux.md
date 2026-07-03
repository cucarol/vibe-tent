# Pending Dispatch UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make relay prompts waiting for user delivery visible, copyable, and
counted as triage without adding workflow state to immutable task files.

**Architecture:** Extend the existing task module with a read-only loader and
relay-prompt formatter. Add a pure plugin model that selects the newest task
matching each current owner and filters plugin-local acknowledgements. Wire the
model into refresh, badges, status count, and the triage tab.

**Tech Stack:** TypeScript, Obsidian plugin API, Node test runner.

---

### Task 1: Read task envelopes

**Files:**
- Modify: `src/core/task.ts`
- Test: `test/core.test.ts`

- [ ] **Step 1: Write a failing loader test**

Create two task files under different roles, plus one malformed file. Assert
that `loadTaskEnvelopes` returns only the valid records with `path`, `role`,
`claims`, and `manifest`, ordered by path. Assert `relayPromptForTask` includes
the task path and derived `temp/<role>/init.md`.

- [ ] **Step 2: Run the focused core test and verify RED**

```text
node --test --import tsx test/core.test.ts
```

Expected: failure because the two exports do not exist.

- [ ] **Step 3: Implement the read-only API**

```ts
export interface TaskEnvelope {
  path: string;
  role: string;
  claims: string[];
  manifest: string;
}

export async function loadTaskEnvelopes(fs: FsAdapter): Promise<TaskEnvelope[]> {
  // Scan temp/<role>/tasks/*.md, parse valid type: task documents, and sort.
}

export function relayPromptForTask(task: TaskEnvelope): string {
  const initPath = join("temp", task.role, "init.md");
  return `读取 ${task.path} 并执行。若这是该 role 的新会话,先按 ${initPath} 完成 role init；` +
    `是否复用旧会话由 user 决定。`;
}
```

- [ ] **Step 4: Replace dispatch's inline relay formatting**

Use `relayPromptForTask({ path: taskPath, role: roleName, claims: ..., manifest:
manifestPath })` so CLI and plugin reconstruction cannot drift.

- [ ] **Step 5: Run the focused core test and verify GREEN**

Expected: all core tests pass.

### Task 2: Select pending task deliveries

**Files:**
- Create: `src/plugin/pending-dispatch.ts`
- Modify: `src/plugin/main.ts`
- Test: `test/plugin.test.ts`

- [ ] **Step 1: Write failing pure-model tests**

Cover:

```ts
pendingDispatches(tasks, new Set(), ownerFor)
```

The test must prove that the newest task wins per box, acknowledged paths are
filtered, mismatched owners are ignored, and one multi-claim task can produce
multiple box entries.

- [ ] **Step 2: Run plugin tests and verify RED**

```text
node --test --import tsx test/plugin.test.ts
```

Expected: module/export missing.

- [ ] **Step 3: Implement the pure selector**

Export:

```ts
export interface PendingDispatch {
  boxId: string;
  task: TaskEnvelope;
}

export function dispatchAckKey(tentName: string, taskPath: string): string;
export function pendingDispatches(
  tasks: TaskEnvelope[],
  acknowledged: ReadonlySet<string>,
  ownerFor: (boxId: string) => string | undefined,
  tentName: string
): PendingDispatch[];
```

Select the newest task for each non-root claim before acknowledgement
filtering.

- [ ] **Step 4: Persist acknowledgement keys in plugin settings**

Add `acknowledgedDispatchTasks: string[]` to settings defaults and normalized
loading. Add:

```ts
isDispatchTaskAcknowledged(tentName: string, taskPath: string): boolean;
async acknowledgeDispatchTask(tentName: string, taskPath: string): Promise<void>;
```

Deduplicate keys and retain only the newest 500.

- [ ] **Step 5: Verify plugin tests GREEN**

Run the focused plugin test command.

### Task 3: Render and count pending deliveries

**Files:**
- Modify: `src/plugin/view.ts`
- Test: `test/plugin.test.ts`

- [ ] **Step 1: Load tasks and build per-box pending entries**

During refresh, load task envelopes, derive pending entries from current box
owners, and group them by `boxId`.

- [ ] **Step 2: Count pending entries**

Add each box's pending entry count to `boxTriageCount`. Add the total pending
entry count to `plugin.updateStatus`, alongside proposals and ready reports.
The existing collapsed-tree aggregation then includes hidden pending entries.

- [ ] **Step 3: Render the waiting state and copy action**

Before the existing owner-only `处理中` state, render `等待投递` with:

```text
等待投递给 <role>
复制投递 prompt，粘贴到该 role 的 agent 会话即可开工。
```

The `复制投递 prompt` button writes the canonical relay prompt with the
absolute Tent-root pointer, acknowledges the task, refreshes, and shows a
notice.

- [ ] **Step 4: Acknowledge automatic clipboard delivery**

After UI dispatch successfully copies `r.relayPrompt`, call
`acknowledgeDispatchTask(this.tentName, r.taskPath)` before refresh. When
automatic copy is disabled, leave the task pending.

- [ ] **Step 5: Run full verification**

```text
npm run check
```

Expected: typecheck, build, all tests, and OKF validation pass.

- [ ] **Step 6: Commit**

```text
git add src/core/task.ts src/core/ops.ts src/plugin/pending-dispatch.ts \
  src/plugin/main.ts src/plugin/view.ts test/core.test.ts test/plugin.test.ts main.js
git commit -m "feat(ui): surface pending dispatch delivery"
```
