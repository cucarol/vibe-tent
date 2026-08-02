// WorkspaceHost: mount N in-workspace tents; foreground is UI selection only.

import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NodeFs } from "../fs/node-fs.js";
import type { Clock } from "../core/adapter.js";
import type { OpsEnv } from "../core/ops-context.js";
import { INDEX_PATH, TENT_SYSTEM_DIR, systemRootFromWorkspace } from "../core/paths.js";
import { isSameWorkspaceRoot } from "../core/workspace.js";
import { EventBus } from "./events.js";
import type { MountedWorkspaceInfo } from "./types.js";

/** Digested into workspaceId; long enough to avoid path-prefix collisions. */
const WORKSPACE_ID_DIGEST_LEN = 12;

type WatchSuppressWindow = {
  /** Epoch ms; ignored after this time. */
  until: number;
  /** Normalized comparison keys; null means a legacy global hold. */
  pathKeys: string[] | null;
};

export interface MountedWorkspace {
  workspaceId: string;
  workspaceRoot: string;
  systemRoot: string;
  tentName: string;
  env: OpsEnv;
  watcher?: FSWatcher;
  /** Latest global suppression deadline; retained for diagnostic compatibility. */
  suppressWatchUntil: number;
  /** Path-scoped and global self-write windows applied at watcher ingress only. */
  suppressWindows: WatchSuppressWindow[];
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
  /** Distinct admitted paths in the current debounce window, keyed by path identity. */
  private watchPendingPaths = new Map<string, Map<string, string>>();
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
    const indexPath = path.join(systemRoot, INDEX_PATH);
    try {
      await fs.access(indexPath);
    } catch {
      throw new Error(
        `No in-workspace Tent at ${systemRoot}. Expected ${TENT_SYSTEM_DIR}/${INDEX_PATH}.`
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
      suppressWindows: [],
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
  markSelfWrite(workspaceId: string, holdMs = 200, paths?: string | string[]): void {
    const mount = this.mounts.get(workspaceId);
    if (!mount) return;
    const now = Date.now();
    const until = now + Math.max(0, holdMs);
    let pathKeys: string[] | null = null;
    if (paths !== undefined) {
      const normalized = (Array.isArray(paths) ? paths : [paths])
        .map(normalizeWatchPath)
        .filter((value) => value.length > 0)
        .map(watchPathKey);
      // Empty scoped input fails closed as a global hold.
      pathKeys = normalized.length > 0 ? [...new Set(normalized)] : null;
    }
    mount.suppressWindows = mount.suppressWindows.filter((window) => window.until > now);
    mount.suppressWindows.push({ until, pathKeys });
    if (pathKeys === null) {
      mount.suppressWatchUntil = Math.max(mount.suppressWatchUntil, until);
    }
  }

  async dispose(): Promise<void> {
    for (const id of [...this.mounts.keys()]) {
      await this.unmount(id);
    }
    for (const timer of this.watchTimers.values()) clearTimeout(timer);
    this.watchTimers.clear();
    this.watchPendingPaths.clear();
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
        const rel = normalizeWatchPath(String(filename));
        if (rel === "mutation.lock" || rel.endsWith("/mutation.lock")) return;
        if (rel === "attachments/.gc-state.json") return;
        // Suppression is decided once, at ingress. A later Service write must
        // not retroactively erase an already-admitted external event at flush.
        if (this.isWatchSuppressed(mount, rel)) return;

        let pending = this.watchPendingPaths.get(mount.workspaceId);
        if (!pending) {
          pending = new Map();
          this.watchPendingPaths.set(mount.workspaceId, pending);
        }
        const key = watchPathKey(rel);
        if (!pending.has(key)) pending.set(key, rel);

        const prev = this.watchTimers.get(mount.workspaceId);
        if (prev) clearTimeout(prev);
        this.watchTimers.set(
          mount.workspaceId,
          setTimeout(() => {
            this.watchTimers.delete(mount.workspaceId);
            const admitted = this.watchPendingPaths.get(mount.workspaceId);
            this.watchPendingPaths.delete(mount.workspaceId);
            if (!admitted || admitted.size === 0) return;
            this.flushWatchPaths(mount, admitted.values());
          }, this.watchDebounceMs)
        );
      }
    );
    watcher.on("error", () => {
      // Watcher errors are non-fatal; clients can re-query.
    });
    return watcher;
  }

  private flushWatchPaths(mount: MountedWorkspace, paths: Iterable<string>): void {
    let emittedTaskState = false;
    for (const rel of paths) {
      if (isTempWatchPath(rel)) {
        if (!emittedTaskState) {
          this.events.emit("task.state", mount.workspaceId, {
            reason: "watch",
            path: rel,
          });
          emittedTaskState = true;
        }
        continue;
      }
      this.events.emit("node.changed", mount.workspaceId, {
        reason: "watch",
        path: rel,
      });
    }
  }

  private isWatchSuppressed(mount: MountedWorkspace, rel: string): boolean {
    const now = Date.now();
    mount.suppressWindows = mount.suppressWindows.filter((window) => window.until > now);
    mount.suppressWatchUntil = mount.suppressWindows
      .filter((window) => window.pathKeys === null)
      .reduce((latest, window) => Math.max(latest, window.until), 0);
    const relKey = watchPathKey(rel);
    for (const window of mount.suppressWindows) {
      if (window.pathKeys === null) return true;
      for (const pathKey of window.pathKeys) {
        if (relKey === pathKey || relKey.startsWith(pathKey + "/")) return true;
      }
    }
    return false;
  }

  private stopWatch(mount: MountedWorkspace): void {
    const timer = this.watchTimers.get(mount.workspaceId);
    if (timer) {
      clearTimeout(timer);
      this.watchTimers.delete(mount.workspaceId);
    }
    this.watchPendingPaths.delete(mount.workspaceId);
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

function normalizeWatchPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function watchPathKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isTempWatchPath(value: string): boolean {
  const key = watchPathKey(value);
  return key === "temp" || key.startsWith("temp/");
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
