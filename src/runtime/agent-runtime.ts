// AgentRuntimePort implementation — service-internal only (B0 §4).
// Maps ProcessSupervisor + SessionRegistry + ProviderAdapter; no Task/Node writes.

import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
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
  cloneAgentConnection,
  calculateAgentConnectionLaunchDigest,
  createAgentConnectionSnapshot,
  connectionConfigFromSnapshot,
} from "./agent-connection.js";
import { stripReservedTentChildEnv } from "./child-env.js";
import { ProcessSupervisor } from "./process-supervisor.js";
import { SessionRegistry } from "./session-registry.js";
import { deriveSessionToken } from "./session-token.js";
import { isRoleId } from "../core/id.js";
import { redactDiagnosticText } from "../adapters/acp/redact.js";
import { cloneAcpSessionConfigSnapshot } from "../adapters/acp/types.js";
import {
  ACP_DIAGNOSTIC_EVENT_BYTES,
  truncateUtf8Text,
} from "../adapters/acp/limits.js";
import type {
  AgentConnectionConfig,
  AgentConnectionSnapshot,
  AgentRuntimePort,
  EnterExternalSessionRequest,
  ResolveCredentialRef,
  ResolveConnectionEnv,
  ReserveSessionRequest,
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
  isSessionId,
  makeSessionId,
  recordExternalKey,
} from "./types.js";

export interface AgentRuntimeOptions {
  dataDir: string;
  /** Service-process secret used to derive scoped Session caller capabilities. */
  sessionTokenKey?: string;
  /** Agent Connection catalog (machine-local). */
  connections?: AgentConnectionConfig[];
  /** Adapter registry; defaults include fake-cli and the explicit product ACP adapters. */
  adapters?: ProviderAdapter[];
  /** Graceful stop timeout for supervised children. */
  gracefulMs?: number;
  /** When true (default), capture short stdout tails as diagnostic events. */
  captureStdout?: boolean;
  /**
   * Optional async hook to resolve Connection credentialRef → env values before LaunchPlan.
   * Service wires CredentialStore.resolve here. Secrets never enter SessionRecord.
   */
  resolveConnectionEnv?: ResolveConnectionEnv;
  /**
   * Optional hook to resolve arbitrary credential ids for MCP env/header injection.
   * Process-scoped only; never persisted on SessionRecord.
   */
  resolveCredentialRef?: ResolveCredentialRef;
  /**
   * Package root for bundled tent-role / tent-task skill paths.
   * When set, managed sessions automatically compose built-in skill refs
   * (route.skills remain optional extras).
   */
  packageRoot?: string;
}

function handleFrom(record: SessionRecord): SessionHandle {
  return {
    sessionId: record.id,
    connectionId: record.connectionId,
    adapterId: record.adapterId,
    state: record.state,
    pid: record.pid,
    roleId: record.roleId,
    runtimeWorkspace: record.runtimeWorkspace,
    ...(record.contextRestored !== undefined
      ? { contextRestored: record.contextRestored }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Bound diagnostics before either SessionRegistry persistence or event fan-out. */
function boundRuntimeDiagnosticEvent(ev: RuntimeEvent): RuntimeEvent {
  if (ev.type === "session.stdout_tail") {
    return {
      ...ev,
      text: truncateUtf8Text(ev.text, ACP_DIAGNOSTIC_EVENT_BYTES),
    };
  }
  if (ev.type === "session.failed") {
    return {
      ...ev,
      error: truncateUtf8Text(ev.error, ACP_DIAGNOSTIC_EVENT_BYTES),
    };
  }
  if (ev.type === "session.waiting_user") {
    return {
      ...ev,
      summary: truncateUtf8Text(ev.summary, ACP_DIAGNOSTIC_EVENT_BYTES),
    };
  }
  return ev;
}

function copyRuntimeErrorMetadata(error: unknown): {
  code?: string;
  terminalAlreadyEmitted?: true;
} {
  if (!error || typeof error !== "object") return {};
  const source = error as {
    code?: unknown;
    terminalAlreadyEmitted?: unknown;
  };
  return {
    ...(typeof source.code === "string" ? { code: source.code } : {}),
    ...(source.terminalAlreadyEmitted === true
      ? { terminalAlreadyEmitted: true as const }
      : {}),
  };
}

/** Agent Connection runtime; callers never receive mutable catalog rows. */
export class AgentRuntime implements AgentRuntimePort {
  readonly registry: SessionRegistry;
  readonly supervisor: ProcessSupervisor;
  /** Owning Service data directory; inherited by managed children for native Tent hooks. */
  private readonly dataDir: string;
  private readonly sessionTokenKey: string;
  private readonly connections = new Map<string, AgentConnectionConfig>();
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly managed = new Map<string, ManagedSession>();
  private readonly startInFlight = new Map<string, Promise<SessionHandle>>();
  private readonly resumeInFlight = new Map<string, Promise<SessionHandle>>();
  private readonly childExitInFlight = new Map<string, Promise<void>>();
  private readonly managedTerminalInFlight = new Map<string, Set<Promise<void>>>();
  private readonly sinks = new Map<string, Set<(ev: RuntimeEvent) => void>>();
  private readonly globalSinks = new Set<(ev: RuntimeEvent) => void>();
  private readonly resolveConnectionEnv?: ResolveConnectionEnv;
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
    this.sessionTokenKey = options.sessionTokenKey ?? randomBytes(32).toString("base64url");
    this.registry = new SessionRegistry(this.dataDir);
    this.resolveConnectionEnv = options.resolveConnectionEnv;
    this.resolveCredentialRef = options.resolveCredentialRef;
    this.packageRoot = options.packageRoot;

    for (const connection of options.connections ?? []) {
      this.connections.set(connection.connectionId, cloneAgentConnection(connection));
    }
    const adapterList = options.adapters ?? [
      createFakeAdapter(),
      createGrokAcpAdapter(),
      createCodexAcpAdapter(),
      createClaudeAcpAdapter(),
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

  registerConnection(connection: AgentConnectionConfig): void {
    this.connections.set(connection.connectionId, cloneAgentConnection(connection));
  }

  /**
   * Full replace of the in-memory Agent Connection catalog.
   * Does not touch live sessions — only new startSession sees the new map.
   * Stores clones so callers cannot mutate the map.
   */
  replaceConnectionCatalog(connections: AgentConnectionConfig[]): void {
    this.connections.clear();
    for (const connection of connections) {
      if (connection && typeof connection.connectionId === "string") {
        this.connections.set(connection.connectionId, cloneAgentConnection(connection));
      }
    }
  }

  /** Lookup a single machine-local Agent Connection clone. */
  getConnection(connectionId: string): AgentConnectionConfig | undefined {
    const connection = this.connections.get(connectionId);
    return connection ? cloneAgentConnection(connection) : undefined;
  }

  /** Immutable non-secret launch facts for a fresh Session. */
  snapshotConnectionForStart(connectionId: string): AgentConnectionSnapshot {
    const connection = this.connections.get(connectionId);
    if (!connection) throw new Error(`Unknown Agent Connection: ${connectionId}`);
    return createAgentConnectionSnapshot(connection, {
      effectiveEndpointDigest: this.effectiveEndpointDigest(connection),
    });
  }

  /** Machine-local catalog snapshot (cloned entries). */
  listConnections(): AgentConnectionConfig[] {
    return [...this.connections.values()].map(cloneAgentConnection);
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
   * Create the exact durable Session identity before its Task is written.
   * Connection selection happens once here; later start/resume consume only the
   * immutable snapshot on this record.
   */
  async reserveSession(req: ReserveSessionRequest): Promise<SessionHandle> {
    this.assertOpen();
    if (!isSessionId(req.sessionId)) {
      throw new Error(`Invalid session id: ${req.sessionId}`);
    }
    const taskId = req.lastTaskId.trim();
    const workspace = req.workspace.trim();
    if (!taskId) throw new Error("reserveSession requires lastTaskId");
    if (!workspace) throw new Error("reserveSession requires workspace");
    const connection = this.connections.get(req.connectionId);
    if (!connection) {
      throw new Error(`Unknown Agent Connection: ${req.connectionId}`);
    }
    const adapter = this.adapters.get(connection.adapterId);
    if (!adapter) throw new Error(`Unknown adapter: ${connection.adapterId}`);
    if (!adapter.capabilities().canSpawn) {
      throw new Error(`Adapter ${adapter.id} cannot spawn (pull-host only)`);
    }
    const cwd = req.runtimeWorkspace?.cwd ?? req.cwd ?? req.workspaceLane?.worktree;
    if (!cwd) {
      throw new Error(
        "reserveSession requires runtimeWorkspace.cwd, cwd, or workspaceLane.worktree"
      );
    }
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: req.sessionId,
      connectionId: connection.connectionId,
      adapterId: adapter.id,
      connectionSnapshot: createAgentConnectionSnapshot(connection, {
        effectiveEndpointDigest: this.effectiveEndpointDigest(connection),
      }),
      state: "reserved",
      runtimeWorkspace: { cwd },
      workspace,
      workspaceLane: req.workspaceLane,
      createdAt: now,
      updatedAt: now,
      lastTaskId: taskId,
    };
    await this.registry.create(record);
    return handleFrom(record);
  }

  /**
   * Register a pull-host / external GUI session without spawning ACP.
   * Idempotent: same sessionId or externalKey while state remains external reuses the row.
   */
  async enterExternalSession(req: EnterExternalSessionRequest): Promise<SessionHandle> {
    this.assertOpen();

    const externalKey = req.externalKey?.trim() || undefined;
    const roleId = req.roleId?.trim() || undefined;
    if (roleId && !isRoleId(roleId)) {
      throw new Error(`Invalid Role id: ${roleId}`);
    }
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
          if (roleId && existing.roleId !== roleId) {
            throw new Error(
              `External Session Role binding mismatch: existing=${existing.roleId ?? "(none)"} requested=${roleId}`
            );
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
            return this.externalHandle(updated);
          }
          return this.externalHandle(existing);
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
    if (externalKey || (workspace && roleId)) {
      const all = await this.registry.list();
      const match = all.find((rec) => {
        if (rec.state !== "external") return false;
        if (workspace && rec.workspace && rec.workspace !== workspace) return false;
        if (externalKey) {
          return recordExternalKey(rec) === externalKey;
        }
        // Soft match: same workspace + role label for hook re-enter without key.
        return Boolean(roleId && rec.roleId === roleId);
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
          return this.externalHandle(updated);
        }
        return this.externalHandle(match);
      }
    }

    const sessionId = req.sessionId && isSessionId(req.sessionId) ? req.sessionId : makeSessionId();
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: sessionId,
      adapterId: EXTERNAL_ADAPTER_ID,
      roleId,
      state: "external",
      runtimeWorkspace: cwd ? { cwd } : undefined,
      workspace,
      workspaceLane: req.workspaceLane,
      createdAt: now,
      updatedAt: now,
      lastTaskId: req.lastTaskId,
      ...(externalKey ? { externalKey } : {}),
    };
    await this.registry.create(record);
    // No session.starting / session.live process events — external has no child.
    return this.externalHandle(record);
  }

  private externalHandle(record: SessionRecord): SessionHandle {
    return {
      ...handleFrom(record),
      sessionToken: deriveSessionToken(this.sessionTokenKey, record.id),
    };
  }

  private async startSessionExclusive(req: StartSessionRequest): Promise<SessionHandle> {
    const record = await this.registry.read(req.sessionId);
    if (!record) throw new Error(`Reserved Session not found: ${req.sessionId}`);
    if (record.state !== "reserved") {
      throw new Error(`Session is not reserved for first start: ${req.sessionId} (${record.state})`);
    }
    const connection = this.connectionForResume(record);
    return this.startSessionWithConnection(req, record, connection);
  }

  private async startSessionWithConnection(
    req: StartSessionRequest,
    record: SessionRecord,
    route: AgentConnectionConfig
  ): Promise<SessionHandle> {
    const adapter = this.adapters.get(route.adapterId);
    if (!adapter) {
      throw new Error(`Unknown adapter: ${route.adapterId}`);
    }

    const caps = adapter.capabilities();
    if (!caps.canSpawn) {
      throw new Error(`Adapter ${adapter.id} cannot spawn (pull-host only)`);
    }

    const recordedCwd = record.runtimeWorkspace?.cwd ?? record.workspaceLane?.worktree;
    const requestedCwd = req.runtimeWorkspace?.cwd ?? req.cwd ?? req.workspaceLane?.worktree;
    if (recordedCwd && requestedCwd && !sameRuntimeCwd(recordedCwd, requestedCwd)) {
      throw new Error(
        `startSession cwd mismatch: recorded=${recordedCwd} requested=${requestedCwd}`
      );
    }
    const cwd = recordedCwd ?? requestedCwd;
    if (!cwd) {
      throw new Error("startSession requires runtimeWorkspace.cwd, cwd, or workspaceLane.worktree");
    }

    const starting = await this.registry.update(req.sessionId, {
      state: "starting",
      runtimeWorkspace: { cwd },
    });
    this.emit({ type: "session.starting", sessionId: req.sessionId });

    let startedManaged: ManagedSession | undefined;
    let resolvedEnv: Record<string, string> = {};
    let diagnosticSecrets: string[] = [];
    try {
      // Resolve after the diagnostic row exists, so a missing/stale vault reference
      // becomes an ordinary failed session without ever persisting the plaintext.
      resolvedEnv = await this.resolveCredentialEnv(route);
      // Vault injection wins for envKey; request env supplies non-secret knobs.
      // Reserved Tent Service/data-dir/session keys are Core-owned and cannot be
      // overridden by arbitrary Connection or request env.
      // Route/request cannot set reserved keys (stripped). Core mirrors reserved
      // into plan.env for adapter/hook visibility; spawn authority is coreEnv only.
      const coreEnv = {
        // Reserved routing authority: installed native Tent hooks spawned by an
        // isolated Service must attach back to that Service, never %APPDATA%\Tent.
        TENT_SERVICE_DATA_DIR: this.dataDir,
        TENT_SESSION_ID: req.sessionId,
        TENT_SESSION_TOKEN: deriveSessionToken(this.sessionTokenKey, req.sessionId),
      };
      const planEnv = {
        ...stripRouteRequestEnv(req.env),
        ...resolvedEnv,
        ...coreEnv,
      };
      const acpLaunch = await this.buildAcpLaunchExtras(route, planEnv);
      diagnosticSecrets = Array.from(
        new Set([
          ...Object.values(resolvedEnv).filter(
            (v): v is string => typeof v === "string" && v.length > 0
          ),
          ...acpLaunch.diagnosticSecrets,
        ])
      );
      const plan = {
        sessionId: req.sessionId,
        connectionId: starting.connectionId!,
        cwd,
        env: planEnv,
        coreEnv,
        diagnosticSecrets,
        bootstrapPrompt: req.bootstrapPrompt,
        // Ephemeral path refs only — never base64; not written to SessionRecord.
        bootstrapImageRefs: req.bootstrapImageRefs,
        command: route.command,
        args: route.args,
        extras: {
          fake: route.fake,
          acp: this.acpOptionsForRoute(route),
          // Snapshot-time ACP projection (skills + mcp). Running sessions do not hot-reload.
          ...acpLaunch.extras,
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
        const managed = await adapter.startManagedSession(plan, (rawEvent) => {
          const ev = boundRuntimeDiagnosticEvent(rawEvent);
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
          } else if (ev.type === "session.config_options") {
            void this.registry
              .update(req.sessionId, {
                acpSession: cloneAcpSessionConfigSnapshot(ev.sessionConfig),
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
        resumeToken = adapter.capabilities().canResume
          ? `resume:${req.sessionId}`
          : undefined;
      }

      const live = await this.registry.update(req.sessionId, {
        state: "live",
        pid,
        resumeToken,
        ...(startedManaged?.acpSession
          ? {
              acpSession: cloneAcpSessionConfigSnapshot(
                startedManaged.acpSession
              ),
            }
          : {}),
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
          ...(req.env ?? {}),
        },
        secrets: diagnosticSecrets,
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
      throw Object.assign(new Error(message), {
        session: handleFrom(failed),
        ...copyRuntimeErrorMetadata(err),
      });
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

    const route = this.connectionForResume(record);
    if (!record.adapterId) throw new Error(`Session ${req.sessionId} has no adapter binding`);
    const adapter = record.adapterId ? this.adapters.get(record.adapterId) : undefined;
    if (!adapter) throw new Error(`Unknown adapter: ${record.adapterId}`);

    const tokenRaw = record.resumeToken;
    if (!tokenRaw) {
      throw new Error(`Session ${req.sessionId} has no resume token`);
    }
    if (!adapter.capabilities().canResume) {
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
    let diagnosticSecrets: string[] = [];
    try {
      resolvedEnv = await this.resolveCredentialEnv(route);
      // Preserve the owning Service boundary across provider-native resume.
      // Reserved keys remain Core-owned (Connection/request cannot override).
      const coreEnv = {
        TENT_SERVICE_DATA_DIR: this.dataDir,
        TENT_SESSION_ID: req.sessionId,
        TENT_SESSION_TOKEN: deriveSessionToken(this.sessionTokenKey, req.sessionId),
      };
      const planEnv = {
        ...stripRouteRequestEnv(req.env),
        ...resolvedEnv,
        ...coreEnv,
      };
      const acpLaunch = await this.buildAcpLaunchExtras(route, planEnv);
      diagnosticSecrets = Array.from(
        new Set([
          ...Object.values(resolvedEnv).filter(
            (v): v is string => typeof v === "string" && v.length > 0
          ),
          ...acpLaunch.diagnosticSecrets,
        ])
      );
      const plan = {
        sessionId: req.sessionId,
        connectionId: route.connectionId,
        cwd,
        env: planEnv,
        coreEnv,
        diagnosticSecrets,
        bootstrapPrompt: req.bootstrapPrompt,
        bootstrapImageRefs: req.bootstrapImageRefs,
        command: route.command,
        args: route.args,
        extras: {
          fake: route.fake,
          acp: this.acpOptionsForRoute(route),
          // Resume uses connectionSnapshot (not live catalog edits).
          ...acpLaunch.extras,
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
        (rawEvent) => {
          const ev = boundRuntimeDiagnosticEvent(rawEvent);
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
          } else if (ev.type === "session.config_options") {
            void this.registry
              .update(req.sessionId, {
                acpSession: cloneAcpSessionConfigSnapshot(ev.sessionConfig),
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

      const pid = managed.pid;
      // Keep original provider token; load reuses the same provider session id.
      const expectedProviderSessionId = resumeToken.providerSessionId?.trim();
      const actualProviderSessionId = managed.providerSessionId?.trim();
      if (!expectedProviderSessionId || !actualProviderSessionId) {
        throw new Error(
          `Provider resume did not prove the original conversation identity for Session ${req.sessionId}`
        );
      }
      if (actualProviderSessionId !== expectedProviderSessionId) {
        throw new Error(
          `Provider resumed a different conversation for Session ${req.sessionId}`
        );
      }
      this.managed.set(req.sessionId, managed);

      const live = await this.registry.update(req.sessionId, {
        state: "live",
        pid,
        resumeToken: tokenRaw,
        ...(managed.acpSession
          ? {
              acpSession: cloneAcpSessionConfigSnapshot(managed.acpSession),
            }
          : {}),
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
          ...(req.env ?? {}),
        },
        secrets: diagnosticSecrets,
      });
      const failed = await this.registry.update(req.sessionId, {
        state: "failed",
        lastError: message,
        pid: undefined,
      });
      if (!(err as { terminalAlreadyEmitted?: boolean })?.terminalAlreadyEmitted) {
        this.emit({ type: "session.failed", sessionId: req.sessionId, error: message });
      }
      throw Object.assign(new Error(message), {
        session: handleFrom(failed),
        ...copyRuntimeErrorMetadata(err),
      });
    }
  }

  /** Resume only from the immutable non-secret Agent Connection snapshot. */
  private connectionForResume(record: SessionRecord): AgentConnectionConfig {
    const snapshot = record.connectionSnapshot;
    if (!record.connectionId || !record.adapterId || !snapshot) {
      throw new Error(`Session ${record.id} has no Agent Connection snapshot`);
    }
    if (snapshot.connectionId !== record.connectionId) {
      throw new Error(
        `Session Connection snapshot id mismatch: row=${record.connectionId} snapshot=${snapshot.connectionId}`
      );
    }
    if (snapshot.adapterId !== record.adapterId) {
      throw new Error(
        `Session Connection snapshot adapter mismatch: row=${record.adapterId} snapshot=${snapshot.adapterId}`
      );
    }
    const route = connectionConfigFromSnapshot(snapshot);
    const currentEndpointDigest = this.effectiveEndpointDigest(route);
    if ((snapshot.effectiveEndpointDigest || "") !== (currentEndpointDigest || "")) {
      throw new Error(`Session Connection endpoint changed; provider continuity is no longer valid`);
    }
    const launchDigest = calculateAgentConnectionLaunchDigest(route, currentEndpointDigest);
    if (launchDigest !== snapshot.launchDigest) {
      throw new Error(`Session Connection snapshot launch digest mismatch`);
    }
    return route;
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
    const adapter = record.adapterId ? this.adapters.get(record.adapterId) : undefined;
    const resumeCapable = Boolean(
      record.connectionSnapshot && record.resumeToken && adapter?.capabilities().canResume
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
      if (rec.state === "reserved") {
        // A reservation has no provider process to recover. Surviving a Service
        // restart means the reserve→Task bind/start sequence was interrupted;
        // settle it fail-loud instead of leaving a permanent second lifecycle.
        await this.registry.update(rec.id, {
          state: "failed",
          pid: undefined,
          lastError:
            rec.lastError ??
            "reserved Session did not reach provider start before Service restart",
        });
        results.push(await this.probe(rec.id));
        continue;
      }
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
    const adapter = record.adapterId ? this.adapters.get(record.adapterId) : undefined;
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
    ev = boundRuntimeDiagnosticEvent(ev);
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
   * Resolve skill metadata + MCP wire from the Connection snapshot.
   * Secret values only live on the plan (in-process) for session/new|load — never SessionRecord.
   * Enabled skill path refs fail loud when missing; credential resolver errors are not swallowed.
   *
   * Built-in tent-role / tent-task contracts are injected only into the managed bootstrap
   * prompt prefix (cross-provider). ACP `_meta.tent.skills` carries optional Connection skills
   * extras only — never re-advertise built-ins as activatable skill refs.
   */
  private async buildAcpLaunchExtras(
    route: AgentConnectionConfig,
    planEnv: Record<string, string>
  ): Promise<{
    extras: {
      acpSkills?: ReturnType<typeof resolveAcpSkillMeta>;
      acpMcpServers?: ReturnType<typeof resolveAcpMcpServersWire>;
    };
    diagnosticSecrets: string[];
  }> {
    // Strip built-in names even without packageRoot so a Connection cannot double-load contracts.
    const composedSkills = composeManagedSkillRefs({
      packageRoot: this.packageRoot ?? "",
      connectionSkills: route.skills,
    });
    const hasSkills = Array.isArray(composedSkills) && composedSkills.length > 0;
    const hasMcp = Array.isArray(route.mcpServers) && route.mcpServers.length > 0;
    if (!hasSkills && !hasMcp) return { extras: {}, diagnosticSecrets: [] };

    // Pre-resolve credential refs per server so failures name Connection/server/ref only.
    const credCache = new Map<string, string>();
    if (hasMcp && this.resolveCredentialRef) {
      for (const s of route.mcpServers ?? []) {
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
            // Name only Connection / server / ref — never secret material.
            throw new Error(
              `MCP server ${s.name}: credential resolve failed for Agent Connection ${route.connectionId} credentialRef=${id}`
            );
          }
          if (typeof value === "string" && value) {
            credCache.set(id, value);
          }
        }
      }
    }

    // Route extras only: enabled path refs must exist; name-only refs remain allowed.
    const acpSkills = hasSkills
      ? resolveAcpSkillMeta(composedSkills, { requirePathExists: true })
      : undefined;
    const acpMcpServers = hasMcp
      ? resolveAcpMcpServersWire(route.mcpServers, {
          planEnv,
          resolveCredential: (id) => credCache.get(id),
        })
      : undefined;

    return {
      extras: {
        ...(acpSkills !== undefined ? { acpSkills } : {}),
        ...(acpMcpServers !== undefined ? { acpMcpServers } : {}),
      },
      // Ephemeral redaction inputs only. These values are already present in the
      // ACP MCP launch wire and must never reach SessionRegistry or diagnostics.
      diagnosticSecrets: Array.from(new Set(credCache.values())),
    };
  }

  /**
   * Resolve credential and endpoint env values for one launch only.
   * Never persists secrets onto SessionRecord.
   */
  private async resolveCredentialEnv(
    route: AgentConnectionConfig
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const ref = route.credentialRef?.trim() || "";
    const envKey = route.envKey?.trim() || "";
    if (ref && !envKey) {
      throw new Error(
        `Agent Connection ${route.connectionId} has credentialRef but no envKey`
      );
    }
    if (ref && !this.resolveConnectionEnv) {
      throw new Error(
        `Agent Connection ${route.connectionId} references credential ${ref} but AgentRuntime has no resolveConnectionEnv hook`
      );
    }
    if (ref) {
      const resolved = { ...(await this.resolveConnectionEnv!(route)) };
      const secret = resolved[envKey];
      if (typeof secret !== "string" || !secret) {
        throw new Error(
          `Credential not found or empty for Agent Connection ${route.connectionId} (credentialRef=${ref})`
        );
      }
      out[envKey] = secret;
    }
    const endpointEnvKey = route.baseUrlEnvKey?.trim() || "";
    if (endpointEnvKey) {
      const endpoint = process.env[endpointEnvKey];
      if (typeof endpoint !== "string" || !endpoint.trim()) {
        throw new Error(`Agent Connection ${route.connectionId} endpoint env is missing: ${endpointEnvKey}`);
      }
      out[endpointEnvKey] = endpoint;
    }
    return out;
  }

  private effectiveEndpointDigest(route: AgentConnectionConfig): string | undefined {
    const raw = route.baseUrlEnvKey
      ? process.env[route.baseUrlEnvKey]
      : route.baseUrl;
    const normalized = raw?.trim();
    if (!normalized) return undefined;
    return `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
  }

  private acpOptionsForRoute(route: AgentConnectionConfig) {
    return {
      executable: route.executable,
      model: route.model,
      envKey: route.envKey,
      credentialRef: route.credentialRef,
      baseUrlEnvKey: route.baseUrlEnvKey,
      baseUrl: route.baseUrl,
      permissionPolicy: route.permissionPolicy,
      promptTimeoutMs: route.promptTimeoutMs,
      permissionTimeoutMs: route.permissionTimeoutMs,
    };
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

/** Route / request env may not override Core-owned Tent Service / session keys. */
function stripRouteRequestEnv(
  env: Record<string, string> | undefined
): Record<string, string> {
  return stripReservedTentChildEnv(env);
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  return new AgentRuntime(options);
}
