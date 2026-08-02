/**
 * Service contract gaps observed by Desktop UI.
 * Do not invent client-side workarounds that bypass Local Service.
 * When an RPC lands, remove the gap entry and wire the real method.
 */

export type ContractGap = {
  /** Stable id for tests / diagnostics. */
  id: string;
  /** Missing or incomplete client method(s). */
  methods: string[];
  /** What the UI needs. */
  need: string;
  /** Current Desktop fallback (never fake domain data). */
  fallback: string;
};

/**
 * Authoritative list of backend capabilities the Desktop MVP wants but cannot call.
 * Keep sorted by id. Pure data — no runtime side effects.
 */
export const DESKTOP_CONTRACT_GAPS: readonly ContractGap[] = [
  {
    id: "node.permanent-delete",
    methods: ["docs.delete", "docs.purge"],
    need: "Permanent delete of a Node (beyond archive mode).",
    fallback: "docs.setMode archived only; no permanent delete control.",
  },
  {
    id: "graph.bulk",
    methods: ["graph.snapshot", "docs.graph"],
    need: "Workspace-wide node/edge projection for a full graph canvas.",
    fallback: "Local projection: docs.list tree + docs.backlinks + docs.readForEdit body out-links for the selected node only.",
  },
  {
    id: "mcp.global-config",
    methods: ["mcp.list", "mcp.install"],
    need: "Machine-global MCP server catalog independent of AgentProfile.",
    fallback: "MCP is edited only as profile.mcpServers (next session); skill.list/install covers bundled skills only.",
  },
  {
    id: "session.logs-reload",
    methods: ["session.logs", "session.transcript"],
    need: "Reloadable session log / transcript for past agent turns.",
    fallback: "session.list / session.get show state + alive only; no transcript surface.",
  },
  {
    id: "taskInput.global-list",
    methods: ["taskInput.listPendingWorkspace"],
    need: "Workspace-scoped pending TaskInput list without per-taskPath fan-out.",
    fallback: "Desktop fans out taskInput.listPending over known task paths from task.list / other pending rows.",
  },
  {
    id: "toolApproval.params",
    methods: ["toolApproval.paramsProjection"],
    need: "Tool call argument / params summary on toolApproval projection (beyond options[]).",
    fallback: "UI shows toolTitle + options name/kind summary only; never invents args.",
  },
  // type-tag-mutation closed: Service now exposes registry.type.create/delete,
  // registry.tags / registry.tag.create/delete, docs.setType / docs.tags.set /
  // docs.tag.add / docs.tag.remove. Desktop UI wiring is out of this batch.
  {
    id: "userAsk.agent-profile",
    methods: ["userAsk.sourceProfile"],
    need: "Distinct source agent profile id on UserAsk projection (role alone is insufficient).",
    fallback: "UI labels source as role when present; sessionId shown only in detail notes.",
  },
] as const;

export function contractGapIds(): string[] {
  return DESKTOP_CONTRACT_GAPS.map((g) => g.id);
}

export function findContractGap(id: string): ContractGap | undefined {
  return DESKTOP_CONTRACT_GAPS.find((g) => g.id === id);
}
