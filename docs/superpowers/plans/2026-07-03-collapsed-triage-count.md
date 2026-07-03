# Collapsed Triage Count Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep descendant triage notifications visible on a parent row while its subtree is collapsed.

**Architecture:** Add one pure tree-counting helper to `ui-model.ts`, then let
`drawNode` choose between direct and subtree counts based on its existing
collapsed state. Reuse the current proposal/report counting callback and badge.

**Tech Stack:** TypeScript, Obsidian plugin DOM API, Node test runner.

---

### Task 1: Pure visible-count helper

**Files:**
- Modify: `src/plugin/ui-model.ts`
- Test: `test/plugin.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test with a root, child, and grandchild that asserts an expanded root
returns only its direct count while a collapsed root returns the recursive sum:

```ts
const grandchild = { id: "grandchild", children: [] };
const child = { id: "child", children: [grandchild] };
const root = { id: "root", children: [child] };
const counts = new Map([["root", 1], ["child", 2], ["grandchild", 3]]);
const direct = (box: { id: string }) => counts.get(box.id) ?? 0;

assert.equal(visibleTreeCount(root, false, direct), 1);
assert.equal(visibleTreeCount(root, true, direct), 6);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```text
node --test --import tsx test/plugin.test.ts
```

Expected: failure because `visibleTreeCount` is not exported.

- [ ] **Step 3: Implement the minimal helper**

```ts
export interface TreeCountNode {
  children: TreeCountNode[];
}

export function visibleTreeCount<T extends TreeCountNode>(
  node: T,
  collapsed: boolean,
  directCount: (node: T) => number
): number {
  if (!collapsed) return directCount(node);
  return directCount(node) +
    node.children.reduce(
      (total, child) =>
        total + visibleTreeCount(child as T, true, directCount),
      0
    );
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same command. Expected: all plugin tests pass.

### Task 2: Use the helper in tree rendering

**Files:**
- Modify: `src/plugin/view.ts`

- [ ] **Step 1: Replace the exact-box badge count**

Import `visibleTreeCount`, then compute:

```ts
const pend = visibleTreeCount(box, isCollapsed, (item) =>
  this.boxTriageCount(item as Box)
);
```

When `isCollapsed` is true, set the tooltip to
`N 待裁（含子级）`; otherwise retain `N 待裁`.

- [ ] **Step 2: Run verification**

Run:

```text
npm run check
```

Expected: typecheck, build, all tests, and OKF validation pass.

- [ ] **Step 3: Commit**

```text
git add src/plugin/ui-model.ts src/plugin/view.ts test/plugin.test.ts
git commit -m "fix(ui): surface child triage on collapsed boxes"
```
