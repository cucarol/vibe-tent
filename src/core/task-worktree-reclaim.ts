// Terminal Task worktree reclaim (V0.2).
// Role worktrees stay durable. Code Task lanes (tent-task/<id>) are temporary.
// Auto-remove only when Task is terminal, required integrate/settle is done,
// the lane is clean, and ownership/path/branch are unambiguous.
// Never deletes Git commits, branches, or Tent Task/Session/Delivery records.
// Idempotent, restart-safe, fail-closed with diagnostics. No historical mass-clean.

import type { FsAdapter } from "./adapter.js";
import { loadDeliveries, type DeliveryRecord } from "./delivery.js";
import {
  isActiveTaskState,
  TERMINAL_TASK_STATES,
  type TaskState,
} from "./task-model.js";
import {
  taskAssigneeKind,
  type TaskEnvelope,
} from "./task.js";
import {
  expectedTaskWorktreePath,
  findIntegratedCommit,
  inspectWorktreeDirtiness,
  isGitWorkspace,
  isSameWorkspaceRoot,
  taskWorktreeBranchName,
} from "./workspace.js";
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import { spawn } from "node:child_process";

/** Stable machine codes for reclaim preview / auto-reclaim diagnostics. */
export type TaskWorktreeReclaimCode =
  | "RECLAIMABLE"
  | "RECLAIMED"
  | "ALREADY_GONE"
  | "NOT_APPLICABLE"
  | "NOT_TERMINAL"
  | "DIRTY"
  | "UNINTEGRATED"
  | "SESSION_ACTIVE"
  | "AMBIGUOUS_OWNERSHIP"
  | "EXTERNAL_OR_UNEXPECTED_PATH"
  | "CONFLICTED_REGISTRATION"
  | "REMOVE_FAILED";

export type TaskWorktreeReclaimDiagnostic = {
  /** True only when the exact Task worktree may be removed safely now. */
  eligible: boolean;
  code: TaskWorktreeReclaimCode;
  reason: string;
  taskId?: string;
  taskPath?: string;
  taskState?: TaskState;
  workspace?: string;
  worktree?: string;
  branch?: string;
  targetBranch?: string;
  /** Extra structured facts for operators / tests (never free-form paths to delete). */
  details?: Record<string, unknown>;
};

export type TaskWorktreeReclaimResult = TaskWorktreeReclaimDiagnostic & {
  /** True when this call removed the worktree directory / registration (or it was already gone). */
  reclaimed: boolean;
  /** True when a prior call already left nothing to remove. */
  alreadyGone: boolean;
};

export type EvaluateTaskWorktreeReclaimInput = {
  /** Mounted Git workspace root (not a nested path). */
  workspaceRoot: string;
  task: TaskEnvelope;
  /**
   * Optional deliveries for settle checks. When omitted and the Task is
   * `accepted` with an id, callers should load via FsAdapter (see evaluate with fs).
   */
  deliveries?: DeliveryRecord[];
};

export type ReclaimTaskWorktreeInput = EvaluateTaskWorktreeReclaimInput & {
  /** When true, only evaluate — never call git worktree remove. */
  preview?: boolean;
  /**
   * Test-only TOCTOU hook: runs after evaluate eligibility succeeds and before
   * any registration re-check / git worktree remove. Production never sets this.
   */
  beforeRemoveForTests?: () => void | Promise<void>;
  /**
   * Test-only: replace Node directory removal used for junction-safe lane delete.
   * Production never sets this. Used to prove fail-closed when fs.rm is refused
   * (registration must remain untouched).
   */
  rmLaneDirectoryForTests?: (lanePath: string) => void | Promise<void>;
  /**
   * Service settle re-probe: called immediately before any git worktree remove
   * (and before force metadata drop). Fail-closed → map to SESSION_ACTIVE so a
   * late turnBusy/alive/open Session after evaluate still defers remove.
   * Production auto-reclaim always supplies this under the per-Task lifecycle lock.
   */
  assertSessionSettledBeforeRemove?: () =>
    | Promise<
        | { ok: true }
        | { ok: false; reason: string; details?: Record<string, unknown> }
      >
    | { ok: true }
    | { ok: false; reason: string; details?: Record<string, unknown> };
};

/**
 * True when Task state is collaboration-terminal and no longer occupies a box.
 * `delivered` is intentionally excluded (still active occupation / review).
 */
export function isTaskWorktreeReclaimTerminalState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.has(state) && !isActiveTaskState(state);
}

/**
 * Role lanes are durable and never enter Task worktree GC.
 * Only agentProfile code Task lanes use temporary tent-task/* worktrees.
 */
export function isTaskScopedWorktreeLane(task: TaskEnvelope): boolean {
  return taskAssigneeKind(task) === "agentProfile";
}

/**
 * Read-only eligibility for reclaiming one Task's temporary Git worktree.
 * Fail-closed: any dirty / unintegrated / ambiguous / non-terminal condition refuses.
 */
export async function evaluateTaskWorktreeReclaim(
  input: EvaluateTaskWorktreeReclaimInput
): Promise<TaskWorktreeReclaimDiagnostic> {
  const task = input.task;
  const base = {
    taskId: task.id,
    taskPath: task.path,
    taskState: task.state,
    workspace: task.workspace,
    worktree: task.worktree,
    branch: task.branch,
    targetBranch: task.targetBranch,
  };

  // Durable role lanes are never auto-reclaimed.
  if (!isTaskScopedWorktreeLane(task)) {
    return {
      ...base,
      eligible: false,
      code: "NOT_APPLICABLE",
      reason:
        "Role worktrees are durable integration lanes; Task worktree reclaim applies only to agentProfile code Task lanes.",
    };
  }

  const hasLane = Boolean(
    task.worktree?.trim() || task.branch?.trim() || task.workspace?.trim()
  );
  if (!hasLane) {
    return {
      ...base,
      eligible: false,
      code: "NOT_APPLICABLE",
      reason: "Task has no recorded Git workspace lane (pure Tent / docs task).",
    };
  }

  if (!isTaskWorktreeReclaimTerminalState(task.state)) {
    return {
      ...base,
      eligible: false,
      code: "NOT_TERMINAL",
      reason: `Task state=${task.state} is not terminal for worktree reclaim (need accepted|rejected|interrupted|failed).`,
    };
  }

  const taskId = (task.id || "").trim();
  if (!taskId) {
    return {
      ...base,
      eligible: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: "Task envelope is missing a stable task id; refusing worktree reclaim.",
    };
  }

  const workspaceRoot = nodePath.resolve(input.workspaceRoot);
  if (!(await isGitWorkspace(workspaceRoot))) {
    return {
      ...base,
      eligible: false,
      code: "NOT_APPLICABLE",
      reason: "Mounted workspace is not a Git root; no Task worktree to reclaim.",
    };
  }

  if (task.workspace?.trim()) {
    const claimed = nodePath.resolve(task.workspace);
    if (!isSameWorkspaceRoot(claimed, workspaceRoot)) {
      return {
        ...base,
        eligible: false,
        code: "AMBIGUOUS_OWNERSHIP",
        reason: `Task envelope workspace mismatch: envelope=${task.workspace} mounted=${workspaceRoot}`,
        details: { claimedWorkspace: claimed, mountedWorkspace: workspaceRoot },
      };
    }
  }

  const expectedBranch = taskWorktreeBranchName(taskId);
  const expectedPath = expectedTaskWorktreePath(workspaceRoot, taskId);

  if (task.branch?.trim() && task.branch.trim() !== expectedBranch) {
    return {
      ...base,
      eligible: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: `Task branch ${task.branch} is not the expected Task lane ${expectedBranch}.`,
      details: { expectedBranch },
    };
  }

  // Role-shaped branch names must never be reclaimed via this path.
  if (task.branch?.trim().startsWith("tent-role/")) {
    return {
      ...base,
      eligible: false,
      code: "NOT_APPLICABLE",
      reason: "Envelope branch is a durable tent-role/* lane; refusing Task worktree reclaim.",
    };
  }

  let resolvedWorktree: string | undefined;
  if (task.worktree?.trim()) {
    resolvedWorktree = nodePath.resolve(task.worktree.trim());
    const expectedResolved = nodePath.resolve(expectedPath);
    // Compare after realpath when both exist; otherwise path-normalize only.
    let same = isSameWorkspaceRoot(resolvedWorktree, expectedResolved);
    if (!same) {
      try {
        const [realClaimed, realExpected] = await Promise.all([
          nodeFs.realpath(resolvedWorktree).catch(() => resolvedWorktree!),
          nodeFs.realpath(expectedResolved).catch(() => expectedResolved),
        ]);
        same = isSameWorkspaceRoot(realClaimed, realExpected);
      } catch {
        same = false;
      }
    }
    if (!same) {
      return {
        ...base,
        eligible: false,
        code: "EXTERNAL_OR_UNEXPECTED_PATH",
        reason: `Task worktree path is not the exact expected Task lane directory.`,
        details: {
          envelopeWorktree: resolvedWorktree,
          expectedWorktree: expectedResolved,
        },
      };
    }
  } else {
    resolvedWorktree = nodePath.resolve(expectedPath);
  }

  // Never treat the main workspace root as a Task worktree.
  if (isSameWorkspaceRoot(resolvedWorktree, workspaceRoot)) {
    return {
      ...base,
      eligible: false,
      code: "EXTERNAL_OR_UNEXPECTED_PATH",
      reason: "Refusing to reclaim the main workspace root as a Task worktree.",
      worktree: resolvedWorktree,
    };
  }

  // Must live under the sibling `<basename>-worktrees/task-*` layout.
  const worktreesRoot = nodePath.resolve(
    nodePath.dirname(workspaceRoot),
    `${nodePath.basename(workspaceRoot)}-worktrees`
  );
  const rel = nodePath.relative(worktreesRoot, resolvedWorktree);
  if (
    !rel ||
    rel.startsWith("..") ||
    nodePath.isAbsolute(rel) ||
    rel.split(nodePath.sep).length !== 1 ||
    !rel.startsWith("task-")
  ) {
    return {
      ...base,
      eligible: false,
      code: "EXTERNAL_OR_UNEXPECTED_PATH",
      reason: `Worktree path is outside the Task worktrees root or is not a task-* directory: ${resolvedWorktree}`,
      worktree: resolvedWorktree,
      details: { worktreesRoot },
    };
  }

  const registration = await inspectWorktreeRegistration(workspaceRoot, resolvedWorktree);
  const branchRegistration = await worktreePathForBranch(workspaceRoot, expectedBranch);

  const pathExistsOnDisk = await pathExists(resolvedWorktree);
  const registeredHere =
    registration.registered &&
    registration.branch === expectedBranch;

  // Idempotent already-gone: nothing on disk and no registration for this branch/path.
  if (!pathExistsOnDisk && !registration.registered && !branchRegistration) {
    return {
      ...base,
      eligible: true,
      code: "ALREADY_GONE",
      reason: "Task worktree directory and Git registration are already absent (idempotent no-op).",
      worktree: resolvedWorktree,
      branch: expectedBranch,
    };
  }

  // Branch registered at a different path → ambiguous / conflicted.
  if (branchRegistration) {
    const branchPath = nodePath.resolve(branchRegistration);
    if (!isSameWorkspaceRoot(branchPath, resolvedWorktree)) {
      let same = false;
      try {
        const [a, b] = await Promise.all([
          nodeFs.realpath(branchPath).catch(() => branchPath),
          nodeFs.realpath(resolvedWorktree).catch(() => resolvedWorktree!),
        ]);
        same = isSameWorkspaceRoot(a, b);
      } catch {
        same = false;
      }
      if (!same) {
        return {
          ...base,
          eligible: false,
          code: "CONFLICTED_REGISTRATION",
          reason: `Branch ${expectedBranch} is registered at a different worktree path.`,
          worktree: resolvedWorktree,
          branch: expectedBranch,
          details: { registeredPath: branchPath },
        };
      }
    }
  }

  if (registration.registered) {
    if (registration.branch && registration.branch !== expectedBranch) {
      return {
        ...base,
        eligible: false,
        code: "CONFLICTED_REGISTRATION",
        reason: `Worktree at ${resolvedWorktree} is registered to ${registration.branch}, expected ${expectedBranch}.`,
        worktree: resolvedWorktree,
        branch: expectedBranch,
        details: { registeredBranch: registration.branch },
      };
    }
    if (!registration.branch) {
      return {
        ...base,
        eligible: false,
        code: "AMBIGUOUS_OWNERSHIP",
        reason: `Worktree at ${resolvedWorktree} is registered without a branch (detached/ambiguous); refusing reclaim.`,
        worktree: resolvedWorktree,
      };
    }
  } else if (pathExistsOnDisk) {
    // Directory exists but is not a registered worktree — fail closed (may be foreign).
    return {
      ...base,
      eligible: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: `Path ${resolvedWorktree} exists on disk but is not a registered Git worktree for ${expectedBranch}.`,
      worktree: resolvedWorktree,
      branch: expectedBranch,
    };
  }

  // Dirtiness only when the directory still exists.
  if (pathExistsOnDisk) {
    try {
      const dirty = await inspectWorktreeDirtiness(resolvedWorktree);
      if (dirty.dirty) {
        return {
          ...base,
          eligible: false,
          code: "DIRTY",
          reason: `Task worktree has uncommitted changes (${dirty.changeCount}); refusing reclaim.`,
          worktree: resolvedWorktree,
          branch: expectedBranch,
          details: {
            trackedDirty: dirty.trackedDirty,
            untrackedDirty: dirty.untrackedDirty,
            changeCount: dirty.changeCount,
            dirtySample: dirty.sample,
          },
        };
      }
    } catch (err) {
      return {
        ...base,
        eligible: false,
        code: "AMBIGUOUS_OWNERSHIP",
        reason: `Failed to inspect worktree dirtiness: ${err instanceof Error ? err.message : String(err)}`,
        worktree: resolvedWorktree,
        branch: expectedBranch,
      };
    }
  }

  // Accepted + commit-bearing deliveries must be fully settled into targetBranch.
  // Also fail-closed on any unintegrated tip still exclusive to the Task branch
  // (even when a Delivery omitted those commits).
  if (task.state === "accepted") {
    const targetBranch = (task.targetBranch || "").trim();
    const deliveries = input.deliveries ?? [];
    const settle = await evaluateAcceptedSettle({
      workspaceRoot,
      targetBranch,
      taskId,
      taskBranch: expectedBranch,
      roleBranchBase: task.roleBranchBase,
      deliveries,
    });
    if (!settle.ok) {
      return {
        ...base,
        eligible: false,
        code: settle.code,
        reason: settle.reason,
        worktree: resolvedWorktree,
        branch: expectedBranch,
        targetBranch: targetBranch || undefined,
        details: settle.details,
      };
    }
  }

  // Ready deliveries must never accompany a reclaimable terminal task.
  const ready = (input.deliveries ?? []).filter((d) => d.status === "ready" || d.status === "draft");
  if (ready.length > 0) {
    return {
      ...base,
      eligible: false,
      code: "UNINTEGRATED",
      reason: `Task still has ${ready.length} non-terminal delivery record(s); refusing worktree reclaim.`,
      worktree: resolvedWorktree,
      branch: expectedBranch,
      details: { deliveryIds: ready.map((d) => d.id) },
    };
  }

  return {
    ...base,
    eligible: true,
    code: "RECLAIMABLE",
    reason: registeredHere || pathExistsOnDisk
      ? "Terminal Task lane is clean, settled, and unambiguously owned; safe to remove worktree registration and directory."
      : "Task lane registration is residual-only; safe idempotent cleanup.",
    worktree: resolvedWorktree,
    branch: expectedBranch,
    targetBranch: task.targetBranch,
    details: {
      pathExistsOnDisk,
      registered: registration.registered,
      expectedPath,
    },
  };
}

/**
 * Evaluate + optionally remove the exact Task worktree.
 * Preserves commits and branch refs. Idempotent when already gone.
 *
 * Safety (P0):
 * - Never `git worktree remove --force` while a directory still exists.
 * - Immediately before any remove, revalidate fresh registration matches the
 *   expected exact path, branch, and branch-tip ownership (dirtiness alone is
 *   insufficient).
 * - Existing clean directory: Node `fs.rm(lane, { recursive: true, force: false })`
 *   deletes the lane tree without following junction/symlink reparse targets
 *   (link entries are unlinked only). On any rm failure, leave registration
 *   untouched and fail closed — do not call Git remove.
 * - When the directory is confirmed absent, mutate only that exact verified
 *   registration (`git worktree remove --force` on the exact path after
 *   branch/HEAD ownership match). Never non-force Git remove on a present tree
 *   that may contain outbound junctions (Git recursive delete can follow them).
 * - Never repository-global `git worktree prune` in auto-GC.
 */
export async function reclaimTaskWorktree(
  input: ReclaimTaskWorktreeInput
): Promise<TaskWorktreeReclaimResult> {
  const diagnostic = await evaluateTaskWorktreeReclaim(input);
  if (input.preview) {
    return {
      ...diagnostic,
      reclaimed: false,
      alreadyGone: diagnostic.code === "ALREADY_GONE",
    };
  }
  if (!diagnostic.eligible) {
    return { ...diagnostic, reclaimed: false, alreadyGone: false };
  }
  if (diagnostic.code === "ALREADY_GONE") {
    return {
      ...diagnostic,
      code: "ALREADY_GONE",
      reclaimed: true,
      alreadyGone: true,
    };
  }

  const workspaceRoot = nodePath.resolve(input.workspaceRoot);
  const worktree = diagnostic.worktree;
  const expectedBranch = diagnostic.branch?.trim();
  if (!worktree) {
    return {
      ...diagnostic,
      eligible: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: "Reclaim eligible but worktree path missing from diagnostic.",
      reclaimed: false,
      alreadyGone: false,
    };
  }
  if (!expectedBranch) {
    return {
      ...diagnostic,
      eligible: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: "Reclaim eligible but expected Task branch missing from diagnostic.",
      reclaimed: false,
      alreadyGone: false,
    };
  }

  try {
    // TOCTOU injection point: evaluate already succeeded; registration may change next.
    if (input.beforeRemoveForTests) {
      await input.beforeRemoveForTests();
    }

    const stillExists = await pathExists(worktree);
    // Fresh registration read — must be compared to diagnostic expected path/branch
    // before any remove (dirtiness alone is insufficient).
    const registration = await inspectWorktreeRegistration(workspaceRoot, worktree);
    if (!stillExists && !registration.registered) {
      // Race: another reclaim finished between evaluate and remove.
      return {
        ...diagnostic,
        code: "ALREADY_GONE",
        reason: "Task worktree already removed before git worktree remove (idempotent).",
        reclaimed: true,
        alreadyGone: true,
      };
    }

    // Explicit registration ↔ diagnostic expected ownership (path + branch).
    const regCompare = compareRegistrationToExpected({
      registration,
      expectedPath: worktree,
      expectedBranch,
      requireRegistered: stillExists || registration.registered,
    });
    if (!regCompare.ok) {
      return {
        ...diagnostic,
        eligible: false,
        code: regCompare.code,
        reason: regCompare.reason,
        reclaimed: false,
        alreadyGone: false,
        details: {
          ...(diagnostic.details ?? {}),
          ...(regCompare.details ?? {}),
        },
      };
    }

    // Full ownership proof (path↔branch map + tip/HEAD). Never global prune.
    const ownership = await revalidateExactWorktreeOwnership({
      workspaceRoot,
      expectedPath: worktree,
      expectedBranch,
      /** When dir is absent, skip cwd HEAD check; still require branch tip + registration. */
      requireOnDiskHead: stillExists,
    });
    if (!ownership.ok) {
      return {
        ...diagnostic,
        eligible: false,
        code: ownership.code,
        reason: ownership.reason,
        reclaimed: false,
        alreadyGone: false,
        details: {
          ...(diagnostic.details ?? {}),
          ...(ownership.details ?? {}),
        },
      };
    }

    // Directory still present → final gates, then Node-safe lane delete (does not
    // follow junction/symlink targets). Never git worktree remove while the tree
    // still exists — Git recursive delete can follow outbound reparse points.
    if (stillExists) {
      let dirty;
      try {
        dirty = await inspectWorktreeDirtiness(worktree);
      } catch (err) {
        return {
          ...diagnostic,
          eligible: false,
          code: "REMOVE_FAILED",
          reason: `Refusing remove: dirtiness re-check failed (${err instanceof Error ? err.message : String(err)}); retry later.`,
          reclaimed: false,
          alreadyGone: false,
        };
      }
      if (dirty.dirty) {
        return {
          ...diagnostic,
          eligible: false,
          code: "DIRTY",
          reason: `Refusing remove: worktree became dirty before lane delete (${dirty.changeCount} change(s)).`,
          reclaimed: false,
          alreadyGone: false,
          details: {
            ...(diagnostic.details ?? {}),
            trackedDirty: dirty.trackedDirty,
            untrackedDirty: dirty.untrackedDirty,
            changeCount: dirty.changeCount,
            dirtySample: dirty.sample,
          },
        };
      }
      // Immediate pre-remove: re-read registration and compare to expected again.
      const preReg = await inspectWorktreeRegistration(workspaceRoot, worktree);
      const preRegCompare = compareRegistrationToExpected({
        registration: preReg,
        expectedPath: worktree,
        expectedBranch,
        requireRegistered: true,
      });
      if (!preRegCompare.ok) {
        return {
          ...diagnostic,
          eligible: false,
          code: preRegCompare.code,
          reason: `Refusing remove: registration mismatch immediately before lane delete — ${preRegCompare.reason}`,
          reclaimed: false,
          alreadyGone: false,
          details: {
            ...(diagnostic.details ?? {}),
            ...(preRegCompare.details ?? {}),
          },
        };
      }
      const preRemove = await revalidateExactWorktreeOwnership({
        workspaceRoot,
        expectedPath: worktree,
        expectedBranch,
        requireOnDiskHead: true,
      });
      if (!preRemove.ok) {
        return {
          ...diagnostic,
          eligible: false,
          code: preRemove.code,
          reason: `Refusing remove: ownership revalidation failed immediately before lane delete — ${preRemove.reason}`,
          reclaimed: false,
          alreadyGone: false,
          details: {
            ...(diagnostic.details ?? {}),
            ...(preRemove.details ?? {}),
          },
        };
      }
      // Immediate pre-remove Session settle re-probe (Service critical section).
      const preRemoveSession = await probeSessionSettledBeforeRemove(
        input,
        diagnostic
      );
      if (preRemoveSession) return preRemoveSession;

      // Junction-safe directory delete: Node unlinks reparse/symlink entries as
      // links only and does not delete external targets (cx-80g9p5).
      const laneRm = await removeTaskLaneDirectorySafe(worktree, {
        rmLaneDirectoryForTests: input.rmLaneDirectoryForTests,
      });
      if (!laneRm.ok) {
        return {
          ...diagnostic,
          eligible: false,
          code: "REMOVE_FAILED",
          reason: laneRm.reason,
          reclaimed: false,
          alreadyGone: false,
          details: {
            ...(diagnostic.details ?? {}),
            ...(laneRm.details ?? {}),
            linkSafety: "node-fs-rm-lane",
          },
        };
      }
      if (await pathExists(worktree)) {
        return {
          ...diagnostic,
          eligible: false,
          code: "REMOVE_FAILED",
          reason: `Task lane directory still present after Node-safe remove at ${worktree}; leaving Git registration untouched.`,
          reclaimed: false,
          alreadyGone: false,
          details: {
            ...(diagnostic.details ?? {}),
            linkSafety: "node-fs-rm-lane",
          },
        };
      }
    }

    // Directory absent (pre-existing or after Node-safe rm): clean ONLY this
    // verified exact-path registration. Force is allowed solely after dir-absent
    // + branch ownership match. Never repository-global prune; never force while
    // a directory exists.
    {
      const liveReg = await inspectWorktreeRegistration(workspaceRoot, worktree);
      if (liveReg.registered) {
        if (await pathExists(worktree)) {
          return {
            ...diagnostic,
            eligible: false,
            code: "REMOVE_FAILED",
            reason: `Refusing metadata force cleanup: directory present at ${worktree}; Node-safe lane remove must clear it first.`,
            reclaimed: false,
            alreadyGone: false,
          };
        }
        const preForce = await revalidateExactWorktreeOwnership({
          workspaceRoot,
          expectedPath: worktree,
          expectedBranch,
          requireOnDiskHead: false,
        });
        if (!preForce.ok) {
          return {
            ...diagnostic,
            eligible: false,
            code: preForce.code,
            reason: `Refusing exact-path force metadata drop — ${preForce.reason}`,
            reclaimed: false,
            alreadyGone: false,
            details: {
              ...(diagnostic.details ?? {}),
              ...(preForce.details ?? {}),
            },
          };
        }
        const preForceSession = await probeSessionSettledBeforeRemove(
          input,
          diagnostic
        );
        if (preForceSession) return preForceSession;
        try {
          await git(workspaceRoot, ["worktree", "remove", "--force", worktree]);
        } catch (err) {
          return {
            ...diagnostic,
            eligible: false,
            code: "REMOVE_FAILED",
            reason: `Failed to drop exact stale registration at ${worktree} (dir already absent): ${err instanceof Error ? err.message : String(err)}`,
            reclaimed: false,
            alreadyGone: false,
          };
        }
        const afterMeta = await inspectWorktreeRegistration(workspaceRoot, worktree);
        if (afterMeta.registered || (await pathExists(worktree))) {
          return {
            ...diagnostic,
            eligible: false,
            code: "REMOVE_FAILED",
            reason: `Exact stale registration for ${worktree} remained after targeted metadata remove; refusing broader cleanup.`,
            reclaimed: false,
            alreadyGone: false,
          };
        }
      }
    }

    // Verify idempotent end state: path gone and not registered.
    const afterExists = await pathExists(worktree);
    const afterReg = await inspectWorktreeRegistration(workspaceRoot, worktree);
    if (afterExists || afterReg.registered) {
      return {
        ...diagnostic,
        eligible: false,
        code: "REMOVE_FAILED",
        reason: `git worktree remove did not fully clear path/registration at ${worktree}`,
        reclaimed: false,
        alreadyGone: false,
        details: {
          ...(diagnostic.details ?? {}),
          afterExists,
          afterRegistered: afterReg.registered,
        },
      };
    }

    return {
      ...diagnostic,
      code: "RECLAIMED",
      reason: `Removed Task worktree directory and Git registration at ${worktree}; branch and commits preserved.`,
      reclaimed: true,
      alreadyGone: false,
    };
  } catch (err) {
    return {
      ...diagnostic,
      eligible: false,
      code: "REMOVE_FAILED",
      reason: `Failed to remove Task worktree: ${err instanceof Error ? err.message : String(err)}`,
      reclaimed: false,
      alreadyGone: false,
    };
  }
}

/**
 * Convenience: load deliveries for the task then evaluate/reclaim.
 * Used by Service auto-reclaim and restart recovery.
 */
export async function reclaimTaskWorktreeForEnvelope(
  fs: FsAdapter,
  workspaceRoot: string,
  task: TaskEnvelope,
  options: {
    preview?: boolean;
    beforeRemoveForTests?: () => void | Promise<void>;
    rmLaneDirectoryForTests?: ReclaimTaskWorktreeInput["rmLaneDirectoryForTests"];
    assertSessionSettledBeforeRemove?: ReclaimTaskWorktreeInput["assertSessionSettledBeforeRemove"];
  } = {}
): Promise<TaskWorktreeReclaimResult> {
  const taskId = task.id?.trim();
  const deliveries = taskId ? await loadDeliveries(fs, { taskId }) : [];
  return reclaimTaskWorktree({
    workspaceRoot,
    task,
    deliveries,
    preview: options.preview,
    beforeRemoveForTests: options.beforeRemoveForTests,
    rmLaneDirectoryForTests: options.rmLaneDirectoryForTests,
    assertSessionSettledBeforeRemove: options.assertSessionSettledBeforeRemove,
  });
}

/** Immediate pre-remove Session settle re-probe (fail-closed → SESSION_ACTIVE). */
async function probeSessionSettledBeforeRemove(
  input: ReclaimTaskWorktreeInput,
  diagnostic: TaskWorktreeReclaimDiagnostic
): Promise<TaskWorktreeReclaimResult | undefined> {
  if (!input.assertSessionSettledBeforeRemove) return undefined;
  const settled = await input.assertSessionSettledBeforeRemove();
  if (settled.ok) return undefined;
  return {
    ...diagnostic,
    eligible: false,
    code: "SESSION_ACTIVE",
    reason: settled.reason,
    reclaimed: false,
    alreadyGone: false,
    details: {
      ...(diagnostic.details ?? {}),
      ...(settled.details ?? {}),
      settleProbe: "pre-remove",
    },
  };
}

export async function evaluateTaskWorktreeReclaimForEnvelope(
  fs: FsAdapter,
  workspaceRoot: string,
  task: TaskEnvelope
): Promise<TaskWorktreeReclaimDiagnostic> {
  const taskId = task.id?.trim();
  const deliveries = taskId ? await loadDeliveries(fs, { taskId }) : [];
  return evaluateTaskWorktreeReclaim({ workspaceRoot, task, deliveries });
}

// ---- internals ----

/**
 * Delete one Task lane directory with Node `fs.rm` only (no shell/PowerShell).
 * On Windows/POSIX, recursive rm unlinks junction/symlink entries without
 * deleting their targets — unlike `git worktree remove` on a present tree,
 * which can follow reparse points into shared deps (cx-80g9p5 / scheme A).
 *
 * Fail-closed: lane-root reparse, any rm error, or path still present → leave
 * Git registration untouched (no force metadata, no prune, no rollback).
 * Exported for focused unit tests; production reclaim calls this after final
 * clean/ownership/session gates and only then metadata-only force remove.
 */
export async function removeTaskLaneDirectorySafe(
  lanePath: string,
  options: {
    rmLaneDirectoryForTests?: (lanePath: string) => void | Promise<void>;
  } = {}
): Promise<
  | { ok: true }
  | { ok: false; reason: string; details?: Record<string, unknown> }
> {
  const resolved = nodePath.resolve(lanePath);
  let rootStat: Awaited<ReturnType<typeof nodeFs.lstat>>;
  try {
    rootStat = await nodeFs.lstat(resolved);
  } catch (err) {
    return {
      ok: false,
      reason: `Cannot lstat Task lane root before Node-safe remove at ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
      details: { lanePath: resolved },
    };
  }
  // Worktree root itself must be a real directory — never rm through a
  // symlink/junction masquerading as the Task lane path.
  if (rootStat.isSymbolicLink()) {
    return {
      ok: false,
      reason: `Task lane root is a symlink/junction/reparse point at ${resolved}; refusing Node-safe remove (fail-closed, registration untouched).`,
      details: { lanePath: resolved, linkSafety: "lane-root-reparse" },
    };
  }
  if (!rootStat.isDirectory()) {
    return {
      ok: false,
      reason: `Task lane root is not a directory at ${resolved}; refusing Node-safe remove.`,
      details: { lanePath: resolved },
    };
  }
  try {
    if (options.rmLaneDirectoryForTests) {
      await options.rmLaneDirectoryForTests(resolved);
    } else {
      // force:false — do not ignore errors; partial failure must fail closed.
      await nodeFs.rm(resolved, { recursive: true, force: false });
    }
  } catch (err) {
    return {
      ok: false,
      reason: `Node-safe Task lane directory remove failed at ${resolved} (possible partial lane; Git registration left untouched; no prune/rollback): ${err instanceof Error ? err.message : String(err)}`,
      details: { lanePath: resolved, linkSafety: "node-fs-rm-lane" },
    };
  }
  return { ok: true };
}

async function evaluateAcceptedSettle(input: {
  workspaceRoot: string;
  targetBranch: string;
  taskId: string;
  taskBranch: string;
  roleBranchBase?: string;
  deliveries: DeliveryRecord[];
}): Promise<
  | { ok: true }
  | {
      ok: false;
      code: TaskWorktreeReclaimCode;
      reason: string;
      details?: Record<string, unknown>;
    }
> {
  const target = input.targetBranch.trim();
  if (!target) {
    return {
      ok: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: "Accepted Task is missing targetBranch; cannot verify integrate/settle.",
    };
  }

  const related = input.deliveries.filter((d) => d.taskId === input.taskId);
  const open = related.filter((d) => d.status === "ready" || d.status === "draft");
  if (open.length > 0) {
    return {
      ok: false,
      code: "UNINTEGRATED",
      reason: `Accepted Task still has ${open.length} open delivery(ies); refuse reclaim.`,
      details: { deliveryIds: open.map((d) => d.id) },
    };
  }

  const accepted = related.filter((d) => d.status === "accepted");
  const missingFromDelivery: string[] = [];
  for (const d of accepted) {
    for (const ref of d.commits) {
      const sha = ref.trim();
      if (!sha) continue;
      const integrated = await findIntegratedCommit(input.workspaceRoot, sha, target);
      if (!integrated) missingFromDelivery.push(sha);
    }
  }
  if (missingFromDelivery.length > 0) {
    return {
      ok: false,
      code: "UNINTEGRATED",
      reason: `Accepted Delivery commit(s) are not integrated into ${target}; refusing reclaim.`,
      details: {
        missingCommits: missingFromDelivery.slice(0, 12),
        missingCount: missingFromDelivery.length,
        targetBranch: target,
        source: "delivery",
      },
    };
  }

  // Fail-closed: any commit still exclusive to the Task branch (vs target),
  // even when omitted from Delivery.commits — use ancestor / -x semantics.
  const branchMissing = await listUnintegratedTaskBranchCommits({
    workspaceRoot: input.workspaceRoot,
    taskBranch: input.taskBranch,
    targetBranch: target,
    roleBranchBase: input.roleBranchBase,
  });
  if (branchMissing.length > 0) {
    return {
      ok: false,
      code: "UNINTEGRATED",
      reason: `Task branch ${input.taskBranch} still has ${branchMissing.length} commit(s) not integrated into ${target} (including Delivery-omitted tips); refusing reclaim.`,
      details: {
        missingCommits: branchMissing.slice(0, 12),
        missingCount: branchMissing.length,
        targetBranch: target,
        source: "task-branch",
      },
    };
  }

  return { ok: true };
}

/**
 * Commits reachable from taskBranch that are not integrated into target
 * (ancestor or -x cherry-pick). When roleBranchBase is set and still an
 * ancestor of the task branch, only scan base..branch; otherwise scan
 * targetBranch..taskBranch (fail-closed on full exclusive tip set).
 */
async function listUnintegratedTaskBranchCommits(input: {
  workspaceRoot: string;
  taskBranch: string;
  targetBranch: string;
  roleBranchBase?: string;
}): Promise<string[]> {
  const root = nodePath.resolve(input.workspaceRoot);
  const branchRef = `refs/heads/${input.taskBranch}`;
  const branchExists = await gitOk(root, ["show-ref", "--verify", "--quiet", branchRef]);
  if (!branchExists) {
    // No branch tip → nothing exclusive left on the lane.
    return [];
  }

  let range = `${input.targetBranch}..${branchRef}`;
  const base = input.roleBranchBase?.trim();
  if (base) {
    try {
      const fullBase = (await git(root, ["rev-parse", base])).trim();
      if (
        fullBase &&
        (await gitOk(root, ["merge-base", "--is-ancestor", fullBase, branchRef]))
      ) {
        range = `${fullBase}..${branchRef}`;
      }
    } catch {
      // Fall back to target..branch.
    }
  }

  let output = "";
  try {
    output = await git(root, ["log", range, "--format=%H"]);
  } catch {
    // Ambiguous range → treat as unsettleable by returning a synthetic marker
    // only when the branch tip itself is not integrated.
    try {
      const tip = (await git(root, ["rev-parse", branchRef])).trim();
      if (!tip) return [];
      const integrated = await findIntegratedCommit(root, tip, input.targetBranch);
      return integrated ? [] : [tip];
    } catch {
      return ["<unreadable-task-branch>"];
    }
  }

  const shas = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const missing: string[] = [];
  for (const sha of shas) {
    const integrated = await findIntegratedCommit(root, sha, input.targetBranch);
    if (!integrated) missing.push(sha);
  }
  return missing;
}

type WorktreeRegistration = {
  registered: boolean;
  branch?: string;
  path?: string;
  /** Full SHA of refs/heads/<branch> when branch is set (object DB). */
  branchTip?: string;
  /** Full SHA of HEAD inside the worktree cwd when the directory exists. */
  headTip?: string;
};

/**
 * Compare a freshly read registration to the diagnostic expected path/branch.
 * Dirtiness is intentionally not considered here — ownership must stand alone.
 */
function compareRegistrationToExpected(input: {
  registration: WorktreeRegistration;
  expectedPath: string;
  expectedBranch: string;
  requireRegistered: boolean;
}):
  | { ok: true }
  | {
      ok: false;
      code: TaskWorktreeReclaimCode;
      reason: string;
      details?: Record<string, unknown>;
    } {
  const expectedPath = nodePath.resolve(input.expectedPath);
  const expectedBranch = input.expectedBranch.trim();
  const reg = input.registration;

  if (!reg.registered) {
    if (!input.requireRegistered) return { ok: true };
    return {
      ok: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: `Expected Git worktree registration missing at exact path ${expectedPath}; refusing remove.`,
      details: { expectedPath, expectedBranch },
    };
  }
  if (!reg.branch) {
    return {
      ok: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: `Worktree at ${expectedPath} is registered without a branch (detached/ambiguous); refusing remove.`,
      details: { expectedPath },
    };
  }
  if (reg.branch !== expectedBranch) {
    return {
      ok: false,
      code: "CONFLICTED_REGISTRATION",
      reason: `Fresh registration at ${expectedPath} is branch ${reg.branch}, expected diagnostic branch ${expectedBranch}.`,
      details: {
        registeredBranch: reg.branch,
        expectedBranch,
        registeredPath: reg.path,
        expectedPath,
      },
    };
  }
  if (reg.path) {
    const regPath = nodePath.resolve(reg.path);
    if (!isSameWorkspaceRoot(regPath, expectedPath)) {
      return {
        ok: false,
        code: "CONFLICTED_REGISTRATION",
        reason: `Fresh registration path ${regPath} does not match expected exact path ${expectedPath}.`,
        details: { registeredPath: regPath, expectedPath, expectedBranch },
      };
    }
  }
  return { ok: true };
}

/**
 * Fresh proof that Git still maps expectedPath ↔ expectedBranch with matching tip.
 * Used immediately before remove/force-metadata so dirtiness alone cannot authorize GC.
 */
async function revalidateExactWorktreeOwnership(input: {
  workspaceRoot: string;
  expectedPath: string;
  expectedBranch: string;
  requireOnDiskHead: boolean;
}): Promise<
  | { ok: true; registration: WorktreeRegistration; branchTip: string }
  | {
      ok: false;
      code: TaskWorktreeReclaimCode;
      reason: string;
      details?: Record<string, unknown>;
    }
> {
  const root = nodePath.resolve(input.workspaceRoot);
  const expectedPath = nodePath.resolve(input.expectedPath);
  const expectedBranch = input.expectedBranch.trim();
  if (!expectedBranch.startsWith("tent-task/")) {
    return {
      ok: false,
      code: "NOT_APPLICABLE",
      reason: `Expected branch ${expectedBranch} is not a tent-task/* lane; refusing auto-GC ownership proof.`,
    };
  }

  const registration = await inspectWorktreeRegistration(root, expectedPath);
  if (!registration.registered) {
    // Missing registration is only OK when caller already handled already-gone;
    // mid-remove revalidation must refuse.
    return {
      ok: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: `No Git worktree registration at exact path ${expectedPath}; refusing remove.`,
      details: { expectedPath, expectedBranch },
    };
  }
  if (!registration.branch) {
    return {
      ok: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: `Worktree at ${expectedPath} is detached/unbranched; refusing remove.`,
      details: { expectedPath },
    };
  }
  if (registration.branch !== expectedBranch) {
    return {
      ok: false,
      code: "CONFLICTED_REGISTRATION",
      reason: `Registration at ${expectedPath} is branch ${registration.branch}, expected ${expectedBranch}.`,
      details: { registeredBranch: registration.branch, expectedBranch },
    };
  }

  // Branch must still be registered at this exact path (not a different checkout).
  const pathForBranch = await worktreePathForBranch(root, expectedBranch);
  if (!pathForBranch) {
    return {
      ok: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: `Branch ${expectedBranch} has no worktree registration; refusing remove.`,
      details: { expectedBranch },
    };
  }
  const branchPath = nodePath.resolve(pathForBranch);
  let samePath = isSameWorkspaceRoot(branchPath, expectedPath);
  if (!samePath) {
    try {
      const [a, b] = await Promise.all([
        nodeFs.realpath(branchPath).catch(() => branchPath),
        nodeFs.realpath(expectedPath).catch(() => expectedPath),
      ]);
      samePath = isSameWorkspaceRoot(a, b);
    } catch {
      samePath = false;
    }
  }
  if (!samePath) {
    return {
      ok: false,
      code: "CONFLICTED_REGISTRATION",
      reason: `Branch ${expectedBranch} is registered at ${branchPath}, not exact path ${expectedPath}.`,
      details: { registeredPath: branchPath, expectedPath },
    };
  }

  // Ownership via branch tip (object DB) — required even when the directory is gone.
  let branchTip: string;
  try {
    branchTip = (await git(root, ["rev-parse", `refs/heads/${expectedBranch}`])).trim();
  } catch (err) {
    return {
      ok: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: `Cannot resolve tip of ${expectedBranch}: ${err instanceof Error ? err.message : String(err)}`,
      details: { expectedBranch },
    };
  }
  if (!branchTip) {
    return {
      ok: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: `Empty tip for ${expectedBranch}; refusing remove.`,
    };
  }

  if (input.requireOnDiskHead) {
    if (!(await pathExists(expectedPath))) {
      return {
        ok: false,
        code: "AMBIGUOUS_OWNERSHIP",
        reason: `Expected on-disk worktree missing at ${expectedPath} during ownership proof.`,
      };
    }
    let headTip: string;
    let currentBranch: string;
    try {
      headTip = (await git(expectedPath, ["rev-parse", "HEAD"])).trim();
      currentBranch = (await git(expectedPath, ["branch", "--show-current"])).trim();
    } catch (err) {
      return {
        ok: false,
        code: "AMBIGUOUS_OWNERSHIP",
        reason: `Cannot read HEAD/branch inside ${expectedPath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (currentBranch !== expectedBranch) {
      return {
        ok: false,
        code: "CONFLICTED_REGISTRATION",
        reason: `On-disk worktree is on ${currentBranch || "(detached)"}, expected ${expectedBranch}.`,
        details: { currentBranch, expectedBranch, headTip, branchTip },
      };
    }
    if (headTip !== branchTip) {
      return {
        ok: false,
        code: "AMBIGUOUS_OWNERSHIP",
        reason: `On-disk HEAD ${headTip} does not match refs/heads/${expectedBranch} tip ${branchTip}.`,
        details: { headTip, branchTip, expectedBranch },
      };
    }
  }

  return {
    ok: true,
    registration: { ...registration, branchTip },
    branchTip,
  };
}

async function inspectWorktreeRegistration(
  workspaceRoot: string,
  worktreePath: string
): Promise<WorktreeRegistration> {
  const root = nodePath.resolve(workspaceRoot);
  const target = nodePath.resolve(worktreePath);
  const output = await git(root, ["worktree", "list", "--porcelain"]).catch(() => "");
  let currentPath = "";
  let currentBranch: string | undefined;
  const entries: WorktreeRegistration[] = [];
  const flush = () => {
    if (!currentPath) return;
    entries.push({
      registered: true,
      path: currentPath,
      branch: currentBranch,
    });
    currentPath = "";
    currentBranch = undefined;
  };
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      flush();
      currentPath = line.slice("worktree ".length);
      continue;
    }
    if (line.startsWith("branch refs/heads/")) {
      currentBranch = line.slice("branch refs/heads/".length);
    }
    if (line === "detached") {
      currentBranch = undefined;
    }
  }
  flush();

  for (const entry of entries) {
    if (!entry.path) continue;
    const candidate = nodePath.resolve(entry.path);
    if (isSameWorkspaceRoot(candidate, target)) {
      return { registered: true, branch: entry.branch, path: candidate };
    }
    try {
      const [realCandidate, realTarget] = await Promise.all([
        nodeFs.realpath(candidate).catch(() => candidate),
        nodeFs.realpath(target).catch(() => target),
      ]);
      if (isSameWorkspaceRoot(realCandidate, realTarget)) {
        return { registered: true, branch: entry.branch, path: realCandidate };
      }
    } catch {
      // continue
    }
  }
  return { registered: false };
}

async function worktreePathForBranch(
  workspaceRoot: string,
  branch: string
): Promise<string | undefined> {
  const output = await git(nodePath.resolve(workspaceRoot), [
    "worktree",
    "list",
    "--porcelain",
  ]).catch(() => "");
  let currentPath = "";
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) currentPath = line.slice("worktree ".length);
    if (line === `branch refs/heads/${branch}`) return currentPath;
  }
  return undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await nodeFs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (data) => (out += data));
    child.stderr.on("data", (data) => (err += data));
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `git ${args.join(" ")} exit ${code}`));
    });
    child.on("error", reject);
  });
}
