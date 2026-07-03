# Pending Dispatch UX Design

## Problem

Dispatch creates an immutable task envelope and immediately assigns the box to
a role. Tent cannot currently distinguish "task created" from "relay prompt
delivered to the agent session". When automatic clipboard copy is disabled, or
dispatch is run through the CLI, the UI gives the user no next action and the
global triage count remains unchanged.

## Boundary

This change does not add the future A2A `pending -> taken` lifecycle. Task
envelopes remain immutable. The plugin records only whether the user has copied
a task's relay prompt from this Obsidian installation.

## Data Flow

1. Core scans `temp/<role>/tasks/*.md` into read-only task-envelope records and
   can reconstruct the canonical relay prompt from a task path and role.
2. The plugin selects the newest task for each claimed box where the box is
   still owned by the task's role.
3. A task is pending delivery when its plugin acknowledgement key is absent.
   Keys include the Tent name and task path.
4. Automatic clipboard copy after UI dispatch acknowledges the new task.
   CLI-created tasks remain pending until copied from the triage panel.
5. Acknowledgements live in plugin settings, survive restarts, and are not Tent
   workflow state.

## UI

For a box with a pending dispatch, the triage tab shows:

- section title `等待投递`;
- `等待投递给 <role>`;
- one sentence explaining that the relay prompt should be pasted into that
  role's agent session;
- a `复制投递 prompt` action.

Successful copy acknowledges the task, refreshes the panel, and removes its
notification. Pending dispatches contribute to the tree badge, collapsed
ancestor aggregation, and the plugin's global triage count.

After acknowledgement, the existing `处理中` presentation returns. Proposal
and report behavior is unchanged.

## Selection Rules

- Old tasks for the same box never reappear when a newer task exists.
- Released, completed, archived, invalid, missing, or differently owned boxes
  do not produce pending-dispatch entries.
- One task claiming multiple boxes yields one entry per currently matching box;
  acknowledging its path clears all of those entries.
- Root claims are omitted because the current tree has no root triage surface.

## Verification

Tests cover task loading and relay reconstruction, newest-task selection,
acknowledgement filtering, owner mismatch, and global count composition. Manual
verification uses a CLI-dispatched box so the pending entry exists before copy
and disappears immediately after the action.
