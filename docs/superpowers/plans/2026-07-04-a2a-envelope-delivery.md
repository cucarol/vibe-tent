# A2A Envelope Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make task envelopes the only dispatch prompt and consumption source, remove handoff, and place pending delivery in the dispatch UI.

**Architecture:** Core dispatch requires a user prompt and emits a pending task envelope. Relay prompt rendering receives the absolute Tent root from the CLI or plugin caller; only `task-ack` changes an envelope to `taken`. The plugin renders pending envelopes in the dispatch tab and treats copying as a transport helper, not consumption.

**Tech Stack:** TypeScript, Node test runner, Obsidian plugin DOM APIs, esbuild.

---

### Task 1: Remove handoff and rewrite relay prompts

**Files:**
- Delete: `src/core/handoff.ts`
- Modify: `src/core/task.ts`
- Modify: `src/core/ops.ts`
- Modify: `src/core/collaborationOps.ts`
- Modify: `src/core/manifest.ts`
- Modify: `src/cli/tent.ts`
- Test: `test/core.test.ts`
- Test: `test/collaboration.test.ts`
- Test: `test/package.test.ts`

- [x] Add failing tests that require `writeTaskEnvelope` to reject an empty user prompt and require `relayPromptForTask(task, absoluteRoot)` to start with:

```text
Tent task dispatched to role <role>.
Tent root: <absolute tent path>
1. Run `tent task-ack <task path>` to take this task.
```

- [x] Run the focused core/package tests and confirm the old Chinese relay prompt and handoff fallback fail the assertions.
- [x] Remove `handoffPath` from task and dispatch inputs, delete handoff validation/creation, and remove the CLI command and flag.
- [x] Pass `process.cwd()` from CLI dispatch and the plugin's absolute Tent root from plugin dispatch.
- [x] Re-run focused tests and confirm peer, sub-mode, and idempotent task-ack fixtures pass.

### Task 2: Move pending delivery into the dispatch tab

**Files:**
- Modify: `src/plugin/view.ts`
- Modify: `src/plugin/main.ts`
- Modify: `src/plugin/pending-dispatch.ts`
- Test: `test/plugin.test.ts`

- [x] Add failing UI-model tests proving pending entries depend only on envelope `status` and that tab counts separate pending dispatches from triage items.
- [x] Remove plugin-local acknowledgment from every copy action.
- [x] Render pending delivery at the top of the dispatch tab with the copy action and the user-facing session-choice hint.
- [x] Render `派活 (N)` and `待裁 (M)` per selected box; keep the global status count aggregated.
- [x] Re-run plugin tests and typecheck.

### Task 3: Remove stale public handoff surfaces

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `skills/tent-role/SKILL.md`
- Modify: `skills/tent-genesis/SKILL.md`
- Preserve: `docs/SPEC.md` until Batch B, as required by the approved A2A design.

- [x] Remove handoff commands and descriptions from README/package metadata.
- [x] Update the bundled role skill to scan pending task envelopes on wake, run `tent task-ack` before work, and stop referring to handoff files.
- [x] Remove generic handoff examples from the genesis skill without changing type semantics.
- [x] Verify `rg -i handoff src/` returns no matches.
- [x] Run `npm run check`, commit this Batch A delta, and submit a report for `bx-3bjw7g`.
