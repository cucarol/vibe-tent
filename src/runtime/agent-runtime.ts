// AgentRuntimePort implementation — service-internal only (B0 §4).
// Maps ProcessSupervisor + SessionRegistry + ProviderAdapter; no task/box writes.

import type { ProviderAdapter } from "../adapters/types.js";
import { FAKE_ADAPTER_ID, createFakeAdapter } from "../adapters/fake/index.js";
import { ProcessSupervisor } from "./process-supervisor.js";
import { SessionRegistry } from "./session-registry.js";
import type {
  AgentProfileConfig,
  AgentRuntimePort,
  ResumeSessionRequest,
  RuntimeEvent,
  SessionHandle,
  SessionProbe,
  SessionRecord,
  StartSessionRequest,
  StopReason,
  Unsubscribe,
} from "./types.js";
import { isSessionId } from "./types.js";

export interface AgentRuntimeOptions {
  dataDir: string;
  /** Profile catalog (machine-local). */
  profiles?: AgentProfileConfig[];
  /** Adapter registry; defaults include fake-cli. */
  adapters?: ProviderAdapter[];
  /** Graceful stop timeout for supervised children. */
  gracefulMs?: number;
  /** When true (default), capture short stdout tails as diagnostic events. */
  captureStdout?: boolean;
}

function handleFrom(record: SessionRecord): SessionHandle {
  return {
    sessionId: record.id,
    profileId: record.profileId,
    adapterId: record.adapterId,
    state: record.state,
    pid: record.pid,
    roleName: record.roleName,
    runtimeWorkspace: record.runtimeWorkspace,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export class AgentRuntime implements AgentRuntimePort {
  readonly registry: SessionRegistry;
  readonly supervisor: ProcessSupervisor;
  private readonly profiles = new Map<string, AgentProfileConfig>();
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly sinks = new Map<string, Set<(ev: RuntimeEvent) => void>>();
  private readonly globalSinks = new Set<(ev: RuntimeEvent) => void>();
  private closed = false;

  constructor(options: AgentRuntimeOptions) {
    this.registry = new SessionRegistry(options.dataDir);

    for (const p of options.profiles ?? []) {
      this.profiles.set(p.id, p);
    }
    // Always ensure a default fake profile for harness tests.
    if (!this.profiles.has("fake-default")) {
      this.profiles.set("fake-default", {
        id: "fake-default",
        adapterId: FAKE_ADAPTER_ID,
        displayNameKey: "profile.fake.default",
        fake: { waitForSignal: true, emitStdout: true },
      });
    }

    const adapterList = options.adapters ?? [createFakeAdapter()];
    for (const a of adapterList) {
      this.adapters.set(a.id, a);
    }
    if (!this.adapters.has(FAKE_ADAPTER_ID)) {
      this.adapters.set(FAKE_ADAPTER_ID, createFakeAdapter());
    }

    this.supervisor = new ProcessSupervisor({
      gracefulMs: options.gracefulMs ?? 2000,
      stdoutRingBytes: options.captureStdout === false ? 0 : 4096,
      onExit: (info) => {
        void this.onChildExit(info.sessionId, info.exitCode, info.signal);
      },
      onStdout: (sessionId, text) => {
        if (options.captureStdout === false) return;
        this.emit({ type: "session.stdout_tail", sessionId, text });
      },
    });
  }

  registerProfile(profile: AgentProfileConfig): void {
    this.profiles.set(profile.id, profile);
  }

  registerAdapter(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  /** Subscribe to all runtime events (service fan-out helper). */
  subscribeAll(sink: (ev: RuntimeEvent) => void): Unsubscribe {
    this.globalSinks.add(sink);
    return () => this.globalSinks.delete(sink);
  }

  subscribe(sessionId: string, sink: (ev: RuntimeEvent) => void): Unsubscribe {
    let set = this.sinks.get(sessionId);
    if (!set) {
      set = new Set();
      this.sinks.set(sessionId, set);
    }
    set.add(sink);
    return () => {
      set!.delete(sink);
      if (set!.size === 0) this.sinks.delete(sessionId);
    };
  }

  async startSession(req: StartSessionRequest): Promise<SessionHandle> {
    this.assertOpen();
    if (!isSessionId(req.sessionId)) {
      throw new Error(`Invalid session id: ${req.sessionId}`);
    }

    const existing = await this.registry.read(req.sessionId);
    if (existing && SessionRegistry.isNonTerminal(existing.state)) {
      throw new Error(`Session already active: ${req.sessionId}`);
    }

    const profile = this.profiles.get(req.profileId);
    if (!profile) {
      throw new Error(`Unknown AgentProfile: ${req.profileId}`);
    }

    const adapter = this.adapters.get(profile.adapterId);
    if (!adapter) {
      throw new Error(`Unknown adapter: ${profile.adapterId}`);
    }

    const caps = adapter.capabilities();
    if (!caps.canSpawn) {
      throw new Error(`Adapter ${adapter.id} cannot spawn (pull-host only)`);
    }

    const cwd =
      req.runtimeWorkspace?.cwd ??
      req.cwd ??
      req.workspaceLane?.worktree;
    if (!cwd) {
      throw new Error("startSession requires runtimeWorkspace.cwd, cwd, or workspaceLane.worktree");
    }

    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: req.sessionId,
      profileId: profile.id,
      adapterId: adapter.id,
      roleName: req.roleName,
      state: "starting",
      runtimeWorkspace: { cwd },
      workspace: req.workspace ?? req.workspaceLane?.workspace,
      workspaceLane: req.workspaceLane,
      createdAt: now,
      updatedAt: now,
      lastTaskId: req.lastTaskId,
    };
    await this.registry.write(record);
    this.emit({ type: "session.starting", sessionId: req.sessionId });

    try {
      const launch = await adapter.resolveLaunch({
        sessionId: req.sessionId,
        profileId: profile.id,
        roleName: req.roleName,
        cwd,
        env: { ...(profile.env ?? {}), ...(req.env ?? {}) },
        bootstrapPrompt: req.bootstrapPrompt,
        command: profile.command,
        args: profile.args,
        extras: { fake: profile.fake },
      });

      const proc = await this.supervisor.start(req.sessionId, launch);
      const resumeToken =
        profile.fake?.canResume || adapter.capabilities().canResume
          ? `fake-resume:${req.sessionId}`
          : undefined;

      const live = await this.registry.update(req.sessionId, {
        state: "live",
        pid: proc.pid,
        resumeToken,
        lastError: undefined,
        exitCode: undefined,
        stopReason: undefined,
      });

      this.emit({ type: "session.live", sessionId: req.sessionId, pid: proc.pid });
      return handleFrom(live);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed = await this.registry.update(req.sessionId, {
        state: "failed",
        lastError: message,
        pid: undefined,
      });
      this.emit({ type: "session.failed", sessionId: req.sessionId, error: message });
      // Surface failure to caller; record remains for probe/list honesty.
      throw Object.assign(new Error(message), { session: handleFrom(failed) });
    }
  }

  async resumeSession(req: ResumeSessionRequest): Promise<SessionHandle> {
    this.assertOpen();
    const record = await this.registry.read(req.sessionId);
    if (!record) throw new Error(`Session not found: ${req.sessionId}`);

    const profile = this.profiles.get(record.profileId);
    if (!profile) throw new Error(`Unknown AgentProfile: ${record.profileId}`);
    const adapter = this.adapters.get(record.adapterId);
    if (!adapter) throw new Error(`Unknown adapter: ${record.adapterId}`);

    const token = req.resumeToken ?? record.resumeToken;
    if (!token) {
      throw new Error(`Session ${req.sessionId} has no resume token`);
    }
    if (!adapter.capabilities().canResume && !profile.fake?.canResume) {
      throw new Error(`Adapter ${adapter.id} cannot resume`);
    }

    // Fake resume: re-spawn with same cwd; real providers will use parseResumeToken.
    const cwd =
      req.runtimeWorkspace?.cwd ??
      req.cwd ??
      record.runtimeWorkspace?.cwd;
    if (!cwd) throw new Error("resumeSession requires a cwd");

    return this.startSession({
      sessionId: req.sessionId,
      profileId: record.profileId,
      roleName: record.roleName,
      workspaceLane: record.workspaceLane,
      runtimeWorkspace: { cwd },
      workspace: record.workspace,
      lastTaskId: record.lastTaskId,
      env: req.env,
      bootstrapPrompt: undefined,
    });
  }

  async stopSession(sessionId: string, reason: StopReason): Promise<void> {
    this.assertOpen();
    const record = await this.registry.read(sessionId);
    if (!record) throw new Error(`Session not found: ${sessionId}`);

    const wasAlive = this.supervisor.isAlive(sessionId);
    if (wasAlive) {
      await this.supervisor.stop(sessionId, { signal: "SIGTERM" });
    }

    // onChildExit may race; re-read after process reaped and mark terminal.
    const current = await this.registry.read(sessionId);
    if (!current) return;

    if (SessionRegistry.isNonTerminal(current.state)) {
      await this.registry.update(sessionId, {
        state: "stopped",
        stopReason: reason,
        pid: undefined,
      });
      // Emit only if exit handler did not already (avoid chat-like spam; still lifecycle).
      this.emit({
        type: "session.exited",
        sessionId,
        exitCode: current.exitCode ?? 0,
      });
    } else {
      await this.registry.update(sessionId, {
        stopReason: reason,
        pid: undefined,
        state: current.state === "failed" ? "failed" : "stopped",
      });
    }
  }

  async probe(sessionId: string): Promise<SessionProbe> {
    const record = await this.registry.read(sessionId);
    if (!record) {
      return {
        sessionId,
        state: "failed",
        alive: false,
        resumeCapable: false,
        lastError: "session not found",
      };
    }

    const alive = this.supervisor.isAlive(sessionId);
    const profile = this.profiles.get(record.profileId);
    const adapter = this.adapters.get(record.adapterId);
    const resumeCapable = Boolean(
      record.resumeToken &&
        (adapter?.capabilities().canResume || profile?.fake?.canResume)
    );

    // Reconcile disk state with process reality (service restart / crash).
    if (SessionRegistry.isNonTerminal(record.state) && !alive) {
      const nextState = resumeCapable ? "stopped" : "failed";
      const updated = await this.registry.update(sessionId, {
        state: nextState,
        pid: undefined,
        lastError:
          record.lastError ??
          (resumeCapable
            ? "process not alive; resume token retained"
            : "process not alive and not resume-capable"),
      });
      return {
        sessionId,
        state: updated.state,
        alive: false,
        resumeCapable,
        lastError: updated.lastError,
        exitCode: updated.exitCode,
      };
    }

    return {
      sessionId,
      state: record.state,
      alive,
      resumeCapable,
      pid: alive ? record.pid : undefined,
      lastError: record.lastError,
      exitCode: record.exitCode,
    };
  }

  /**
   * On service start: probe all non-terminal sessions and reconcile.
   * Dead PID + not resume-capable → failed/stopped; resume-capable → keep metadata.
   */
  async reconcileOnBoot(): Promise<SessionProbe[]> {
    const all = await this.registry.list();
    const results: SessionProbe[] = [];
    for (const rec of all) {
      if (!SessionRegistry.isNonTerminal(rec.state)) continue;
      results.push(await this.probe(rec.id));
    }
    return results;
  }

  /** Service shutdown: stop push children this runtime started. */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    const live = this.supervisor.listLive();
    for (const id of live) {
      try {
        await this.stopSession(id, "shutdown");
      } catch {
        await this.supervisor.stop(id);
      }
    }
    await this.supervisor.stopAll("shutdown");
    this.closed = true;
  }

  private async onChildExit(
    sessionId: string,
    exitCode: number | null,
    signal?: string
  ): Promise<void> {
    const record = await this.registry.read(sessionId);
    if (!record) return;
    // If already terminal from stopSession, still emit exited once for listeners.
    const adapter = this.adapters.get(record.adapterId);
    let event: RuntimeEvent;
    if (adapter) {
      event = adapter.mapExit(exitCode, signal);
      event = { ...event, sessionId };
    } else if (exitCode === 0 || signal === "SIGTERM" || signal === "SIGINT") {
      event = { type: "session.exited", sessionId, exitCode };
    } else {
      event = {
        type: "session.failed",
        sessionId,
        error: signal ? `signal:${signal}` : `exit:${exitCode}`,
      };
    }

    const terminalState = event.type === "session.failed" ? "failed" : "stopped";
    // Preserve explicit stopReason if already set.
    if (SessionRegistry.isNonTerminal(record.state) || record.state === "starting") {
      await this.registry.update(sessionId, {
        state: terminalState,
        pid: undefined,
        exitCode,
        lastError: event.type === "session.failed" ? event.error : record.lastError,
      });
    } else {
      await this.registry.update(sessionId, {
        pid: undefined,
        exitCode,
      });
    }
    this.emit(event);
  }

  private emit(ev: RuntimeEvent): void {
    for (const sink of this.globalSinks) {
      try {
        sink(ev);
      } catch {
        // sink errors must not break runtime
      }
    }
    const set = this.sinks.get(ev.sessionId);
    if (!set) return;
    for (const sink of set) {
      try {
        sink(ev);
      } catch {
        // ignore
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("AgentRuntime is shut down");
  }
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  return new AgentRuntime(options);
}
