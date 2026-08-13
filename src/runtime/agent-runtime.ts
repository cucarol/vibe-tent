// AgentRuntimePort implementation — service-internal only.
// Maps ProcessSupervisor + SessionRegistry + ProviderAdapter; no Task/Node writes.

import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  ManagedSessionStartupError,
  type ManagedSession,
  type ProviderAdapter,
} from "../adapters/types.js";
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
  AcpRuntimeObservation,
  AgentConnectionConfig,
  AgentConnectionSnapshot,
  AgentRuntimePort,
  EnterExternalSessionRequest,
  ResolveLaunchSecretRef,
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
  ACP_OBSERVATION_SIGNAL_BYTES,
  ACP_OBSERVATION_TEXT_BYTES,
  ACP_PERMISSION_REQUEST_COUNT_MAX,
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
   * Optional async hook to resolve Connection launchSecretRef → env values before LaunchPlan.
   * Service wires LaunchSecretStore.resolve here. Secrets never enter SessionRecord.
   */
  resolveConnectionEnv?: ResolveConnectionEnv;
  /**
   * Optional hook to resolve launch-secret ids for MCP env/header injection.
   * Process-scoped only; never persisted on SessionRecord.
   */
  resolveLaunchSecretRef?: ResolveLaunchSecretRef;
  /**
   * Package root for bundled tent-role / tent-task skill paths.
   * When set, managed sessions automatically compose built-in skill refs
   * (Connection skills remain optional extras).
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
    ...(record.providerContextRestored !== undefined
      ? { providerContextRestored: record.providerContextRestored }
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
  if (ev.type === "session.acp_observation") {
    return {
      ...ev,
      observation: boundAcpRuntimeObservation(ev.observation),
    };
  }
  return ev;
}

function boundAcpRuntimeObservation(
  observation: AcpRuntimeObservation
): AcpRuntimeObservation {
  const count = Number.isInteger(observation.permissionRequestCount)
    ? Math.max(
        0,
        Math.min(
          ACP_PERMISSION_REQUEST_COUNT_MAX,
          observation.permissionRequestCount
        )
      )
    : 0;
  const policy = ["allow", "ask", "deny"].includes(
    observation.permissionPolicy
  )
    ? observation.permissionPolicy
    : "deny";
  const exitCode =
    observation.exitCode === null
      ? null
      : Number.isInteger(observation.exitCode)
        ? Math.max(
            -2_147_483_648,
            Math.min(2_147_483_647, observation.exitCode as number)
          )
        : undefined;
  return {
    permissionRequestCount: count,
    permissionPolicy: policy,
    ...(observation.permissionDecision === "allow" ||
    observation.permissionDecision === "deny"
      ? { permissionDecision: observation.permissionDecision }
      : {}),
    ...(observation.permissionOutcome === "allow_once" ||
    observation.permissionOutcome === "cancelled"
      ? { permissionOutcome: observation.permissionOutcome }
      : {}),
    ...(observation.promptStopReason !== undefined
      ? {
          promptStopReason: truncateUtf8Text(
            observation.promptStopReason,
            ACP_OBSERVATION_TEXT_BYTES
          ),
        }
      : {}),
    spontaneousChildExit: observation.spontaneousChildExit === true,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(observation.signal !== undefined
      ? {
          signal: truncateUtf8Text(
            observation.signal,
            ACP_OBSERVATION_SIGNAL_BYTES
          ),
        }
      : {}),
  };
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
  private readonly resolveLaunchSecretRef?: ResolveLaunchSecretRef;
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
    this.resolveLaunchSecretRef = options.resolveLaunchSecretRef;
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
    const taskId = req.currentTaskId.trim();
    const workspace = req.workspace.trim();
    if (!taskId) throw new Error("reserveSession requires currentTaskId");
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
      currentTaskId: taskId,
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
          if (req.currentTaskId && existing.currentTaskId !== req.currentTaskId) {
            patch.currentTaskId = req.currentTaskId;
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
        if (existing.adapterId !== EXTERNAL_ADAPTER_ID) {
          throw new Error(
            `Terminal managed Session cannot be reopened as external: ${req.sessionId}`
          );
        }
        if (roleId && existing.roleId !== roleId) {
          throw new Error(
            `External Session Role binding mismatch: existing=${existing.roleId ?? "(none)"} requested=${roleId}`
          );
        }
        const reopened = await this.registry.update(req.sessionId, {
          state: "external",
          ...(workspace ? { workspace } : {}),
          ...(cwd ? { runtimeWorkspace: { cwd } } : {}),
          ...(req.currentTaskId ? { currentTaskId: req.currentTaskId } : {}),
          ...(externalKey ? { externalKey } : {}),
          pid: undefined,
          exitCode: undefined,
          lastError: undefined,
          stopReason: undefined,
        });
        return this.externalHandle(reopened);
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
        if (req.currentTaskId && match.currentTaskId !== req.currentTaskId) {
          patch.currentTaskId = req.currentTaskId;
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
      currentTaskId: req.currentTaskId,
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
      // Resolve after the diagnostic row exists, so a missing/stale launch-secret reference
      // becomes an ordinary failed session without ever persisting the plaintext.
      resolvedEnv = await this.resolveLaunchSecretEnv(route);
      // Launch-secret injection wins for envKey; request env supplies non-secret knobs.
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
        let managed: ManagedSession;
        try {
          managed = await adapter.startManagedSession(plan, (rawEvent) => {
            const ev = boundRuntimeDiagnosticEvent(rawEvent);
            const managedAtEvent =
              this.managed.get(req.sessionId) ?? startedManaged;
            const terminalWhileAlive =
              (ev.type === "session.failed" || ev.type === "session.exited") &&
              managedAtEvent?.isAlive() === true;
            // Managed terminal projection retires only a confirmed-dead handle.
            // A premature adapter terminal stays diagnostic-only and must not reach
            // Service Task projection while the owned child remains alive.
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
            } else if (ev.type === "session.acp_observation") {
              void this.registry
                .update(req.sessionId, {
                  acpObservation: { ...ev.observation },
                })
                .catch(() => undefined);
            }
            if (!terminalWhileAlive) this.emit(ev);
          });
        } catch (error) {
          if (error instanceof ManagedSessionStartupError) {
            startedManaged = error.managedSession;
            this.managed.set(req.sessionId, startedManaged);
          }
          throw error;
        }
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
      // Core reserved overlay + launch secrets for redaction — not adapter authority.
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
      let retainedManaged = false;
      let stopError: unknown;
      if (startedManaged) {
        try {
          await startedManaged.stop("interrupt");
        } catch (error) {
          stopError = error;
        }
        retainedManaged = startedManaged.isAlive();
        if (retainedManaged) {
          this.managed.set(req.sessionId, startedManaged);
        } else {
          this.managed.delete(req.sessionId);
          await this.waitForManagedTerminal(req.sessionId, true);
        }
      } else if (this.supervisor.isAlive(req.sessionId)) {
        await this.supervisor.stop(req.sessionId).catch(() => undefined);
        await this.waitForChildExit(req.sessionId, true);
      }
      const rawMessage = retainedManaged
        ? `${err instanceof Error ? err.message : String(err)}; ${
            stopError instanceof Error
              ? stopError.message
              : "managed child exit was not confirmed"
          }`
        : err instanceof Error
          ? err.message
          : String(err);
      // Never persist raw launch-secret values into SessionRegistry / Service errors.
      const message = redactDiagnosticText(rawMessage, {
        env: {
          ...(req.env ?? {}),
        },
        secrets: diagnosticSecrets,
      });
      if (retainedManaged) {
        const retained = await this.registry.update(req.sessionId, {
          state: "starting",
          pid: startedManaged?.pid,
          lastError: message,
        });
        throw Object.assign(new Error(message), {
          session: handleFrom(retained),
          ...copyRuntimeErrorMetadata(err),
        });
      }
      this.managed.delete(req.sessionId);
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
      currentTaskId: req.currentTaskId ?? record.currentTaskId,
      updatedAt: now,
    });
    this.emit({ type: "session.starting", sessionId: req.sessionId });

    let resolvedEnv: Record<string, string> = {};
    let diagnosticSecrets: string[] = [];
    try {
      resolvedEnv = await this.resolveLaunchSecretEnv(route);
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

      let managed: ManagedSession;
      try {
        managed = await resumeManagedSession(
          plan,
          resumeToken,
          (rawEvent) => {
            const ev = boundRuntimeDiagnosticEvent(rawEvent);
            const managedAtEvent =
              this.managed.get(req.sessionId) ?? resumedManaged;
            const terminalWhileAlive =
              (ev.type === "session.failed" || ev.type === "session.exited") &&
              managedAtEvent?.isAlive() === true;
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
            } else if (ev.type === "session.acp_observation") {
              void this.registry
                .update(req.sessionId, {
                  acpObservation: { ...ev.observation },
                })
                .catch(() => undefined);
            }
            if (!terminalWhileAlive) this.emit(ev);
          }
        );
      } catch (error) {
        if (error instanceof ManagedSessionStartupError) {
          resumedManaged = error.managedSession;
          this.managed.set(req.sessionId, resumedManaged);
        }
        throw error;
      }
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
        providerContextRestored: true,
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
      let retainedManaged = false;
      let stopError: unknown;
      if (resumedManaged) {
        try {
          await resumedManaged.stop("interrupt");
        } catch (error) {
          stopError = error;
        }
        retainedManaged = resumedManaged.isAlive();
        if (retainedManaged) {
          this.managed.set(req.sessionId, resumedManaged);
        } else {
          this.managed.delete(req.sessionId);
          await this.waitForManagedTerminal(req.sessionId, true);
        }
      }
      const rawMessage = retainedManaged
        ? `${err instanceof Error ? err.message : String(err)}; ${
            stopError instanceof Error
              ? stopError.message
              : "managed child exit was not confirmed"
          }`
        : err instanceof Error
          ? err.message
          : String(err);
      const tokenRedacted = redactRuntimeValue(rawMessage, tokenRaw);
      const message = redactDiagnosticText(tokenRedacted, {
        env: {
          ...(req.env ?? {}),
        },
        secrets: diagnosticSecrets,
      });
      if (retainedManaged) {
        const retained = await this.registry.update(req.sessionId, {
          state: "starting",
          pid: resumedManaged?.pid,
          lastError: message,
        });
        throw Object.assign(new Error(message), {
          session: handleFrom(retained),
          ...copyRuntimeErrorMetadata(err),
        });
      }
      this.managed.delete(req.sessionId);
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
    // projection (seal-before-submit) does not task.fail a still-running task.
    if (SessionRegistry.isNonTerminal(record.state) || record.state === "starting") {
      await this.registry.update(sessionId, { stopReason: reason });
    }

    const managed = this.managed.get(sessionId);
    try {
      if (managed) {
        await managed.stop(reason);
        if (managed.isAlive()) {
          throw new Error(`Stop failed for session ${sessionId}: child exit was not confirmed`);
        }
        await this.waitForManagedTerminal(sessionId);
        this.managed.delete(sessionId);
      } else if (this.supervisor.isAlive(sessionId)) {
        await this.supervisor.stop(sessionId, { signal: "SIGTERM" });
      }
      await this.waitForChildExit(sessionId);
    } catch (error) {
      const message = truncateUtf8Text(
        error instanceof Error ? error.message : String(error),
        ACP_DIAGNOSTIC_EVENT_BYTES
      );
      const current = await this.registry.read(sessionId);
      if (current) {
        await this.registry.update(sessionId, {
          stopReason: reason,
          lastError: message,
        });
      }
      throw new Error(message);
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
        isAlive: false,
        canResume: false,
        lastError: "session not found",
      };
    }

    // Pull-host external: no PID; open while state remains external.
    if (record.state === "external") {
      return {
        sessionId,
        state: "external",
        isAlive: true,
        canResume: false,
        lastError: record.lastError,
        exitCode: record.exitCode,
      };
    }

    const managed = this.managed.get(sessionId);
    const isAlive = managed ? managed.isAlive() : this.supervisor.isAlive(sessionId);
    const isTurnActive =
      typeof managed?.isTurnActive === "function" ? managed.isTurnActive() : false;
    const adapter = record.adapterId ? this.adapters.get(record.adapterId) : undefined;
    const canResume = Boolean(
      record.connectionSnapshot && record.resumeToken && adapter?.capabilities().canResume
    );

    // Reconcile disk state with process reality (service restart / crash).
    if (SessionRegistry.isNonTerminal(record.state) && !isAlive) {
      // Managed process exited outside stopSession — clear handle.
      if (managed) this.managed.delete(sessionId);
      const nextState = canResume ? "stopped" : "failed";
      const updated = await this.registry.update(sessionId, {
        state: nextState,
        pid: undefined,
        lastError:
          record.lastError ??
          (canResume
            ? "process not alive; resume token retained"
            : "process not alive and not resume-capable"),
      });
      return {
        sessionId,
        state: updated.state,
        isAlive: false,
        canResume,
        isTurnActive: false,
        lastError: updated.lastError,
        exitCode: updated.exitCode,
      };
    }

    return {
      sessionId,
      state: record.state,
      isAlive,
      canResume,
      isTurnActive,
      pid: isAlive ? record.pid : undefined,
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
    const stopErrors: string[] = [];
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
        } catch (error) {
          stopErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (stopErrors.length > 0) {
        throw new Error(
          truncateUtf8Text(
            `Runtime shutdown could not confirm child exit: ${stopErrors.join("; ")}`,
            ACP_DIAGNOSTIC_EVENT_BYTES
          )
        );
      }
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
    const managed = this.managed.get(sessionId);
    if (managed?.isAlive()) {
      const message = truncateUtf8Text(
        lastError ?? "managed terminal event arrived before child exit confirmation",
        ACP_DIAGNOSTIC_EVENT_BYTES
      );
      const current = await this.registry.read(sessionId);
      if (current) {
        await this.registry.update(sessionId, { lastError: message });
      }
      return;
    }
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
   * Enabled skill path refs fail loud when missing; launch-secret resolver errors are not swallowed.
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

    // Pre-resolve launch-secret refs per server so failures name Connection/server/ref only.
    const credCache = new Map<string, string>();
    if (hasMcp && this.resolveLaunchSecretRef) {
      for (const s of route.mcpServers ?? []) {
        if (s.enabled === false) continue;
        const refs = new Set<string>();
        if (s.envSecretRefs) {
          for (const id of Object.values(s.envSecretRefs)) refs.add(id);
        }
        if (s.headerSecretRefs) {
          for (const id of Object.values(s.headerSecretRefs)) refs.add(id);
        }
        for (const id of refs) {
          if (credCache.has(id)) continue;
          let value: string | undefined;
          try {
            value = await this.resolveLaunchSecretRef(id);
          } catch {
            // Fail loud; do not convert resolver throws into "not found".
            // Name only Connection / server / ref — never secret material.
            throw new Error(
              `MCP server ${s.name}: launch-secret resolve failed for Agent Connection ${route.connectionId} launchSecretRef=${id}`
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
          resolveLaunchSecret: (id) => credCache.get(id),
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
   * Resolve launch-secret and endpoint env values for one launch only.
   * Never persists secrets onto SessionRecord.
   */
  private async resolveLaunchSecretEnv(
    route: AgentConnectionConfig
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const ref = route.launchSecretRef?.trim() || "";
    const envKey = route.envKey?.trim() || "";
    if (ref && !envKey) {
      throw new Error(
        `Agent Connection ${route.connectionId} has launchSecretRef but no envKey`
      );
    }
    if (ref && !this.resolveConnectionEnv) {
      throw new Error(
        `Agent Connection ${route.connectionId} references launch secret ${ref} but AgentRuntime has no resolveConnectionEnv hook`
      );
    }
    if (ref) {
      const resolved = { ...(await this.resolveConnectionEnv!(route)) };
      const secret = resolved[envKey];
      if (typeof secret !== "string" || !secret) {
        throw new Error(
          `Launch secret not found or empty for Agent Connection ${route.connectionId} (launchSecretRef=${ref})`
        );
      }
      out[envKey] = secret;
    }
    return out;
  }

  private effectiveEndpointDigest(route: AgentConnectionConfig): string | undefined {
    const raw = route.endpoint;
    const normalized = raw?.trim();
    if (!normalized) return undefined;
    return `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
  }

  private acpOptionsForRoute(route: AgentConnectionConfig) {
    return {
      model: route.model,
      envKey: route.envKey,
      launchSecretRef: route.launchSecretRef,
      endpoint: route.endpoint,
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
