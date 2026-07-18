// ContextRef + ContextCard — ephemeral transport payloads (not durable entities).
// Desktop drag (architecture B6) uses these shapes; core only builds the stable text.

export type ContextRefKind =
  | "box"
  | "concept"
  | "task"
  | "delivery"
  | "handoff"
  | "selection"
  | "role";

export type ContextRef = {
  kind: ContextRefKind;
  /** Stable handle: cx- / tk- / dl- / role name / path fragment for selection. */
  id: string;
  /** Optional human path or relative locator (does not replace id). */
  path?: string;
  /** Optional selection range or fragment locator (selection kind). */
  fragment?: string;
};

export type ContextCard = {
  contextRef: ContextRef;
  /** Short fixed prompt for agent paste / drag — keep stable for prompt cache. */
  prompt: string;
  /** UI label (may be localized by clients; English default here). */
  label: string;
  /** Version of the fixed prompt template. */
  templateVersion: "v1";
};

/**
 * Path roots for agent-facing prompts.
 * - workspaceRoot: real project root; run `tent` CLI here.
 * - systemRoot: tent system root (`<workspace>/.tent`); FsAdapter / taskPath base.
 * - tentRootHint: legacy alias for systemRoot (never the bare workspace root alone).
 */
export type ContextCardPathHints = {
  label?: string;
  /** Absolute workspace root (preferred). */
  workspaceRoot?: string;
  /** Absolute tent system root = workspaceRoot/.tent (preferred). */
  systemRoot?: string;
  /**
   * Legacy single hint. Treated as systemRoot when systemRoot is omitted.
   * Do not pass workspace root here — agents would invent `<workspace>/temp`.
   */
  tentRootHint?: string;
};

/** Fixed short instruction template — do not expand with full document bodies. */
export const CONTEXT_CARD_TEMPLATE_VERSION = "v1" as const;

/**
 * Build a context card from a ref. Payload is pointer + fixed read instruction only.
 * Existing handoff / delivery / task entities are pointed at, never re-copied.
 */
export function buildContextCard(
  ref: ContextRef,
  options?: ContextCardPathHints
): ContextCard {
  const kind = ref.kind;
  const id = ref.id.trim();
  if (!id) throw new Error("ContextRef.id cannot be empty.");
  if (!kind) throw new Error("ContextRef.kind is required.");

  const label =
    options?.label?.trim() ||
    (ref.path ? `${kind}:${ref.path}` : `${kind}:${id}`);

  const prompt = formatContextCardPrompt(ref, options);

  return {
    contextRef: {
      kind,
      id,
      path: ref.path,
      fragment: ref.fragment,
    },
    prompt,
    label,
    templateVersion: CONTEXT_CARD_TEMPLATE_VERSION,
  };
}

/**
 * Stable English prompt text. Clients may wrap with UI chrome but should not
 * rewrite the instruction body (prompt-cache friendly).
 *
 * This is the single path-contract tutorial for managed ACP bootstrap.
 * Path contract (in-workspace Tent):
 * - CLI cwd = workspaceRoot
 * - CLI taskPath is relative to systemRoot (`.tent`)
 * - Direct file reads from workspace use `.tent/<path>` or absolute systemRoot
 */
export function formatContextCardPrompt(
  ref: ContextRef,
  hints?: string | ContextCardPathHints
): string {
  const opts: ContextCardPathHints =
    typeof hints === "string" ? { tentRootHint: hints } : hints ?? {};
  const systemRoot = opts.systemRoot?.trim() || opts.tentRootHint?.trim() || "";
  const workspaceRoot = opts.workspaceRoot?.trim() || "";

  const lines = [
    "Tent contextCard v1",
    `contextRef: ${ref.kind}/${ref.id}`,
  ];
  if (ref.path) lines.push(`path: ${ref.path}`);
  if (ref.fragment) lines.push(`fragment: ${ref.fragment}`);
  if (workspaceRoot) lines.push(`workspaceRoot: ${workspaceRoot}`);
  if (systemRoot) {
    lines.push(`systemRoot: ${systemRoot}`);
    // Compat: tentRoot means tent system root (`.tent`), not the workspace.
    lines.push(`tentRoot: ${systemRoot}`);
  }
  if (ref.path) {
    const rel = ref.path.replace(/\\/g, "/").replace(/^\.\/+/, "");
    if (rel && !rel.startsWith(".tent/")) {
      lines.push(`fileRead: .tent/${rel} (relative to workspaceRoot) or \${systemRoot}/${rel}`);
    }
  }
  lines.push(
    "CLI: run tent from workspaceRoot; taskPath is relative to systemRoot (.tent)."
  );
  lines.push("Do not invent missing content; fetch by id before answering.");
  lines.push("Do not resolve operational files as <workspaceRoot>/temp — use .tent/temp.");
  return lines.join("\n");
}

/** Convenience builders for common entities. */
export function boxContextCard(
  boxId: string,
  path?: string,
  opts?: ContextCardPathHints
): ContextCard {
  return buildContextCard({ kind: "box", id: boxId, path }, opts);
}

export function taskContextCard(
  taskId: string,
  opts?: ContextCardPathHints & { path?: string }
): ContextCard {
  return buildContextCard({ kind: "task", id: taskId, path: opts?.path }, opts);
}

export function deliveryContextCard(
  deliveryId: string,
  opts?: ContextCardPathHints & { path?: string }
): ContextCard {
  return buildContextCard({ kind: "delivery", id: deliveryId, path: opts?.path }, opts);
}

/** Serialize for HTML5 text/plain drag (and optional click-to-copy) as plain text. */
export function contextCardToDragText(card: ContextCard): string {
  return card.prompt;
}

/** Parse a v1 drag text back into a ContextRef when possible. */
export function parseContextCardText(text: string): ContextRef | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (!lines[0]?.startsWith("Tent contextCard v1")) return null;
  const refLine = lines.find((l) => l.startsWith("contextRef: "));
  if (!refLine) return null;
  const rest = refLine.slice("contextRef: ".length).trim();
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const kind = rest.slice(0, slash) as ContextRefKind;
  const id = rest.slice(slash + 1).trim();
  if (!id) return null;
  const pathLine = lines.find((l) => l.startsWith("path: "));
  const fragmentLine = lines.find((l) => l.startsWith("fragment: "));
  return {
    kind,
    id,
    path: pathLine ? pathLine.slice("path: ".length).trim() : undefined,
    fragment: fragmentLine ? fragmentLine.slice("fragment: ".length).trim() : undefined,
  };
}
