// WorkspaceHost: mount N in-workspace tents; foreground is UI selection only.

import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NodeFs } from "../fs/node-fs.js";
import type { Clock } from "../core/adapter.js";
import type { OpsEnv } from "../core/ops-context.js";
import { TENT_SYSTEM_DIR, systemRootFromWorkspace } from "../core/paths.js";
import { isSameWorkspaceRoot } from "../core/workspace.js";
import { EventBus } from "./events.js";
import type { MountedWorkspaceInfo } from "./types.js";

/** Digested into workspaceId; long enough to avoid path-prefix collisions. */
const WORKSPACE_ID_DIGEST_LEN = 12;

export interface MountedWorkspace {
  workspaceId: string;
  workspaceRoot: string;
  systemRoot: string;
  tentName: string;
  env: OpsEnv;
  watcher?: FSWatcher;
  /** Suppress self-echo concept events for this many ms after a service write. */
  suppressWatchUntil: number;
}

export interface WorkspaceHostOptions {
  events: EventBus;
  clock?: Clock;
  /** Injected for tests; default node:fs watch. */
  watchFn?: typeof watch;
  /** Debounce external FS events (ms). */
  watchDebounceMs?: number;
  /** Optional invisible per-workspace maintenance. Errors are intentionally non-fatal. */
  housekeeper?: (mount: MountedWorkspace) => Promise<void>;
  housekeepingInitialDelayMs?: number;
  housekeepingIntervalMs?: number;
}

export class WorkspaceHost {
  private mounts = new Map<string, MountedWorkspace>();
  private foregroundId: string | null = null;
  private readonly events: EventBus;
  private readonly clock: Clock;
  private readonly watchFn: typeof watch;
  private readonly watchDebounceMs: number;
  private watchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly housekeeper?: (mount: MountedWorkspace) => Promise<void>;
  private readonly housekeepingInitialDelayMs: number;
  private readonly housekeepingIntervalMs: number;
  private housekeepingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private housekeepingRunning = new Set<string>();

  constructor(options: WorkspaceHostOptions) {
    this.events = options.events;
    this.clock = options.clock ?? { now: () => new Date().toISOString() };
    this.watchFn = options.watchFn ?? watch;
    this.watchDebounceMs = options.watchDebounceMs ?? 50;
    this.housekeeper = options.housekeeper;
    this.housekeepingInitialDelayMs = options.housekeepingInitialDelayMs ?? 60_000;
    this.housekeepingIntervalMs = options.housekeepingIntervalMs ?? 24 * 60 * 60 * 1000;
  }

  list(): MountedWorkspaceInfo[] {
    return [...this.mounts.values()].map((m) => this.toInfo(m));
  }

  get(workspaceId: string): MountedWorkspace | undefined {
    return this.mounts.get(workspaceId);
  }

  require(workspaceId: string): MountedWorkspace {
    const m = this.mounts.get(workspaceId);
    if (!m) throw new Error(`Workspace not mounted: ${workspaceId}`);
    return m;
  }

  getForegroundId(): string | null {
    return this.foregroundId;
  }

  async mount(workspaceRoot: string, opts?: { workspaceId?: string; tentName?: string }): Promise<MountedWorkspaceInfo> {
    // Canonicalize to the real directory so junction/symlink aliases share one mount.
    // Display/storage still use this real path only; identity comparison is separate (see below).
    const resolved = path.resolve(workspaceRoot);
    let root: string;
    try {
      root = await fs.realpath(resolved);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") {
        throw new Error(`Workspace path does not exist: ${resolved}`);
      }
      throw error;
    }

    const systemRoot = systemRootFromWorkspace(root);
    const rulesPath = path.join(systemRoot, "RULES.md");
    try {
      await fs.access(rulesPath);
    } catch {
      throw new Error(
        `No in-workspace Tent at ${systemRoot}. Expected ${TENT_SYSTEM_DIR}/RULES.md (B1 single-location model).`
      );
    }

    // Identity key: Windows case-insensitive, other platforms case-sensitive.
    // Does not rewrite stored/display paths — only dedupes live mounts in memory.
    for (const existing of this.mounts.values()) {
      if (isSameWorkspaceRoot(existing.workspaceRoot, root)) {
        return this.toInfo(existing);
      }
    }

    const workspaceId = opts?.workspaceId?.trim() || makeWorkspaceId(root);
    if (this.mounts.has(workspaceId)) {
      throw new Error(`workspaceId already mounted: ${workspaceId}`);
    }

    const tentName = opts?.tentName?.trim() || path.basename(root) || "tent";
    const fsa = new NodeFs(systemRoot);
    const env: OpsEnv = {
      fs: fsa,
      clock: this.clock,
      tentName,
      tentRoot: systemRoot,
    };

    const mount: MountedWorkspace = {
      workspaceId,
      workspaceRoot: root,
      systemRoot,
      tentName,
      env,
      suppressWatchUntil: 0,
    };

    mount.watcher = this.startWatch(mount);
    this.mounts.set(workspaceId, mount);
    this.scheduleHousekeeping(mount, this.housekeepingInitialDelayMs);

    if (!this.foregroundId) {
      this.foregroundId = workspaceId;
      this.events.emit("workspace.switched", workspaceId, {
        workspaceId,
        workspaceRoot: root,
        reason: "mount-default-foreground",
      });
    }

    this.events.emit("service.health", workspaceId, {
      action: "workspace.mounted",
      workspaceId,
      workspaceRoot: root,
    });

    return this.toInfo(mount);
  }

  async unmount(workspaceId: string): Promise<void> {
    const mount = this.mounts.get(workspaceId);
    if (!mount) return;
    this.stopWatch(mount);
    this.stopHousekeeping(workspaceId);
    this.mounts.delete(workspaceId);
    if (this.foregroundId === workspaceId) {
      const next = this.mounts.keys().next();
      this.foregroundId = next.done ? null : next.value;
      if (this.foregroundId) {
        this.events.emit("workspace.switched", this.foregroundId, {
          workspaceId: this.foregroundId,
          reason: "unmount-reselect",
        });
      }
    }
    this.events.emit("service.health", workspaceId, {
      action: "workspace.unmounted",
      workspaceId,
    });
  }

  setForeground(workspaceId: string): MountedWorkspaceInfo {
    const mount = this.require(workspaceId);
    if (this.foregroundId !== workspaceId) {
      this.foregroundId = workspaceId;
      this.events.emit("workspace.switched", workspaceId, {
        workspaceId,
        workspaceRoot: mount.workspaceRoot,
        reason: "setForeground",
      });
    }
    return this.toInfo(mount);
  }

  /** Call before service-originated disk writes to reduce watch self-echo noise. */
  markSelfWrite(workspaceId: string, holdMs = 200): void {
    const mount = this.mounts.get(workspaceId);
    if (!mount) return;
    mount.suppressWatchUntil = Date.now() + holdMs;
  }

  async dispose(): Promise<void> {
    for (const id of [...this.mounts.keys()]) {
      await this.unmount(id);
    }
    for (const timer of this.watchTimers.values()) clearTimeout(timer);
    this.watchTimers.clear();
    for (const timer of this.housekeepingTimers.values()) clearTimeout(timer);
    this.housekeepingTimers.clear();
    this.housekeepingRunning.clear();
  }

  private toInfo(m: MountedWorkspace): MountedWorkspaceInfo {
    return {
      workspaceId: m.workspaceId,
      workspaceRoot: m.workspaceRoot,
      systemRoot: m.systemRoot,
      tentName: m.tentName,
      foreground: this.foregroundId === m.workspaceId,
    };
  }

  private startWatch(mount: MountedWorkspace): FSWatcher {
    const watcher = this.watchFn(
      mount.systemRoot,
      { recursive: true },
      (_event, filename) => {
        if (!filename) return;
        const rel = String(filename).replace(/\\/g, "/");
        if (rel === "mutation.lock" || rel.endsWith("/mutation.lock")) return;
        if (rel === "attachments/.gc-state.json") return;
        if (Date.now() < mount.suppressWatchUntil) return;

        const prev = this.watchTimers.get(mount.workspaceId);
        if (prev) clearTimeout(prev);
        this.watchTimers.set(
          mount.workspaceId,
          setTimeout(() => {
            this.watchTimers.delete(mount.workspaceId);
            // Operational pipeline changes may still matter for task.state; concept paths fan concept.changed.
            if (rel.startsWith("temp/") || rel === "temp") {
              this.events.emit("task.state", mount.workspaceId, {
                reason: "watch",
                path: rel,
              });
              return;
            }
            this.events.emit("concept.changed", mount.workspaceId, {
              reason: "watch",
              path: rel,
            });
          }, this.watchDebounceMs)
        );
      }
    );
    watcher.on("error", () => {
      // Watcher errors are non-fatal; clients can re-query.
    });
    return watcher;
  }

  private stopWatch(mount: MountedWorkspace): void {
    const timer = this.watchTimers.get(mount.workspaceId);
    if (timer) {
      clearTimeout(timer);
      this.watchTimers.delete(mount.workspaceId);
    }
    try {
      mount.watcher?.close();
    } catch {
      // ignore
    }
    mount.watcher = undefined;
  }

  private scheduleHousekeeping(mount: MountedWorkspace, delayMs: number): void {
    if (!this.housekeeper || this.housekeepingIntervalMs <= 0) return;
    this.stopHousekeeping(mount.workspaceId);
    const timer = setTimeout(() => {
      this.housekeepingTimers.delete(mount.workspaceId);
      void this.runHousekeeping(mount.workspaceId);
    }, Math.max(0, delayMs));
    timer.unref?.();
    this.housekeepingTimers.set(mount.workspaceId, timer);
  }

  private async runHousekeeping(workspaceId: string): Promise<void> {
    const mount = this.mounts.get(workspaceId);
    if (!mount || !this.housekeeper || this.housekeepingRunning.has(workspaceId)) return;
    this.housekeepingRunning.add(workspaceId);
    try {
      await this.housekeeper(mount);
    } catch {
      // Housekeeping is hygiene, never a reason to break an active workspace.
    } finally {
      this.housekeepingRunning.delete(workspaceId);
      const current = this.mounts.get(workspaceId);
      if (current) this.scheduleHousekeeping(current, this.housekeepingIntervalMs);
    }
  }

  private stopHousekeeping(workspaceId: string): void {
    const timer = this.housekeepingTimers.get(workspaceId);
    if (timer) clearTimeout(timer);
    this.housekeepingTimers.delete(workspaceId);
  }
}

function makeWorkspaceId(workspaceRoot: string): string {
  // Caller passes realpath'd root (not the request alias string).
  // Hash the full identity so long shared path prefixes cannot collide.
  const base = path.basename(workspaceRoot).replace(/[^a-zA-Z0-9._-]+/g, "-") || "ws";
  // Windows is case-insensitive: normalize identity before digesting.
  const identity = process.platform === "win32" ? workspaceRoot.toLowerCase() : workspaceRoot;
  const digest = createHash("sha256")
    .update(identity)
    .digest("base64url")
    .slice(0, WORKSPACE_ID_DIGEST_LEN);
  return `ws-${base}-${digest}`;
}
