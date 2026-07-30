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
   * Test-only: replace the link-unlink step used by pre-remove reparse detach.
   * Production never sets this. Used to prove fail-closed when unlink is refused.
   */
  unlinkLinkForTests?: (linkPath: string) => void | Promise<void>;
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
 * - When the directory is already absent, mutate only that exact verified
 *   registration (path force only after dir-absent + branch/HEAD ownership match).
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

    // Directory still present → only non-force remove after ownership + clean check.
    // Never --force on an existing tree (fail-closed; retry from settle/recovery).
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
          reason: `Refusing remove: worktree became dirty before git worktree remove (${dirty.changeCount} change(s)).`,
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
          reason: `Refusing remove: registration mismatch immediately before git worktree remove — ${preRegCompare.reason}`,
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
          reason: `Refusing remove: ownership revalidation failed immediately before git worktree remove — ${preRemove.reason}`,
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
      // P0 junction/reparse safety: walk the lane without following links, detach
      // only the link entries that could let recursive delete escape the lane.
      // Never mutate link targets. Fail closed → do not call git worktree remove.
      const detach = await detachOutboundLinksInTaskLane(worktree, {
        unlinkLinkForTests: input.unlinkLinkForTests,
      });
      if (!detach.ok) {
        return {
          ...diagnostic,
          eligible: false,
          code: detach.code,
          reason: `Refusing git worktree remove: ${detach.reason}`,
          reclaimed: false,
          alreadyGone: false,
          details: {
            ...(diagnostic.details ?? {}),
            ...(detach.details ?? {}),
            linkSafety: "pre-remove-detach",
          },
        };
      }
      try {
        await git(workspaceRoot, ["worktree", "remove", worktree]);
      } catch (err) {
        return {
          ...diagnostic,
          eligible: false,
          code: "REMOVE_FAILED",
          reason: `git worktree remove failed without force (directory still present): ${err instanceof Error ? err.message : String(err)}; retry later.`,
          reclaimed: false,
          alreadyGone: false,
          details: {
            ...(diagnostic.details ?? {}),
            detachedLinks: detach.detached,
          },
        };
      }
    } else if (registration.registered) {
      // Directory already gone: clean ONLY this verified exact-path registration.
      // Force is allowed solely after dir-absent + branch/HEAD ownership match.
      // Never repository-global prune; never force while a directory exists.
      if (await pathExists(worktree)) {
        return {
          ...diagnostic,
          eligible: false,
          code: "REMOVE_FAILED",
          reason: `Refusing metadata force cleanup: directory reappeared at ${worktree}; retry with non-force path.`,
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
    unlinkLinkForTests?: ReclaimTaskWorktreeInput["unlinkLinkForTests"];
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
    unlinkLinkForTests: options.unlinkLinkForTests,
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

export type DetachedLaneLink = {
  /** Absolute path of the link entry inside the Task lane (not the target). */
  linkPath: string;
  /** raw readlink() text before resolve (diagnostic only). */
  rawTarget: string;
  /** Resolved target path when classification succeeded. */
  resolvedTarget?: string;
  /** True when resolved target lies outside the Task lane root. */
  outbound: boolean;
};

export type DetachOutboundLinksResult =
  | { ok: true; detached: DetachedLaneLink[] }
  | {
      ok: false;
      code: TaskWorktreeReclaimCode;
      reason: string;
      details?: Record<string, unknown>;
    };

/**
 * Walk a Task lane without following symlinks/junctions/reparse points.
 * Any link that could let recursive deletion reach outside the lane is detached
 * as the link entry only (`unlink` / directory-link `rmdir`) — never the target.
 *
 * Fail-closed: ambiguous classification, path escape during walk, or unlink
 * failure preserves the lane and refuses subsequent `git worktree remove`.
 *
 * Exported for focused unit tests; production reclaim calls this immediately
 * before non-force `git worktree remove` on an existing directory.
 */
export async function detachOutboundLinksInTaskLane(
  laneRoot: string,
  options: {
    unlinkLinkForTests?: (linkPath: string) => void | Promise<void>;
  } = {}
): Promise<DetachOutboundLinksResult> {
  const root = nodePath.resolve(laneRoot);
  if (!(await pathExists(root))) {
    return {
      ok: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: `Task lane path missing during reparse-point safety walk: ${root}`,
      details: { laneRoot: root },
    };
  }

  // Lane root itself must be a real directory, not a link masquerading as the lane.
  let rootStat: Awaited<ReturnType<typeof nodeFs.lstat>>;
  try {
    rootStat = await nodeFs.lstat(root);
  } catch (err) {
    return {
      ok: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: `Cannot lstat Task lane root for reparse safety: ${err instanceof Error ? err.message : String(err)}`,
      details: { laneRoot: root },
    };
  }
  if (rootStat.isSymbolicLink()) {
    return {
      ok: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: `Task lane root is a symlink/junction/reparse point; refusing reclaim rather than follow or detach the lane itself.`,
      details: { laneRoot: root },
    };
  }
  if (!rootStat.isDirectory()) {
    return {
      ok: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: `Task lane root is not a directory during reparse safety walk: ${root}`,
      details: { laneRoot: root },
    };
  }

  const links: string[] = [];
  const walkFail = await walkLaneCollectingLinks(root, root, links);
  if (walkFail) return walkFail;

  const detached: DetachedLaneLink[] = [];
  // Deepest paths first so nested link entries (under real dirs) unlink cleanly.
  links.sort((a, b) => b.length - a.length);

  for (const linkPath of links) {
    const classified = await classifyLaneLink(root, linkPath);
    if (!classified.ok) return classified;

    // Detach every classified link under the lane. Outbound links are mandatory
    // (production junction→shared node_modules case). In-lane links are also
    // detached so git/fs recursive remove cannot follow any reparse point.
    try {
      if (options.unlinkLinkForTests) {
        await options.unlinkLinkForTests(linkPath);
      } else {
        await unlinkLinkOnly(linkPath);
      }
    } catch (err) {
      return {
        ok: false,
        code: "REMOVE_FAILED",
        reason: `Failed to detach link-only entry at ${linkPath} (target left untouched): ${err instanceof Error ? err.message : String(err)}`,
        details: {
          laneRoot: root,
          linkPath,
          rawTarget: classified.link.rawTarget,
          resolvedTarget: classified.link.resolvedTarget,
          outbound: classified.link.outbound,
        },
      };
    }

    // Link entry must be gone. Target survival is asserted by production regressions
    // with an external sentinel (we never call recursive delete on the target).
    if (await pathExists(linkPath)) {
      return {
        ok: false,
        code: "REMOVE_FAILED",
        reason: `Link entry still present after detach attempt at ${linkPath}; refusing git worktree remove.`,
        details: {
          laneRoot: root,
          linkPath,
          outbound: classified.link.outbound,
        },
      };
    }

    detached.push(classified.link);
  }

  return { ok: true, detached };
}

/**
 * Depth-first walk that never descends through symlink/junction/reparse entries.
 * Only real directories are entered; every isSymbolicLink() path is collected.
 */
async function walkLaneCollectingLinks(
  laneRoot: string,
  dir: string,
  out: string[]
): Promise<DetachOutboundLinksResult | undefined> {
  if (!isPathInsideRoot(dir, laneRoot)) {
    return {
      ok: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: `Reparse safety walk escaped Task lane root (dir=${dir}, lane=${laneRoot}).`,
      details: { laneRoot, dir },
    };
  }

  let names: string[];
  try {
    names = await nodeFs.readdir(dir);
  } catch (err) {
    return {
      ok: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: `Cannot readdir during reparse safety walk at ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      details: { laneRoot, dir },
    };
  }

  for (const name of names) {
    // Defend against path pieces that could normalize outside the lane.
    if (name === ".." || name === ".") {
      return {
        ok: false,
        code: "AMBIGUOUS_OWNERSHIP",
        reason: `Unexpected path segment ${JSON.stringify(name)} during reparse safety walk at ${dir}.`,
        details: { laneRoot, dir },
      };
    }
    const full = nodePath.resolve(dir, name);
    if (!isPathInsideRoot(full, laneRoot)) {
      return {
        ok: false,
        code: "AMBIGUOUS_OWNERSHIP",
        reason: `Child path escapes Task lane during reparse safety walk: ${full}`,
        details: { laneRoot, dir, name },
      };
    }

    let st: Awaited<ReturnType<typeof nodeFs.lstat>>;
    try {
      // lstat: never follow symlink/junction/reparse.
      st = await nodeFs.lstat(full);
    } catch (err) {
      return {
        ok: false,
        code: "AMBIGUOUS_OWNERSHIP",
        reason: `Cannot lstat ${full} during reparse safety walk: ${err instanceof Error ? err.message : String(err)}`,
        details: { laneRoot, path: full },
      };
    }

    if (st.isSymbolicLink()) {
      // Junction + symlink both report isSymbolicLink under Node on Windows.
      out.push(full);
      continue;
    }
    if (st.isDirectory()) {
      const nested = await walkLaneCollectingLinks(laneRoot, full, out);
      if (nested) return nested;
    }
    // Regular files and other non-link types: leave for git worktree remove.
  }
  return undefined;
}

async function classifyLaneLink(
  laneRoot: string,
  linkPath: string
): Promise<
  | { ok: true; link: DetachedLaneLink }
  | {
      ok: false;
      code: TaskWorktreeReclaimCode;
      reason: string;
      details?: Record<string, unknown>;
    }
> {
  if (!isPathInsideRoot(linkPath, laneRoot)) {
    return {
      ok: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: `Refusing to operate on link outside Task lane: ${linkPath}`,
      details: { laneRoot, linkPath },
    };
  }

  let st: Awaited<ReturnType<typeof nodeFs.lstat>>;
  try {
    st = await nodeFs.lstat(linkPath);
  } catch (err) {
    return {
      ok: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: `Cannot re-lstat link before detach at ${linkPath}: ${err instanceof Error ? err.message : String(err)}`,
      details: { laneRoot, linkPath },
    };
  }
  if (!st.isSymbolicLink()) {
    return {
      ok: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: `Path was collected as a link but is no longer a symlink/junction at detach time: ${linkPath}`,
      details: { laneRoot, linkPath },
    };
  }

  let rawTarget: string;
  try {
    rawTarget = await nodeFs.readlink(linkPath);
  } catch (err) {
    return {
      ok: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: `Cannot readlink to classify reparse target at ${linkPath}: ${err instanceof Error ? err.message : String(err)}`,
      details: { laneRoot, linkPath },
    };
  }
  if (typeof rawTarget !== "string" || rawTarget.length === 0) {
    return {
      ok: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: `Empty or non-string readlink result at ${linkPath}; refusing to classify.`,
      details: { laneRoot, linkPath, rawTarget },
    };
  }

  // Windows junctions often return an absolute path; POSIX may be relative.
  // Strip the Win32 kernel prefix when present so path resolution is stable.
  const normalizedRaw = stripWin32NtPrefix(rawTarget);
  let resolvedTarget: string;
  try {
    resolvedTarget = nodePath.isAbsolute(normalizedRaw)
      ? nodePath.resolve(normalizedRaw)
      : nodePath.resolve(nodePath.dirname(linkPath), normalizedRaw);
  } catch (err) {
    return {
      ok: false,
      code: "AMBIGUOUS_OWNERSHIP",
      reason: `Cannot resolve link target for classification at ${linkPath}: ${err instanceof Error ? err.message : String(err)}`,
      details: { laneRoot, linkPath, rawTarget },
    };
  }

  const outbound = !isPathInsideRoot(resolvedTarget, laneRoot);
  return {
    ok: true,
    link: {
      linkPath,
      rawTarget,
      resolvedTarget,
      outbound,
    },
  };
}

/**
 * Remove only the link entry. Never `fs.rm(..., { recursive: true })` on a link
 * path in a way that could follow the target — use unlink, with rmdir fallback
 * for directory junctions/symlinks on some Windows Node builds.
 */
async function unlinkLinkOnly(linkPath: string): Promise<void> {
  try {
    await nodeFs.unlink(linkPath);
    return;
  } catch (unlinkErr) {
    // Directory symlink / junction: some Windows paths need rmdir (RemoveDirectory).
    try {
      await nodeFs.rmdir(linkPath);
      return;
    } catch {
      throw unlinkErr;
    }
  }
}

/** True when `candidate` is `root` or a path strictly under `root` (after resolve). */
function isPathInsideRoot(candidate: string, root: string): boolean {
  const resolvedRoot = nodePath.resolve(root);
  const resolvedCandidate = nodePath.resolve(candidate);
  if (isSameWorkspaceRoot(resolvedCandidate, resolvedRoot)) return true;
  const rel = nodePath.relative(resolvedRoot, resolvedCandidate);
  return Boolean(rel) && !rel.startsWith("..") && !nodePath.isAbsolute(rel);
}

/** Strip \\?\ / \??\ prefixes from Windows reparse readlink text. */
function stripWin32NtPrefix(target: string): string {
  if (target.startsWith("\\??\\")) return target.slice(4);
  if (target.startsWith("\\\\?\\")) return target.slice(4);
  return target;
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
