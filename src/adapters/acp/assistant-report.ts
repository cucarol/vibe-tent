/**
 * Shared contract: managed Delivery.summary is the final user-facing assistant
 * reply for one session/prompt turn — not intermediate narrations, tool chatter,
 * or status/thought diagnostics.
 *
 * Contiguous `agent_message_chunk` text forms one segment. Any other in-turn
 * session/update (tool_call, thought, status, …) seals the open segment.
 * `prompt_complete.assistantText` is the last non-empty segment. A single
 * uninterrupted stream (or providers that only emit one final text) falls back
 * to that full body so summary never becomes empty when real text exists.
 */

/** Trimmed last non-empty segment, or "" when nothing deliverable remains. */
export function selectFinalAssistantReport(
  segments: readonly string[]
): string {
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const text = typeof segments[i] === "string" ? segments[i].trim() : "";
    if (text) return text;
  }
  return "";
}

/**
 * Close the open segment buffer into the segment list.
 * Empty / whitespace-only buffers are dropped (do not create phantom segments).
 */
export function sealAssistantMessageSegment(
  segments: string[],
  current: string
): { segments: string[]; current: string } {
  const body = typeof current === "string" ? current : "";
  if (body.trim()) {
    segments.push(body);
  }
  return { segments, current: "" };
}

/**
 * Session-update kinds that are part of the same contiguous assistant stream.
 * Only these append to the open segment; everything else seals it first.
 */
export function isAssistantMessageChunkKind(kind: string): boolean {
  return kind === "agent_message_chunk";
}
