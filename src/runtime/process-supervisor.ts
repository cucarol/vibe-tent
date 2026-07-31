// ProcessSupervisor — child-process lifecycle only (B0 agent-runtime.md §7).
// Does not understand boxes, A2A, or task completion.

import { spawn, type ChildProcess } from "node:child_process";
import type { ResolvedLaunch } from "../adapters/types.js";
import {
  collectSecretValues,
} from "../adapters/acp/redact.js";
import { buildManagedChildEnv } from "./child-env.js";
import {
  ACP_DIAGNOSTIC_EVENT_BYTES,
  BoundedDiagnosticRedactor,
  appendUtf8Tail,
} from "../adapters/acp/limits.js";

export interface SupervisedProcess {
  sessionId: string;
  pid: number;
  startedAt: number;
  exitCode: number | null;
  signal: string | null;
  exited: boolean;
}

export interface SupervisorExitInfo {
  sessionId: string;
  exitCode: number | null;
  signal?: string;
}

export interface ProcessSupervisorOptions {
  /** Force-kill after graceful stop request (default 2000ms). */
  gracefulMs?: number;
  /** Optional ring buffer size for stdout/stderr diagnostics (default 0 = off). */
  stdoutRingBytes?: number;
  onExit?: (info: SupervisorExitInfo) => void;
  onStdout?: (sessionId: string, text: string) => void;
}

interface LiveChild {
  sessionId: string;
  child: ChildProcess;
  startedAt: number;
  exitCode: number | null;
  signal: string | null;
  exited: boolean;
  stdoutBuf: string;
  killTimer?: ReturnType<typeof setTimeout>;
}

export class ProcessSupervisor {
  private readonly children = new Map<string, LiveChild>();
  private readonly gracefulMs: number;
  private readonly stdoutRingBytes: number;
  private readonly onExit?: (info: SupervisorExitInfo) => void;
  private readonly onStdout?: (sessionId: string, text: string) => void;

  constructor(options: ProcessSupervisorOptions = {}) {
    this.gracefulMs = options.gracefulMs ?? 2000;
    this.stdoutRingBytes = options.stdoutRingBytes ?? 0;
    this.onExit = options.onExit;
    this.onStdout = options.onStdout;
  }

  listLive(): string[] {
    return [...this.children.entries()].filter(([, c]) => !c.exited).map(([id]) => id);
  }

  get(sessionId: string): SupervisedProcess | null {
    const live = this.children.get(sessionId);
    if (!live) return null;
    return {
      sessionId,
      pid: live.child.pid ?? -1,
      startedAt: live.startedAt,
      exitCode: live.exitCode,
      signal: live.signal,
      exited: live.exited,
    };
  }

  isAlive(sessionId: string): boolean {
    const live = this.children.get(sessionId);
    if (!live || live.exited) return false;
    const pid = live.child.pid;
    if (pid == null || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async start(sessionId: string, launch: ResolvedLaunch): Promise<SupervisedProcess> {
    if (this.children.has(sessionId) && this.isAlive(sessionId)) {
      throw new Error(`Process already live for session ${sessionId}`);
    }

    // Minimal host allowlist + validated launch env. Reserved Tent keys only from
    // explicit launch.coreEnv (AgentRuntime) — never smuggled via launch.env alone.
    const env = buildManagedChildEnv({
      launchEnv: launch.env,
      reserved: launch.coreEnv,
    });
    const coreSecrets = collectSecretValues(launch.coreEnv);
    const secretValues = collectSecretValues(launch.env, [
      ...(launch.diagnosticSecrets ?? []),
      ...coreSecrets,
    ]);
    const stdoutDiagnostic = new BoundedDiagnosticRedactor(
      secretValues,
      ACP_DIAGNOSTIC_EVENT_BYTES
    );
    const stderrDiagnostic = new BoundedDiagnosticRedactor(
      secretValues,
      ACP_DIAGNOSTIC_EVENT_BYTES
    );

    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Detached false so service shutdown can reap children as a group.
      detached: false,
    });

    const live: LiveChild = {
      sessionId,
      child,
      startedAt: Date.now(),
      exitCode: null,
      signal: null,
      exited: false,
      stdoutBuf: "",
    };
    this.children.set(sessionId, live);
    let spawned = false;
    let exitNotified = false;

    const appendRing = (text: string) => {
      if (this.stdoutRingBytes <= 0) return;
      live.stdoutBuf = appendUtf8Tail(
        live.stdoutBuf,
        text,
        this.stdoutRingBytes
      );
    };

    const emitDiagnostic = (text: string) => {
      if (!text) return;
      appendRing(text);
      this.onStdout?.(sessionId, text);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      emitDiagnostic(stdoutDiagnostic.pushBuffer(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      emitDiagnostic(stderrDiagnostic.pushBuffer(chunk));
    });
    child.stdout?.on("end", () => emitDiagnostic(stdoutDiagnostic.flush()));
    child.stderr?.on("end", () => emitDiagnostic(stderrDiagnostic.flush()));

    const notifyExit = () => {
      if (!spawned || exitNotified) return;
      exitNotified = true;
      this.onExit?.({
        sessionId,
        exitCode: live.exitCode,
        signal: live.signal ?? undefined,
      });
    };

    child.on("exit", (code, signal) => {
      live.exited = true;
      live.exitCode = code;
      live.signal = signal;
      if (live.killTimer) {
        clearTimeout(live.killTimer);
        live.killTimer = undefined;
      }
      notifyExit();
    });

    child.on("error", () => {
      // exit handler still fires for most spawn failures after start;
      // mark exited so probe does not report zombie live.
      if (!live.exited) {
        live.exited = true;
        live.exitCode = null;
        live.signal = "error";
      }
      notifyExit();
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          child.off("error", onStartError);
          spawned = true;
          resolve();
        };
        const onStartError = (error: Error) => {
          child.off("spawn", onSpawn);
          reject(error);
        };
        child.once("spawn", onSpawn);
        child.once("error", onStartError);
      });
    } catch (error) {
      this.children.delete(sessionId);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to spawn process for session ${sessionId}: ${message}`);
    }

    if (child.pid == null) {
      this.children.delete(sessionId);
      throw new Error(`Failed to spawn process for session ${sessionId}: missing pid`);
    }

    return {
      sessionId,
      pid: child.pid,
      startedAt: live.startedAt,
      exitCode: live.exitCode,
      signal: live.signal,
      exited: live.exited,
    };
  }

  /**
   * Graceful stop → timeout → force kill (Windows: taskkill tree).
   */
  async stop(sessionId: string, options?: { gracefulMs?: number; signal?: NodeJS.Signals }): Promise<void> {
    const live = this.children.get(sessionId);
    if (!live || live.exited) {
      this.children.delete(sessionId);
      return;
    }

    const gracefulMs = options?.gracefulMs ?? this.gracefulMs;
    const signal = options?.signal ?? "SIGTERM";
    const pid = live.child.pid;

    try {
      live.child.kill(signal);
    } catch {
      // already dead
    }

    if (live.exited) {
      this.children.delete(sessionId);
      return;
    }

    await new Promise<void>((resolve) => {
      const done = () => {
        if (live.killTimer) {
          clearTimeout(live.killTimer);
          live.killTimer = undefined;
        }
        resolve();
      };

      if (live.exited) {
        done();
        return;
      }

      const onExit = () => done();
      live.child.once("exit", onExit);

      live.killTimer = setTimeout(() => {
        live.child.removeListener("exit", onExit);
        void this.forceKill(live).finally(done);
      }, gracefulMs);
    });

    this.children.delete(sessionId);
  }

  /** Stop every live child (service shutdown default for push-mode). */
  async stopAll(reason: "shutdown" | "user" = "shutdown"): Promise<void> {
    void reason;
    const ids = this.listLive();
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  getStdoutTail(sessionId: string): string {
    return this.children.get(sessionId)?.stdoutBuf ?? "";
  }

  private async forceKill(live: LiveChild): Promise<void> {
    if (live.exited) return;
    const pid = live.child.pid;
    if (pid == null) return;

    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.on("exit", () => resolve());
        killer.on("error", () => resolve());
        setTimeout(resolve, 1500);
      });
    } else {
      try {
        live.child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }

    // Wait briefly for exit event
    if (!live.exited) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 500);
        live.child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }
}
