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
import {
  PI_ACP_ADAPTER_ID,
  createPiAcpAdapter,
} from "../adapters/pi-acp/index.js";
import {
  resolveAcpMcpServersWire,
  resolveAcpSkillMeta,
} from "../adapters/acp/mcp-skills.js";
import { composeManagedSkillRefs } from "../core/managed-skill-compose.js";
import {
  cloneAgentProfileConfig,
  cloneAgentProfileConfigForSnapshot,
} from "./profile-config.js";
import { stripReservedTentChildEnv } from "./child-env.js";
import { ProcessSupervisor } from "./process-supervisor.js";
import { SessionRegistry } from "./session-registry.js";
import { redactDiagnosticText } from "../adapters/acp/redact.js";
import type {
  AgentProfileConfig,
  AgentRuntimePort,
  EnterExternalSessionRequest,
  ResolveCredentialRef,
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
import {
  EXTERNAL_ADAPTER_ID,
  EXTERNAL_PROFILE_ID,
  isSessionId,
  makeSessionId,
  recordExternalKey,
} from "./types.js";

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
  /**
   * Optional hook to resolve arbitrary credential ids for MCP env/header injection.
   * Process-scoped only; never persisted on SessionRecord.
   */
  resolveCredentialRef?: ResolveCredentialRef;
  /**
   * Package root for bundled tent-role / tent-task skill paths.
   * When set, managed sessions automatically compose built-in skill refs
   * (profile.skills remain optional extras).
   */
  packageRoot?: string;
}

function handleFrom(record: SessionRecord): SessionHandle {
  return {
    sessionId: record.id,
    profileId: record.profileId,
    adapterId: record.adapterId,
    state: record.state,
    pid: record.pid,
    roleName: record.roleName,
    assigneeKind: record.assigneeKind,
    runtimeWorkspace: record.runtimeWorkspace,
    ...(record.contextRestored !== undefined
      ? { contextRestored: record.contextRestored }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Shallow clone profile + one level of acp / fake (callers must not mutate the Map). */
function cloneProfileConfig(p: AgentProfileConfig): AgentProfileConfig {
  return cloneAgentProfileConfig(p);
}

/** Snapshot written to SessionRegistry — secret-named env values redacted. */
function cloneProfileSnapshot(p: AgentProfileConfig): AgentProfileConfig {
  return cloneAgentProfileConfigForSnapshot(p);
}

export class AgentRuntime implements AgentRuntimePort {
  readonly registry: SessionRegistry;
  readonly supervisor: ProcessSupervisor;
  /** Owning Service data directory; inherited by managed children for native Tent hooks. */
  private readonly dataDir: string;
  private readonly profiles = new Map<string, AgentProfileConfig>();
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly managed = new Map<string, ManagedSession>();
  private readonly startInFlight = new Map<string, Promise<SessionHandle>>();
  private readonly resumeInFlight = new Map<string, Promise<SessionHandle>>();
  private readonly childExitInFlight = new Map<string, Promise<void>>();
  private readonly managedTerminalInFlight = new Map<string, Set<Promise<void>>>();
  private readonly sinks = new Map<string, Set<(ev: RuntimeEvent) => void>>();
  private readonly globalSinks = new Set<(ev: RuntimeEvent) => void>();
  private readonly resolveProfileEnv?: ResolveProfileEnv;
  private readonly resolveCredentialRef?: ResolveCredentialRef;
  private readonly packageRoot?: string;
  /** Test-only: every sendFollowUpPrompt attempt (including not-alive / unsupported). */
  private readonly followUpAttemptsForTests: Array<{ sessionId: string }> = [];
  private shutdownPromise?: Promise<void>;
  private closing = false;
  private closed = false;

  constructor(options: AgentRuntimeOptions) {
    // Children run in Task worktrees, so a relative data-dir would resolve to a
    // different registry there. Normalize once at the runtime ownership boundary.
    this.dataDir = path.resolve(options.dataDir);
    this.registry = new SessionRegistry(this.dataDir);
    this.resolveProfileEnv = options.resolveProfileEnv;
    this.resolveCredentialRef = options.resolveCredentialRef;
    this.packageRoot = options.packageRoot;

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
      createPiAcpAdapter(),
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
    if (!this.adapters.has(PI_ACP_ADAPTER_ID)) {
      this.adapters.set(PI_ACP_ADAPTER_ID, createPiAcpAdapter());
    }

    this.supervisor = new ProcessSupervisor({
      gracefulMs: options.gracefulMs ?? 2000,
      stdoutRingBytes: options.captureStdout === false ? 0 : 4096,
      onExit: (info) => {
        const projection = this.onChildExit(info.sessionId, info.exitCode, info.signal);
        this.childExitInFlight.set(info.sessionId, projection);
        void projection
          .finally(() => {
            if (this.childExitInFlight.get(info.sessionId) === projection) {
              this.childExitInFlight.delete(info.sessionId);
            }
          })
          .catch(() => undefined);
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
    if (this.startInFlight.has(req.sessionId)) {
      throw new Error(`Session start already in progress: ${req.sessionId}`);
    }
    if (this.resumeInFlight.has(req.sessionId)) {
      throw new Error(`Session resume already in progress: ${req.sessionId}`);
    }

    const operation = this.startSessionExclusive(req);
    this.startInFlight.set(req.sessionId, operation);
    try {
      return await operation;
    } finally {
      if (this.startInFlight.get(req.sessionId) === operation) {
        this.startInFlight.delete(req.sessionId);
      }
    }
  }

  /**
   * Register a pull-host / external GUI session without spawning ACP.
   * Idempotent: same sessionId or externalKey while state remains external reuses the row.
   */
  async enterExternalSession(req: EnterExternalSessionRequest): Promise<SessionHandle> {
    this.assertOpen();

    const externalKey = req.externalKey?.trim() || undefined;
    const profileId = (req.profileId?.trim() || EXTERNAL_PROFILE_ID).trim();
    const roleName = req.roleName?.trim() || undefined;
    const assigneeKind = req.assigneeKind;
    const workspace = req.workspace?.trim() || undefined;
    const cwd =
      req.runtimeWorkspace?.cwd ?? req.cwd ?? req.workspaceLane?.worktree ?? undefined;

    // 1) Explicit sessionId: reuse if still external; refuse if managed open.
    if (req.sessionId) {
      if (!isSessionId(req.sessionId)) {
        throw new Error(`Invalid session id: ${req.sessionId}`);
      }
      const existing = await this.registry.read(req.sessionId);
      if (existing) {
        if (existing.state === "external") {
          const patch: Partial<SessionRecord> = {};
          if (roleName && existing.roleName !== roleName) patch.roleName = roleName;
          if (assigneeKind && existing.assigneeKind !== assigneeKind) {
            patch.assigneeKind = assigneeKind;
          }
          if (workspace && existing.workspace !== workspace) patch.workspace = workspace;
          if (cwd && existing.runtimeWorkspace?.cwd !== cwd) {
            patch.runtimeWorkspace = { cwd };
          }
          if (req.lastTaskId && existing.lastTaskId !== req.lastTaskId) {
            patch.lastTaskId = req.lastTaskId;
          }
          if (externalKey && existing.externalKey !== externalKey) {
            patch.externalKey = externalKey;
          }
          if (Object.keys(patch).length > 0) {
            const updated = await this.registry.update(req.sessionId, patch);
            return handleFrom(updated);
          }
          return handleFrom(existing);
        }
        if (SessionRegistry.isNonTerminal(existing.state)) {
          throw new Error(
            `Session already active as managed runtime (state=${existing.state}): ${req.sessionId}`
          );
        }
        // Terminal row: re-open as external with the same id (replace metadata).
      }
    }

    // 2) externalKey / role+workspace idempotency: reuse open external row.
    if (externalKey || (workspace && roleName)) {
      const all = await this.registry.list();
      const match = all.find((rec) => {
        if (rec.state !== "external") return false;
        if (workspace && rec.workspace && rec.workspace !== workspace) return false;
        if (externalKey) {
          return recordExternalKey(rec) === externalKey;
        }
        // Soft match: same workspace + role label for hook re-enter without key.
        return Boolean(roleName && rec.roleName === roleName);
      });
      if (match) {
        const patch: Partial<SessionRecord> = {};
        if (req.lastTaskId && match.lastTaskId !== req.lastTaskId) {
          patch.lastTaskId = req.lastTaskId;
        }
        if (cwd && match.runtimeWorkspace?.cwd !== cwd) {
          patch.runtimeWorkspace = { cwd };
        }
        if (externalKey && match.externalKey !== externalKey) {
          patch.externalKey = externalKey;
        }
        if (Object.keys(patch).length > 0) {
          const updated = await this.registry.update(match.id, patch);
          return handleFrom(updated);
        }
        return handleFrom(match);
      }
    }

    const sessionId = req.sessionId && isSessionId(req.sessionId) ? req.sessionId : makeSessionId();
    const now = new Date().toISOString();
    const profileSnapshot: AgentProfileConfig = {
      id: profileId,
      adapterId: EXTERNAL_ADAPTER_ID,
    };
    const record: SessionRecord = {
      id: sessionId,
      profileId,
      adapterId: EXTERNAL_ADAPTER_ID,
      profileSnapshot,
      roleName,
      assigneeKind,
      state: "external",
      runtimeWorkspace: cwd ? { cwd } : undefined,
      workspace,
      workspaceLane: req.workspaceLane,
      createdAt: now,
      updatedAt: now,
      lastTaskId: req.lastTaskId,
      ...(externalKey ? { externalKey } : {}),
    };
    await this.registry.write(record);
    // No session.starting / session.live process events — external has no child.
    return handleFrom(record);
  }

  private async startSessionExclusive(req: StartSessionRequest): Promise<SessionHandle> {
    const existing = await this.registry.read(req.sessionId);
    if (existing && SessionRegistry.isNonTerminal(existing.state)) {
      throw new Error(`Session already active: ${req.sessionId}`);
    }

    const profile = this.profiles.get(req.profileId);
    if (!profile) {
      throw new Error(`Unknown AgentProfile: ${req.profileId}`);
    }
    return this.startSessionWithProfile(req, cloneProfileConfig(profile));
  }

  private async startSessionWithProfile(
    req: StartSessionRequest,
    profile: AgentProfileConfig
  ): Promise<SessionHandle> {
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
      profileSnapshot: cloneProfileSnapshot(profile),
      roleName: req.roleName,
      assigneeKind: req.assigneeKind,
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

    let startedManaged: ManagedSession | undefined;
    let resolvedEnv: Record<string, string> = {};
    try {
      // Resolve after the diagnostic row exists, so a missing/stale vault reference
      // becomes an ordinary failed session without ever persisting the plaintext.
      resolvedEnv = await this.resolveCredentialEnv(profile);
      // Vault injection wins for envKey; profile.env / req.env supply non-secret knobs.
      // Reserved Tent Service/data-dir/session keys are Core-owned and cannot be
      // overridden by arbitrary profile or request env.
      // Profile/request cannot set reserved keys (stripped). Core mirrors reserved
      // into plan.env for adapter/hook visibility; spawn authority is coreEnv only.
      const coreEnv = {
        // Reserved routing authority: installed native Tent hooks spawned by an
        // isolated Service must attach back to that Service, never %APPDATA%\Tent.
        TENT_SERVICE_DATA_DIR: this.dataDir,
        TENT_SESSION_ID: req.sessionId,
      };
      const planEnv = {
        ...stripProfileRequestEnv(profile.env),
        ...stripProfileRequestEnv(req.env),
        ...resolvedEnv,
        ...coreEnv,
      };
      const diagnosticSecrets = Object.values(resolvedEnv).filter(
        (v): v is string => typeof v === "string" && v.length > 0
      );
      const plan = {
        sessionId: req.sessionId,
        profileId: profile.id,
        roleName: req.roleName,
        cwd,
        env: planEnv,
        coreEnv,
        diagnosticSecrets,
        bootstrapPrompt: req.bootstrapPrompt,
        // Ephemeral path refs only — never base64; not written to SessionRecord.
        bootstrapImageRefs: req.bootstrapImageRefs,
        command: profile.command,
        args: profile.args,
        extras: {
          fake: profile.fake,
          acp: profile.acp,
          // Snapshot-time ACP projection (skills + mcp). Running sessions do not hot-reload.
          ...(await this.buildAcpLaunchExtras(profile, planEnv, req.assigneeKind)),
          // System root for safe image byte reads at prompt time (ephemeral; not SessionRecord).
          ...(req.bootstrapImageRefs &&
          req.bootstrapImageRefs.length > 0 &&
          typeof req.bootstrapImageSystemRoot === "string" &&
          req.bootstrapImageSystemRoot.trim()
            ? { bootstrapImageSystemRoot: req.bootstrapImageSystemRoot.trim() }
            : {}),
        },
      };

      let pid: number | undefined;
      let resumeToken: string | undefined;
      let startupCommitted = false;
      let startupLivePid: number | undefined;
      let terminalProjection: Promise<void> | undefined;
      let terminalDuringManagedStart:
        | { state: "failed"; error: string }
        | { state: "stopped"; exitCode: number | null }
        | undefined;

      if (typeof adapter.startManagedSession === "function") {
        // ACP / structured transports own stdio — not ProcessSupervisor.
        const managed = await adapter.startManagedSession(plan, (ev) => {
          // Managed failure: mark terminal + drop handle so probe never claims live orphan.
          // Service maps task failed separately (idempotent). Process stop is adapter-owned.
          if (ev.type === "session.failed") {
            terminalDuringManagedStart = { state: "failed", error: ev.error };
            terminalProjection = this.trackManagedTerminal(
              req.sessionId,
              "failed",
              ev.error
            );
          } else if (ev.type === "session.exited") {
            terminalDuringManagedStart = {
              state: "stopped",
              exitCode: ev.exitCode,
            };
            terminalProjection = this.trackManagedTerminal(
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
            if (!startupCommitted) {
              startupLivePid = ev.pid;
              return;
            }
            void this.registry
              .update(req.sessionId, {
                state: "live",
                ...(ev.pid != null ? { pid: ev.pid } : {}),
              })
              .catch(() => undefined);
          }
          this.emit(ev);
        });
        startedManaged = managed;
        if (terminalDuringManagedStart) {
          const terminal = terminalDuringManagedStart as
            | { state: "failed"; error: string }
            | { state: "stopped"; exitCode: number | null };
          await (
            terminalProjection ??
            this.trackManagedTerminal(
              req.sessionId,
              terminal.state,
              terminal.state === "failed" ? terminal.error : undefined,
              terminal.state === "stopped" ? terminal.exitCode : undefined
            )
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
        // Core reserved overlay + credential secrets for redaction — not adapter authority.
        const proc = await this.supervisor.start(req.sessionId, {
          ...launch,
          coreEnv: {
            ...launch.coreEnv,
            ...coreEnv,
          },
          diagnosticSecrets: [
            ...(launch.diagnosticSecrets ?? []),
            ...diagnosticSecrets,
          ],
        });
        pid = proc.pid;
        resumeToken =
          profile.fake?.canResume || adapter.capabilities().canResume
            ? `fake-resume:${req.sessionId}`
            : undefined;
      }

      const live = await this.registry.update(req.sessionId, {
        state: "live",
        pid,
        resumeToken,
        lastError: undefined,
        exitCode: undefined,
        stopReason: undefined,
      });
      startupCommitted = true;
      this.emit({
        type: "session.live",
        sessionId: req.sessionId,
        pid: startupLivePid ?? pid,
      });
      return handleFrom(live);
    } catch (err) {
      this.managed.delete(req.sessionId);
      if (startedManaged) {
        await startedManaged.stop("interrupt").catch(() => undefined);
        await this.waitForManagedTerminal(req.sessionId, true);
      } else if (this.supervisor.isAlive(req.sessionId)) {
        await this.supervisor.stop(req.sessionId).catch(() => undefined);
        await this.waitForChildExit(req.sessionId, true);
      }
      const rawMessage = err instanceof Error ? err.message : String(err);
      // Never persist raw credential values into SessionRegistry / Service errors.
      const message = redactDiagnosticText(rawMessage, {
        env: {
          ...(profile.env ?? {}),
          ...(req.env ?? {}),
        },
        secrets: Object.values(resolvedEnv),
      });
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
    if (this.startInFlight.has(req.sessionId)) {
      throw new Error(`Session start already in progress: ${req.sessionId}`);
    }
    const existingResume = this.resumeInFlight.get(req.sessionId);
    if (existingResume) return existingResume;

    const operation = this.resumeSessionExclusive(req);
    this.resumeInFlight.set(req.sessionId, operation);
    try {
      return await operation;
    } finally {
      if (this.resumeInFlight.get(req.sessionId) === operation) {
        this.resumeInFlight.delete(req.sessionId);
      }
    }
  }

  private async resumeSessionExclusive(req: ResumeSessionRequest): Promise<SessionHandle> {
    const record = await this.registry.read(req.sessionId);
    if (!record) throw new Error(`Session not found: ${req.sessionId}`);

    const profile = this.profileForResume(record);
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
    // Preserve bootstrapPrompt so reject-resume rework / post-load prompts reach the child.
    if (profile.fake?.canResume && typeof adapter.resumeManagedSession !== "function") {
      const handle = await this.startSessionWithProfile({
        sessionId: req.sessionId,
        profileId: record.profileId,
        roleName: record.roleName,
        assigneeKind: record.assigneeKind,
        workspaceLane: record.workspaceLane,
        runtimeWorkspace: { cwd },
        workspace: record.workspace,
        lastTaskId: req.lastTaskId ?? record.lastTaskId,
        env: req.env,
        bootstrapPrompt: req.bootstrapPrompt,
        bootstrapImageRefs: req.bootstrapImageRefs,
        bootstrapImageSystemRoot: req.bootstrapImageSystemRoot,
      }, profile);
      // Fake resume reuses the same Tent session id — mark continuity restored.
      const marked = await this.registry.update(req.sessionId, {
        contextRestored: true,
      });
      return handleFrom(marked);
    }

    if (typeof adapter.resumeManagedSession !== "function") {
      throw new Error(
        `Adapter ${adapter.id} advertises canResume but does not implement resumeManagedSession`
      );
    }
    const resumeManagedSession = adapter.resumeManagedSession.bind(adapter);

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
      lastTaskId: req.lastTaskId ?? record.lastTaskId,
      updatedAt: now,
    });
    this.emit({ type: "session.starting", sessionId: req.sessionId });

    let resolvedEnv: Record<string, string> = {};
    try {
      resolvedEnv = await this.resolveCredentialEnv(profile);
      // Preserve the owning Service boundary across provider-native resume.
      // Reserved keys remain Core-owned (profile/request cannot override).
      const coreEnv = {
        TENT_SERVICE_DATA_DIR: this.dataDir,
        TENT_SESSION_ID: req.sessionId,
      };
      const planEnv = {
        ...stripProfileRequestEnv(profile.env),
        ...stripProfileRequestEnv(req.env),
        ...resolvedEnv,
        ...coreEnv,
      };
      const diagnosticSecrets = Object.values(resolvedEnv).filter(
        (v): v is string => typeof v === "string" && v.length > 0
      );
      const plan = {
        sessionId: req.sessionId,
        profileId: profile.id,
        roleName: record.roleName,
        cwd,
        env: planEnv,
        coreEnv,
        diagnosticSecrets,
        bootstrapPrompt: req.bootstrapPrompt,
        bootstrapImageRefs: req.bootstrapImageRefs,
        command: profile.command,
        args: profile.args,
        extras: {
          fake: profile.fake,
          acp: profile.acp,
          // Resume uses profileSnapshot (not live catalog edits).
          ...(await this.buildAcpLaunchExtras(profile, planEnv, record.assigneeKind)),
          ...(req.bootstrapImageRefs &&
          req.bootstrapImageRefs.length > 0 &&
          typeof req.bootstrapImageSystemRoot === "string" &&
          req.bootstrapImageSystemRoot.trim()
            ? { bootstrapImageSystemRoot: req.bootstrapImageSystemRoot.trim() }
            : {}),
        },
      };

      const resumeToken = adapter.parseResumeToken
        ? adapter.parseResumeToken(tokenRaw)
        : { raw: tokenRaw, providerSessionId: tokenRaw };

      let startupCommitted = false;
      let startupLivePid: number | undefined;
      let terminalProjection: Promise<void> | undefined;
      let terminalDuringManagedStart:
        | { state: "failed"; error: string }
        | { state: "stopped"; exitCode: number | null }
        | undefined;

      const managed = await resumeManagedSession(
        plan,
        resumeToken,
        (ev) => {
          if (ev.type === "session.failed") {
            terminalDuringManagedStart = { state: "failed", error: ev.error };
            terminalProjection = this.trackManagedTerminal(
              req.sessionId,
              "failed",
              ev.error
            );
          } else if (ev.type === "session.exited") {
            terminalDuringManagedStart = {
              state: "stopped",
              exitCode: ev.exitCode,
            };
            terminalProjection = this.trackManagedTerminal(
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
            if (!startupCommitted) {
              startupLivePid = ev.pid;
              return;
            }
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
        await (
          terminalProjection ??
          this.trackManagedTerminal(
            req.sessionId,
            terminal.state,
            terminal.state === "failed" ? terminal.error : undefined,
            terminal.state === "stopped" ? terminal.exitCode : undefined
          )
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
        // Native resume reuses provider context — honest continuity claim.
        contextRestored: true,
        lastError: undefined,
        exitCode: undefined,
        stopReason: undefined,
        runtimeWorkspace: { cwd },
      });
      startupCommitted = true;
      this.emit({
        type: "session.live",
        sessionId: req.sessionId,
        pid: startupLivePid ?? pid,
      });
      return handleFrom(live);
    } catch (err) {
      this.managed.delete(req.sessionId);
      if (resumedManaged) {
        await resumedManaged.stop("interrupt").catch(() => undefined);
        await this.waitForManagedTerminal(req.sessionId, true);
      }
      const rawMessage = err instanceof Error ? err.message : String(err);
      const tokenRedacted = redactRuntimeValue(rawMessage, tokenRaw);
      const message = redactDiagnosticText(tokenRedacted, {
        env: {
          ...(profile.env ?? {}),
          ...(req.env ?? {}),
        },
        secrets: Object.values(resolvedEnv),
      });
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
  }

  /**
   * New rows resume from their immutable launch snapshot. Legacy rows without a
   * snapshot use the current catalog as a bounded read fallback.
   */
  private profileForResume(record: SessionRecord): AgentProfileConfig {
    const snapshot = record.profileSnapshot;
    if (snapshot) {
      if (snapshot.id !== record.profileId) {
        throw new Error(
          `Session profile snapshot id mismatch: row=${record.profileId} snapshot=${snapshot.id}`
        );
      }
      if (snapshot.adapterId !== record.adapterId) {
        throw new Error(
          `Session profile snapshot adapter mismatch: row=${record.adapterId} snapshot=${snapshot.adapterId}`
        );
      }
      return cloneProfileConfig(snapshot);
    }

    const current = this.profiles.get(record.profileId);
    if (!current) throw new Error(`Unknown AgentProfile: ${record.profileId}`);
    if (current.adapterId !== record.adapterId) {
      throw new Error(
        `Legacy session adapter mismatch: row=${record.adapterId} profile=${current.adapterId}`
      );
    }
    return cloneProfileConfig(current);
  }

  /**
   * U2A follow-up on a live managed session: send a fixed-format user answer
   * as the next session/prompt. Not multi-turn chat. Throws when the session
   * is not live with a structured prompt transport.
   */
  async sendFollowUpPrompt(sessionId: string, prompt: string): Promise<void> {
    this.assertOpen();
    const text = prompt.trim();
    if (!text) throw new Error("sendFollowUpPrompt requires non-empty prompt");
    // Record before liveness checks so tests can prove retired sessions get zero inject attempts.
    this.followUpAttemptsForTests.push({ sessionId });
    const managed = this.managed.get(sessionId);
    if (!managed || !managed.isAlive()) {
      throw new Error(`Session not alive for follow-up: ${sessionId}`);
    }
    if (typeof managed.sendFollowUpPrompt !== "function") {
      throw new Error(
        `Session ${sessionId} adapter does not support live follow-up prompts`
      );
    }
    await this.registry.update(sessionId, { state: "live" });
    await managed.sendFollowUpPrompt(text);
  }

  /** Test helper: follow-up inject attempts (sessionId only; no prompt body). */
  getFollowUpAttemptsForTests(): ReadonlyArray<{ sessionId: string }> {
    return this.followUpAttemptsForTests.slice();
  }

  /** Test helper: clear follow-up attempt log. */
  clearFollowUpAttemptsForTests(): void {
    this.followUpAttemptsForTests.length = 0;
  }

  async stopSession(sessionId: string, reason: StopReason): Promise<void> {
    this.assertOpen();
    await this.stopSessionInternal(sessionId, reason);
  }

  private async stopSessionInternal(sessionId: string, reason: StopReason): Promise<void> {
    const record = await this.registry.read(sessionId);
    if (!record) throw new Error(`Session not found: ${sessionId}`);

    // External / pull-host: no process to kill — only end the registry binding.
    if (record.state === "external") {
      await this.registry.update(sessionId, {
        state: "stopped",
        stopReason: reason,
        pid: undefined,
      });
      this.emit({
        type: "session.exited",
        sessionId,
        exitCode: 0,
      });
      return;
    }

    // Record intentional stop *before* killing so a racing session.exited
    // projection (seal-before-deliver) does not task.fail a still-running task.
    if (SessionRegistry.isNonTerminal(record.state) || record.state === "starting") {
      await this.registry.update(sessionId, { stopReason: reason });
    }

    const managed = this.managed.get(sessionId);
    if (managed) {
      try {
        await managed.stop(reason);
      } finally {
        this.managed.delete(sessionId);
      }
      await this.waitForManagedTerminal(sessionId);
    } else if (this.supervisor.isAlive(sessionId)) {
      await this.supervisor.stop(sessionId, { signal: "SIGTERM" });
    }
    await this.waitForChildExit(sessionId);

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
        // A provider may report "failed/interrupted" while honoring Tent's
        // explicit stop. The provider message remains diagnostic in lastError,
        // but the lifecycle outcome is an intentional stop.
        state: "stopped",
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

    // Pull-host external: no PID; open while state remains external.
    if (record.state === "external") {
      return {
        sessionId,
        state: "external",
        alive: true,
        resumeCapable: false,
        lastError: record.lastError,
        exitCode: record.exitCode,
      };
    }

    const managed = this.managed.get(sessionId);
    const alive = managed ? managed.isAlive() : this.supervisor.isAlive(sessionId);
    const turnBusy =
      typeof managed?.isTurnBusy === "function" ? managed.isTurnBusy() : false;
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
        turnBusy: false,
        lastError: updated.lastError,
        exitCode: updated.exitCode,
      };
    }

    return {
      sessionId,
      state: record.state,
      alive,
      resumeCapable,
      turnBusy,
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
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.closed) return;
    this.closing = true;
    this.shutdownPromise = this.shutdownInternal();
    return this.shutdownPromise;
  }

  private async shutdownInternal(): Promise<void> {
    try {
      await Promise.allSettled([
        ...this.startInFlight.values(),
        ...this.resumeInFlight.values(),
      ]);
      const managedIds = [...this.managed.keys()];
      const live = new Set([...this.supervisor.listLive(), ...managedIds]);
      for (const id of live) {
        try {
          await this.stopSessionInternal(id, "shutdown");
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
    } finally {
      this.closed = true;
    }
  }

  /**
   * Managed ACP terminal path (no ProcessSupervisor exit). Idempotent:
   * second failure/exit does not illegal-transition the session row.
   */
  private trackManagedTerminal(
    sessionId: string,
    terminalState: "failed" | "stopped",
    lastError?: string,
    exitCode?: number | null
  ): Promise<void> {
    // A transient machine-state write must not become an unhandled rejection or
    // leave a managed provider terminal while its registry row remains live.
    const projection = this.onManagedTerminal(
      sessionId,
      terminalState,
      lastError,
      exitCode
    ).catch(() =>
      this.onManagedTerminal(sessionId, terminalState, lastError, exitCode)
    );
    let pending = this.managedTerminalInFlight.get(sessionId);
    if (!pending) {
      pending = new Set();
      this.managedTerminalInFlight.set(sessionId, pending);
    }
    pending.add(projection);
    void projection
      .finally(() => {
        pending!.delete(projection);
        if (pending!.size === 0 && this.managedTerminalInFlight.get(sessionId) === pending) {
          this.managedTerminalInFlight.delete(sessionId);
        }
      })
      .catch(() => undefined);
    return projection;
  }

  private async waitForManagedTerminal(
    sessionId: string,
    suppressError = false
  ): Promise<void> {
    let firstError: unknown;
    while (true) {
      const pending = this.managedTerminalInFlight.get(sessionId);
      if (!pending?.size) {
        if (!suppressError && firstError !== undefined) throw firstError;
        return;
      }
      const snapshot = [...pending];
      const results = await Promise.allSettled(snapshot);
      if (!suppressError && firstError === undefined) {
        const rejected = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected"
        );
        if (rejected) firstError = rejected.reason;
      }
    }
  }

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

    // ProcessSupervisor ring is already redacted; attach a short tail so failures
    // stay useful without reintroducing secrets into SessionRegistry / events.
    if (event.type === "session.failed") {
      const tail = this.supervisor.getStdoutTail(sessionId).trim();
      if (tail) {
        const snippet = tail.slice(-500);
        event = {
          ...event,
          error: `${event.error} (stderr: ${snippet})`,
        };
      }
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

  private async waitForChildExit(sessionId: string, suppressError = false): Promise<void> {
    const projection = this.childExitInFlight.get(sessionId);
    if (!projection) return;
    if (suppressError) {
      await projection.catch(() => undefined);
      return;
    }
    await projection;
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
   * Resolve skill meta + MCP wire from profile snapshot for LaunchPlan.extras.
   * Secret values only live on the plan (in-process) for session/new|load — never SessionRecord.
   * Enabled skill path refs fail loud when missing; credential resolver errors are not swallowed.
   *
   * Built-in tent-role / tent-task contracts are injected only into the managed bootstrap
   * prompt prefix (cross-provider). ACP `_meta.tent.skills` carries optional profile.skills
   * extras only — never re-advertise built-ins as activatable skill refs.
   */
  private async buildAcpLaunchExtras(
    profile: AgentProfileConfig,
    planEnv: Record<string, string>,
    assigneeKind?: "role" | "agentProfile"
  ): Promise<{
    acpSkills?: ReturnType<typeof resolveAcpSkillMeta>;
    acpMcpServers?: ReturnType<typeof resolveAcpMcpServersWire>;
  }> {
    // Strip built-in names even without packageRoot so profile cannot double-load contracts.
    const composedSkills = composeManagedSkillRefs({
      packageRoot: this.packageRoot ?? "",
      assigneeKind: assigneeKind ?? "role",
      profileSkills: profile.skills,
    });
    const hasSkills = Array.isArray(composedSkills) && composedSkills.length > 0;
    const hasMcp = Array.isArray(profile.mcpServers) && profile.mcpServers.length > 0;
    if (!hasSkills && !hasMcp) return {};

    // Pre-resolve credential refs per server so failures name profile/server/ref only (never secrets).
    const credCache = new Map<string, string>();
    if (hasMcp && this.resolveCredentialRef) {
      for (const s of profile.mcpServers ?? []) {
        if (s.enabled === false) continue;
        const refs = new Set<string>();
        if (s.envCredentialRefs) {
          for (const id of Object.values(s.envCredentialRefs)) refs.add(id);
        }
        if (s.headerCredentialRefs) {
          for (const id of Object.values(s.headerCredentialRefs)) refs.add(id);
        }
        for (const id of refs) {
          if (credCache.has(id)) continue;
          let value: string | undefined;
          try {
            value = await this.resolveCredentialRef(id);
          } catch {
            // Fail loud; do not convert resolver throws into "not found".
            // Name only profile / server / ref — never secret material.
            throw new Error(
              `MCP server ${s.name}: credential resolve failed for profile ${profile.id} credentialRef=${id}`
            );
          }
          if (typeof value === "string" && value) {
            credCache.set(id, value);
          }
        }
      }
    }

    // Profile extras only: enabled path refs must exist; name-only refs remain allowed.
    const acpSkills = hasSkills
      ? resolveAcpSkillMeta(composedSkills, { requirePathExists: true })
      : undefined;
    const acpMcpServers = hasMcp
      ? resolveAcpMcpServersWire(profile.mcpServers, {
          planEnv,
          resolveCredential: (id) => credCache.get(id),
        })
      : undefined;

    return {
      ...(acpSkills !== undefined ? { acpSkills } : {}),
      ...(acpMcpServers !== undefined ? { acpMcpServers } : {}),
    };
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
    if (this.closed || this.closing) throw new Error("AgentRuntime is shut down");
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

/** Profile / request env may not override Core-owned Tent Service / session keys. */
function stripProfileRequestEnv(
  env: Record<string, string> | undefined
): Record<string, string> {
  return stripReservedTentChildEnv(env);
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  return new AgentRuntime(options);
}
