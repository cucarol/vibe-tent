// AgentRuntimePort implementation — service-internal only (B0 §4).
// Maps ProcessSupervisor + SessionRegistry + ProviderAdapter; no task/box writes.

import * as path from "node:path";
import type { ManagedSession, ProviderAdapter } from "../adapters/types.js";
import { FAKE_ADAPTER_ID, createFakeAdapter } from "../adapters/fake/index.js";
import { GROK_ACP_ADAPTER_ID, createGrokAcpAdapter } from "../adapters/grok-acp/index.js";
import {
  CODEX_ACP_ADAPTER_ID,
  createCodexAcpAdapter,
} from "../adapters/codex-acp/index.js";
import {
  CLAUDE_ACP_ADAPTER_ID,
  createClaudeAcpAdapter,
} from "../adapters/claude-acp/index.js";
import {
  ANTIGRAVITY_ACP_ADAPTER_ID,
  createAntigravityAcpAdapter,
} from "../adapters/antigravity-acp/index.js";
import {
  OPENCODE_ACP_ADAPTER_ID,
  createOpenCodeAcpAdapter,
} from "../adapters/opencode-acp/index.js";
import {
  COPILOT_ACP_ADAPTER_ID,
  createCopilotAcpAdapter,
} from "../adapters/copilot-acp/index.js";
import { cloneAgentProfileConfig } from "./profile-config.js";
import { ProcessSupervisor } from "./process-supervisor.js";
import { SessionRegistry } from "./session-registry.js";
import type {
  AgentProfileConfig,
  AgentRuntimePort,
  ResolveProfileEnv,
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
  /** Adapter registry; defaults include fake-cli and the explicit product ACP adapters. */
  adapters?: ProviderAdapter[];
  /** Graceful stop timeout for supervised children. */
  gracefulMs?: number;
  /** When true (default), capture short stdout tails as diagnostic events. */
  captureStdout?: boolean;
  /**
   * Optional async hook to resolve profile credentialRef → env values before LaunchPlan.
   * Service wires CredentialStore.resolve here. Secrets never enter SessionRecord.
   */
  resolveProfileEnv?: ResolveProfileEnv;
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

/** Shallow clone profile + one level of acp / fake (callers must not mutate the Map). */
function cloneProfileConfig(p: AgentProfileConfig): AgentProfileConfig {
  return cloneAgentProfileConfig(p);
}

export class AgentRuntime implements AgentRuntimePort {
  readonly registry: SessionRegistry;
  readonly supervisor: ProcessSupervisor;
  private readonly profiles = new Map<string, AgentProfileConfig>();
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly managed = new Map<string, ManagedSession>();
  private readonly resumeInFlight = new Map<string, Promise<SessionHandle>>();
  private readonly sinks = new Map<string, Set<(ev: RuntimeEvent) => void>>();
  private readonly globalSinks = new Set<(ev: RuntimeEvent) => void>();
  private readonly resolveProfileEnv?: ResolveProfileEnv;
  private closed = false;

  constructor(options: AgentRuntimeOptions) {
    this.registry = new SessionRegistry(options.dataDir);
    this.resolveProfileEnv = options.resolveProfileEnv;

    for (const p of options.profiles ?? []) {
      this.profiles.set(p.id, cloneProfileConfig(p));
    }
    // Always ensure a default fake profile for harness tests (tests only; not product default spawn).
    if (!this.profiles.has("fake-default")) {
      this.profiles.set("fake-default", {
        id: "fake-default",
        adapterId: FAKE_ADAPTER_ID,
        displayNameKey: "profile.fake.default",
        fake: { waitForSignal: true, emitStdout: true },
      });
    }

    const adapterList = options.adapters ?? [
      createFakeAdapter(),
      createGrokAcpAdapter(),
      createCodexAcpAdapter(),
      createClaudeAcpAdapter(),
      createAntigravityAcpAdapter(),
      createOpenCodeAcpAdapter(),
      createCopilotAcpAdapter(),
    ];
    for (const a of adapterList) {
      this.adapters.set(a.id, a);
    }
    if (!this.adapters.has(FAKE_ADAPTER_ID)) {
      this.adapters.set(FAKE_ADAPTER_ID, createFakeAdapter());
    }
    if (!this.adapters.has(GROK_ACP_ADAPTER_ID)) {
      this.adapters.set(GROK_ACP_ADAPTER_ID, createGrokAcpAdapter());
    }
    if (!this.adapters.has(CODEX_ACP_ADAPTER_ID)) {
      this.adapters.set(CODEX_ACP_ADAPTER_ID, createCodexAcpAdapter());
    }
    if (!this.adapters.has(CLAUDE_ACP_ADAPTER_ID)) {
      this.adapters.set(CLAUDE_ACP_ADAPTER_ID, createClaudeAcpAdapter());
    }
    if (!this.adapters.has(ANTIGRAVITY_ACP_ADAPTER_ID)) {
      this.adapters.set(ANTIGRAVITY_ACP_ADAPTER_ID, createAntigravityAcpAdapter());
    }
    if (!this.adapters.has(OPENCODE_ACP_ADAPTER_ID)) {
      this.adapters.set(OPENCODE_ACP_ADAPTER_ID, createOpenCodeAcpAdapter());
    }
    if (!this.adapters.has(COPILOT_ACP_ADAPTER_ID)) {
      this.adapters.set(COPILOT_ACP_ADAPTER_ID, createCopilotAcpAdapter());
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
    this.profiles.set(profile.id, cloneProfileConfig(profile));
  }

  /**
   * Full replace of the in-memory profile catalog (machine-local CRUD sync).
   * Does not touch live sessions — only new startSession sees the new map.
   * Always re-ensures fake-default for harness (same rule as constructor).
   * Stores shallow clones of profile + acp so callers cannot mutate the map.
   */
  replaceProfileCatalog(profiles: AgentProfileConfig[]): void {
    this.profiles.clear();
    for (const p of profiles) {
      if (p && typeof p.id === "string") {
        this.profiles.set(p.id, cloneProfileConfig(p));
      }
    }
    if (!this.profiles.has("fake-default")) {
      this.profiles.set("fake-default", {
        id: "fake-default",
        adapterId: FAKE_ADAPTER_ID,
        displayNameKey: "profile.fake.default",
        fake: { waitForSignal: true, emitStdout: true },
      });
    }
  }

  /** Lookup a single machine-local profile (cloned; mutating the return does not corrupt the Map). */
  getProfile(profileId: string): AgentProfileConfig | undefined {
    const p = this.profiles.get(profileId);
    return p ? cloneProfileConfig(p) : undefined;
  }

  /** Machine-local catalog snapshot (cloned entries). */
  listProfiles(): AgentProfileConfig[] {
    return [...this.profiles.values()].map(cloneProfileConfig);
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
      // Resolve after the diagnostic row exists, so a missing/stale vault reference
      // becomes an ordinary failed session without ever persisting the plaintext.
      const resolvedEnv = await this.resolveCredentialEnv(profile);
      // Vault injection wins for envKey; profile.env / req.env supply non-secret knobs.
      const plan = {
        sessionId: req.sessionId,
        profileId: profile.id,
        roleName: req.roleName,
        cwd,
        env: { ...(profile.env ?? {}), ...(req.env ?? {}), ...resolvedEnv },
        bootstrapPrompt: req.bootstrapPrompt,
        command: profile.command,
        args: profile.args,
        extras: {
          fake: profile.fake,
          acp: profile.acp,
        },
      };

      let pid: number | undefined;
      let resumeToken: string | undefined;
      let sawLive = false;
      let terminalDuringManagedStart:
        | { state: "failed"; error: string }
        | { state: "stopped"; exitCode: number | null }
        | undefined;

      if (typeof adapter.startManagedSession === "function") {
        // ACP / structured transports own stdio — not ProcessSupervisor.
        const managed = await adapter.startManagedSession(plan, (ev) => {
          if (ev.type === "session.live") sawLive = true;
          // Managed failure: mark terminal + drop handle so probe never claims live orphan.
          // Service maps task failed separately (idempotent). Process stop is adapter-owned.
          if (ev.type === "session.failed") {
            terminalDuringManagedStart = { state: "failed", error: ev.error };
            void this.onManagedTerminal(req.sessionId, "failed", ev.error);
          } else if (ev.type === "session.exited") {
            terminalDuringManagedStart = {
              state: "stopped",
              exitCode: ev.exitCode,
            };
            void this.onManagedTerminal(req.sessionId, "stopped", undefined, ev.exitCode);
          } else if (ev.type === "session.waiting_user") {
            void this.registry
              .update(req.sessionId, { state: "waiting-user" })
              .catch(() => undefined);
          } else if (ev.type === "session.live") {
            void this.registry
              .update(req.sessionId, {
                state: "live",
                ...(ev.pid != null ? { pid: ev.pid } : {}),
              })
              .catch(() => undefined);
          }
          this.emit(ev);
        });
        if (terminalDuringManagedStart) {
          const terminal = terminalDuringManagedStart as
            | { state: "failed"; error: string }
            | { state: "stopped"; exitCode: number | null };
          await this.onManagedTerminal(
            req.sessionId,
            terminal.state,
            terminal.state === "failed" ? terminal.error : undefined,
            terminal.state === "stopped" ? terminal.exitCode : undefined
          );
          throw Object.assign(
            new Error(
              terminal.state === "failed"
                ? terminal.error
                : `Managed session exited during startup (code=${terminal.exitCode})`
            ),
            { terminalAlreadyEmitted: true }
          );
        }
        this.managed.set(req.sessionId, managed);
        pid = managed.pid;
        // Provider session id is machine-local resume/debug metadata only — not workspace.
        if (managed.providerSessionId) {
          resumeToken = managed.providerSessionId;
        }
      } else {
        const launch = await adapter.resolveLaunch(plan);
        const proc = await this.supervisor.start(req.sessionId, launch);
        pid = proc.pid;
        resumeToken =
          profile.fake?.canResume || adapter.capabilities().canResume
            ? `fake-resume:${req.sessionId}`
            : undefined;
        this.emit({ type: "session.live", sessionId: req.sessionId, pid: proc.pid });
        sawLive = true;
      }

      const live = await this.registry.update(req.sessionId, {
        state: "live",
        pid,
        resumeToken,
        lastError: undefined,
        exitCode: undefined,
        stopReason: undefined,
      });

      if (!sawLive) {
        this.emit({ type: "session.live", sessionId: req.sessionId, pid });
      }
      return handleFrom(live);
    } catch (err) {
      this.managed.delete(req.sessionId);
      const message = err instanceof Error ? err.message : String(err);
      const failed = await this.registry.update(req.sessionId, {
        state: "failed",
        lastError: message,
        pid: undefined,
      });
      if (!(err as { terminalAlreadyEmitted?: boolean })?.terminalAlreadyEmitted) {
        this.emit({ type: "session.failed", sessionId: req.sessionId, error: message });
      }
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

    const tokenRaw = req.resumeToken ?? record.resumeToken;
    if (!tokenRaw) {
      throw new Error(`Session ${req.sessionId} has no resume token`);
    }
    if (!adapter.capabilities().canResume && !profile.fake?.canResume) {
      throw new Error(`Adapter ${adapter.id} cannot resume`);
    }

    // Must reuse recorded cwd / lane — never cross worktrees on load.
    const recordedCwd = record.runtimeWorkspace?.cwd;
    const requestedCwd = req.runtimeWorkspace?.cwd ?? req.cwd;
    if (recordedCwd && requestedCwd && !sameRuntimeCwd(recordedCwd, requestedCwd)) {
      throw new Error(
        `resumeSession cwd mismatch: recorded=${recordedCwd} requested=${requestedCwd}`
      );
    }
    const cwd = recordedCwd ?? requestedCwd;
    if (!cwd) throw new Error("resumeSession requires a cwd");

    // Fake-only path: re-spawn via startSession (no provider-native load).
    // Real ACP adapters with canResume must implement resumeManagedSession.
    if (profile.fake?.canResume && typeof adapter.resumeManagedSession !== "function") {
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

    if (typeof adapter.resumeManagedSession !== "function") {
      throw new Error(
        `Adapter ${adapter.id} advertises canResume but does not implement resumeManagedSession`
      );
    }
    const resumeManagedSession = adapter.resumeManagedSession.bind(adapter);

    const existingResume = this.resumeInFlight.get(req.sessionId);
    if (existingResume) return existingResume;

    const operation = (async (): Promise<SessionHandle> => {
      let resumedManaged: ManagedSession | undefined;

    // Existing non-terminal row is expected after service restart (stopped + token).
    // Re-open the same Tent session id with a new bridge process + native load.
    if (SessionRegistry.isNonTerminal(record.state)) {
      const managed = this.managed.get(req.sessionId);
      if (managed?.isAlive()) {
        throw new Error(`Session already active: ${req.sessionId}`);
      }
      // Drop stale in-memory handle if present (dead after restart).
      this.managed.delete(req.sessionId);
    }

    const now = new Date().toISOString();
    await this.registry.update(req.sessionId, {
      state: "starting",
      pid: undefined,
      lastError: undefined,
      exitCode: undefined,
      stopReason: undefined,
      runtimeWorkspace: { cwd },
      updatedAt: now,
    });
    this.emit({ type: "session.starting", sessionId: req.sessionId });

    try {
      const resolvedEnv = await this.resolveCredentialEnv(profile);
      const plan = {
        sessionId: req.sessionId,
        profileId: profile.id,
        roleName: record.roleName,
        cwd,
        env: { ...(profile.env ?? {}), ...(req.env ?? {}), ...resolvedEnv },
        bootstrapPrompt: req.bootstrapPrompt,
        command: profile.command,
        args: profile.args,
        extras: {
          fake: profile.fake,
          acp: profile.acp,
        },
      };

      const resumeToken = adapter.parseResumeToken
        ? adapter.parseResumeToken(tokenRaw)
        : { raw: tokenRaw, providerSessionId: tokenRaw };

      let sawLive = false;
      let terminalDuringManagedStart:
        | { state: "failed"; error: string }
        | { state: "stopped"; exitCode: number | null }
        | undefined;

      const managed = await resumeManagedSession(
        plan,
        resumeToken,
        (ev) => {
          if (ev.type === "session.live") sawLive = true;
          if (ev.type === "session.failed") {
            terminalDuringManagedStart = { state: "failed", error: ev.error };
            void this.onManagedTerminal(req.sessionId, "failed", ev.error);
          } else if (ev.type === "session.exited") {
            terminalDuringManagedStart = {
              state: "stopped",
              exitCode: ev.exitCode,
            };
            void this.onManagedTerminal(
              req.sessionId,
              "stopped",
              undefined,
              ev.exitCode
            );
          } else if (ev.type === "session.waiting_user") {
            void this.registry
              .update(req.sessionId, { state: "waiting-user" })
              .catch(() => undefined);
          } else if (ev.type === "session.live") {
            void this.registry
              .update(req.sessionId, {
                state: "live",
                ...(ev.pid != null ? { pid: ev.pid } : {}),
              })
              .catch(() => undefined);
          }
          this.emit(ev);
        }
      );
      resumedManaged = managed;

      if (terminalDuringManagedStart) {
        const terminal = terminalDuringManagedStart as
          | { state: "failed"; error: string }
          | { state: "stopped"; exitCode: number | null };
        await this.onManagedTerminal(
          req.sessionId,
          terminal.state,
          terminal.state === "failed" ? terminal.error : undefined,
          terminal.state === "stopped" ? terminal.exitCode : undefined
        );
        throw Object.assign(
          new Error(
            terminal.state === "failed"
              ? terminal.error
              : `Managed session exited during resume (code=${terminal.exitCode})`
          ),
          { terminalAlreadyEmitted: true }
        );
      }

      this.managed.set(req.sessionId, managed);
      const pid = managed.pid;
      // Keep original provider token; load reuses the same provider session id.
      const nextToken =
        managed.providerSessionId?.trim() || tokenRaw;

      const live = await this.registry.update(req.sessionId, {
        state: "live",
        pid,
        resumeToken: nextToken,
        lastError: undefined,
        exitCode: undefined,
        stopReason: undefined,
        runtimeWorkspace: { cwd },
      });

      if (!sawLive) {
        this.emit({ type: "session.live", sessionId: req.sessionId, pid });
      }
      return handleFrom(live);
    } catch (err) {
      this.managed.delete(req.sessionId);
      if (resumedManaged) {
        await resumedManaged.stop("interrupt").catch(() => undefined);
      }
      const rawMessage = err instanceof Error ? err.message : String(err);
      const message = redactRuntimeValue(rawMessage, tokenRaw);
      const failed = await this.registry.update(req.sessionId, {
        state: "failed",
        lastError: message,
        pid: undefined,
      });
      if (!(err as { terminalAlreadyEmitted?: boolean })?.terminalAlreadyEmitted) {
        this.emit({ type: "session.failed", sessionId: req.sessionId, error: message });
      }
      throw Object.assign(new Error(message), { session: handleFrom(failed) });
    }
    })();

    this.resumeInFlight.set(req.sessionId, operation);
    try {
      return await operation;
    } finally {
      if (this.resumeInFlight.get(req.sessionId) === operation) {
        this.resumeInFlight.delete(req.sessionId);
      }
    }
  }

  async stopSession(sessionId: string, reason: StopReason): Promise<void> {
    this.assertOpen();
    const record = await this.registry.read(sessionId);
    if (!record) throw new Error(`Session not found: ${sessionId}`);

    const managed = this.managed.get(sessionId);
    if (managed) {
      try {
        await managed.stop(reason);
      } finally {
        this.managed.delete(sessionId);
      }
    } else if (this.supervisor.isAlive(sessionId)) {
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

    const managed = this.managed.get(sessionId);
    const alive = managed ? managed.isAlive() : this.supervisor.isAlive(sessionId);
    const profile = this.profiles.get(record.profileId);
    const adapter = this.adapters.get(record.adapterId);
    const resumeCapable = Boolean(
      record.resumeToken &&
        (adapter?.capabilities().canResume || profile?.fake?.canResume)
    );

    // Reconcile disk state with process reality (service restart / crash).
    if (SessionRegistry.isNonTerminal(record.state) && !alive) {
      // Managed process exited outside stopSession — clear handle.
      if (managed) this.managed.delete(sessionId);
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
   * Note: managed ACP clients do not survive process restart — probe marks them dead.
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

  /** Service shutdown: stop push children this runtime started (window close does not call this). */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    const managedIds = [...this.managed.keys()];
    const live = new Set([...this.supervisor.listLive(), ...managedIds]);
    for (const id of live) {
      try {
        await this.stopSession(id, "shutdown");
      } catch {
        const m = this.managed.get(id);
        if (m) {
          try {
            await m.stop("shutdown");
          } catch {
            // best-effort
          }
          this.managed.delete(id);
        } else {
          await this.supervisor.stop(id);
        }
      }
    }
    await this.supervisor.stopAll("shutdown");
    this.closed = true;
  }

  /**
   * Managed ACP terminal path (no ProcessSupervisor exit). Idempotent:
   * second failure/exit does not illegal-transition the session row.
   */
  private async onManagedTerminal(
    sessionId: string,
    terminalState: "failed" | "stopped",
    lastError?: string,
    exitCode?: number | null
  ): Promise<void> {
    this.managed.delete(sessionId);
    const record = await this.registry.read(sessionId);
    if (!record) return;
    if (!SessionRegistry.isNonTerminal(record.state) && record.state !== "starting") {
      // Already terminal — only refresh diagnostics.
      await this.registry.update(sessionId, {
        pid: undefined,
        ...(lastError ? { lastError } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
      });
      return;
    }
    await this.registry.update(sessionId, {
      state: terminalState,
      pid: undefined,
      lastError: lastError ?? record.lastError,
      ...(exitCode !== undefined ? { exitCode } : {}),
    });
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

  /**
   * When profile.acp.credentialRef is set, call resolveProfileEnv and require
   * a non-empty value for profile.acp.envKey. Fail-loud otherwise.
   * Never persists secrets onto SessionRecord.
   */
  private async resolveCredentialEnv(
    profile: AgentProfileConfig
  ): Promise<Record<string, string>> {
    const ref =
      typeof profile.acp?.credentialRef === "string"
        ? profile.acp.credentialRef.trim()
        : "";
    if (!ref) return {};

    const envKey =
      typeof profile.acp?.envKey === "string" ? profile.acp.envKey.trim() : "";
    if (!envKey) {
      throw new Error(
        `Profile ${profile.id} has credentialRef but no acp.envKey (cannot inject secret into process env)`
      );
    }
    if (!this.resolveProfileEnv) {
      throw new Error(
        `Profile ${profile.id} references credential ${ref} but AgentRuntime has no resolveProfileEnv hook`
      );
    }
    const resolved = { ...(await this.resolveProfileEnv(profile)) };
    const secret = resolved[envKey];
    if (typeof secret !== "string" || !secret) {
      throw new Error(
        `Credential not found or empty for profile ${profile.id} (credentialRef=${ref})`
      );
    }
    // Only expose the configured envKey mapping (drop accidental extra keys from hooks).
    return { [envKey]: secret };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("AgentRuntime is shut down");
  }
}

function sameRuntimeCwd(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function redactRuntimeValue(message: string, value: string): string {
  return value ? message.split(value).join("[provider-session]") : message;
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  return new AgentRuntime(options);
}
