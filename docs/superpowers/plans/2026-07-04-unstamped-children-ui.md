# Unstamped Children UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop showing false "未盖章" warnings and let users optionally stamp direct statusless children when accepting a parent.

**Architecture:** Keep lifecycle semantics in core unchanged. Add pure selection helpers to the plugin UI model, then let the existing triage view call the existing `stamp` operation for user-selected direct children after the parent report is accepted.

**Tech Stack:** TypeScript, Obsidian plugin DOM APIs, Node test runner.

---

### Task 1: UI lifecycle helpers

**Files:**
- Modify: `src/plugin/ui-model.ts`
- Test: `test/plugin.test.ts`

- [x] Add failing tests proving that the warning is shown only when a box has explicit `status` or current `owner`, and that only direct children without `status` are batch candidates.
- [x] Run `npm test -- --test-name-pattern="plugin ui-model:lifecycle"` and confirm the new assertions fail because the helpers do not exist.
- [x] Implement `showsUnstampedState` and `statuslessDirectChildren` as pure helpers.
- [x] Re-run the focused tests and confirm they pass.

### Task 2: Output warning and batch confirmation UI

**Files:**
- Modify: `src/plugin/view.ts`
- Modify: `styles.css`
- Test: `test/plugin.test.ts`

- [x] Use `showsUnstampedState` to omit the lifecycle pill for untouched output records.
- [x] Before accepting a ready report, show an inline checklist when `statuslessDirectChildren` returns candidates.
- [x] Let cancel continue with parent-only acceptance and let confirm stamp each selected child after the parent succeeds.
- [x] Keep the checklist in the existing triage surface and style it with existing Tent colors and compact controls.
- [x] Run `npm run check` and confirm typecheck, build, tests, and OKF validation pass.

### Task 3: Delivery

**Files:**
- Create: Tent report under `temp/规划型老二/reports/`

- [x] Commit the workspace changes with a Conventional Commit message.
- [x] Submit a Tent report for `bx-xxfmje` with the commit hash.
