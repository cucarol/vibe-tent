# Output Cascade Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete direct output delivery records automatically whenever their parent delivery box is accepted.

**Architecture:** Core owns candidate selection, conflict validation, and mutation order. CLI and Obsidian call the same core APIs; CLI may opt out with `--no-cascade`, while UI keeps the default. Tests exercise real box files and CLI processes before implementation changes.

**Tech Stack:** TypeScript, Node.js test runner, filesystem adapters, esbuild, Obsidian plugin bundle.

---

### Task 1: Synchronize The Role Branch

**Files:**
- No source files

- [ ] **Step 1: Confirm the worktree is clean**

Run:

```powershell
git status --short --branch
git log --left-right --cherry-pick --oneline main...HEAD
```

Expected: no working-tree changes; only the documented role commits and current
main protocol commit differ.

- [ ] **Step 2: Merge current main**

Run:

```powershell
git merge --no-edit main
```

Expected: a clean merge that imports the latest role/genesis protocol changes
without rewriting role commit hashes.

### Task 2: Add Failing Core Cascade Tests

**Files:**
- Modify: `test/core.test.ts`
- Test: `test/core.test.ts`

- [ ] **Step 1: Add direct and non-direct output fixtures in the test**

Release the pre-owned fixture box, create children, then reclaim the parent so
the completion state matches production:

```ts
await forceRelease(env as any, "bx-g2");
await createBox(env as any, {
  parentPath: "goal/挖新alpha/写表达式",
  name: "delivery record",
  type: "output",
});
await createBox(env as any, {
  parentPath: "goal/挖新alpha/写表达式",
  name: "reference record",
  type: "output-reference",
});
const followupId = await createBox(env as any, {
  parentPath: "goal/挖新alpha/写表达式",
  name: "followup",
  type: "prompt",
});
await createBox(env as any, {
  parentPath: "goal/挖新alpha/写表达式/followup",
  name: "nested output",
  type: "output",
});
await dispatch(env as any, "bx-g2", "executor", "complete fixture");
```

Call `completeClaim(env, "bx-g2")`, reload the Tent, and assert:

```ts
assert.equal(after.byPath.get("goal/挖新alpha/写表达式/delivery record")!.fm.status, "done");
assert.equal(after.byPath.get("goal/挖新alpha/写表达式/reference record")!.fm.status, "done");
assert.equal(after.byId.get(followupId)!.fm.status, undefined);
assert.equal(after.byPath.get("goal/挖新alpha/写表达式/followup/nested output")!.fm.status, undefined);
```

- [ ] **Step 2: Add conflict and opt-out tests**

For the conflict fixture, release `bx-g2`, create a direct output child, and
dispatch that child to `reviewer`. Assert completing `bx-g2` rejects and the
parent remains `todo`. In a separate reclaimed-parent fixture, call:

```ts
await completeClaim(env as any, "bx-g2", { cascadeOutputs: false });
```

Assert the parent is done and the direct output remains without status.

Add an archived direct output and two raw direct output notes sharing one id.
Reload to establish archived and duplicate-invalid states, complete the parent,
and assert none of those note frontmatters gains `status: done`.

Add a direct output to the existing integration-failure test in
`test/workspace.test.ts`; after the callback throws, assert both parent and
output retain their original statuses.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```powershell
node --test --import tsx test/core.test.ts
```

Expected: cascade assertions fail because output child statuses are undefined,
the owned-child completion does not reject, and the new options-object call is
not yet supported.

### Task 3: Implement Core Completion Options

**Files:**
- Modify: `src/core/ops.ts`
- Modify: `test/workspace.test.ts`
- Modify: `test/collaboration.test.ts`
- Test: `test/core.test.ts`
- Test: `test/workspace.test.ts`
- Test: `test/collaboration.test.ts`

- [ ] **Step 1: Introduce shared completion options**

Add:

```ts
export interface CompletionOptions {
  cascadeOutputs?: boolean;
}

export interface CompleteClaimOptions extends CompletionOptions {
  integrate?: () => Promise<void>;
}

export interface AcceptReportOptions extends CompletionOptions {
  commits?: string[];
  integrate?: (commits: string[]) => Promise<void>;
}
```

Change `stamp` and `completeClaim` to accept options objects. Update existing
integration callers from a bare callback to `{ integrate: callback }`.

- [ ] **Step 2: Add one private cascade helper**

Import `splitType` and add:

```ts
function directOutputRecords(box: Box): Box[] {
  const candidates = box.children.filter(
    (child) =>
      !child.archived &&
      !child.invalid &&
      splitType(child.type).base === "output"
  );
  const occupied = candidates.find((child) => child.fm.owner);
  if (occupied) {
    throw new Error(`output 记录框 ${occupied.id} 已被 ${occupied.fm.owner} 认领`);
  }
  return candidates;
}

async function markComplete(
  fs: FsAdapter,
  box: Box,
  cascadeOutputs: boolean
): Promise<void> {
  if (cascadeOutputs) {
    for (const child of directOutputRecords(box)) {
      if (child.fm.status !== "done") await setOwner(fs, child, undefined, "done");
    }
  }
  await setOwner(fs, box, undefined, "done");
}
```

Both `completeClaim` and `acceptReport` call this helper after integration and
before report removal, using `options.cascadeOutputs !== false`.

- [ ] **Step 3: Run focused core tests and verify GREEN**

Run:

```powershell
node --test --import tsx test/core.test.ts test/workspace.test.ts test/collaboration.test.ts
```

Expected: all focused tests pass, including integration-failure ordering.

- [ ] **Step 4: Commit core behavior**

```powershell
git add src/core/ops.ts test/core.test.ts test/workspace.test.ts test/collaboration.test.ts
git commit -m "feat(core): cascade completion to output records"
```

### Task 4: Add CLI Opt-Out Coverage And Wiring

**Files:**
- Modify: `src/cli/tent.ts`
- Modify: `test/package.test.ts`
- Test: `test/package.test.ts`

- [ ] **Step 1: Add failing CLI assertions**

Extend the completion fixture with a direct output child. Assert default
`complete` and `stamp` mark it done. Add fresh fixtures invoking:

```ts
await runCli(tent, "complete", boxId, "--no-cascade");
await runCli(tent, "stamp", boxId, "--no-cascade");
```

Assert the parent is done and the output child remains without status.

- [ ] **Step 2: Run package tests and verify RED**

Run:

```powershell
npm test
```

Expected: CLI opt-out assertions fail because `no-cascade` is not parsed or
forwarded.

- [ ] **Step 3: Wire the flag**

Add `"no-cascade"` to `parseFlags` boolean flags. In `complete`, pass:

```ts
const cascadeOutputs = flags["no-cascade"] !== "true";
```

to `acceptReport` or `completeClaim`. Parse flags in `stamp` and call:

```ts
await stamp(env, boxId, { cascadeOutputs });
```

Update `helpText()` so `complete` and `stamp` show `[--no-cascade]`.

- [ ] **Step 4: Run package tests and verify GREEN**

Run:

```powershell
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Build and commit CLI wiring**

```powershell
npm run build
git add src/cli/tent.ts test/package.test.ts cli.mjs main.js
git commit -m "feat(cli): allow disabling output cascade"
```

### Task 5: Specify, Verify, And Deliver

**Files:**
- Modify: `docs/SPEC.md`
- Modify: `test/open-source.test.ts`

- [ ] **Step 1: Add the lifecycle contract**

Document in SPEC section 5 that one explicit completion action also marks
eligible direct output records done by default, without introducing status
inheritance, and that CLI callers may opt out.

- [ ] **Step 2: Lock documentation with a release test**

Add an assertion in `test/open-source.test.ts` matching the phrases
`direct output records` and `--no-cascade`.

- [ ] **Step 3: Run complete verification**

Run:

```powershell
npm run check
git diff --check
git status --short --branch
```

Expected: typecheck, production build, every test, and OKF validation pass; the
worktree contains only the intended documentation changes before commit.

- [ ] **Step 4: Commit documentation**

```powershell
git add docs/SPEC.md test/open-source.test.ts
git commit -m "docs(spec): define output completion cascade"
```

- [ ] **Step 5: Create the Tent output and report**

Create an `output` child under `bx-pm7fht` pointing at the implementation
commits and modified paths. Submit one report bound to all implementation
commits. Do not complete the box; user confirmation remains authoritative.
