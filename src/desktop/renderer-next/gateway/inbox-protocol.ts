import {
  validateDesktopInboxSnapshot,
  type DesktopInboxSnapshot,
} from "../../inbox-ipc.js";
import type {
  ProjectionIssue,
  ProjectionRead,
} from "./workspace-projections.js";

export const INBOX_PROJECTION_TIMEOUT_MS = 12_000;
export type InboxTransport = (workspaceId: string) => Promise<unknown>;

class InboxProjectionTimeoutError extends Error {
  constructor() {
    super("Desktop Inbox projection timed out");
  }
}

function issueFromError(error: unknown): ProjectionIssue {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out/i.test(message)) return { kind: "timeout", message };
  if (/corrupt|mismatch|payload/i.test(message)) return { kind: "corrupt", message };
  if (/offline|connection|econn|failed to fetch|network|not attached/i.test(message)) {
    return { kind: "transport", message };
  }
  return { kind: "rpc", message };
}

export async function readDesktopInbox(
  transport: InboxTransport | undefined,
  workspaceId: string,
  timeoutMs = INBOX_PROJECTION_TIMEOUT_MS
): Promise<ProjectionRead<DesktopInboxSnapshot>> {
  const ws = workspaceId.trim();
  if (!ws) {
    return {
      ok: false,
      workspaceId: ws,
      issue: { kind: "request", message: "workspaceId is required" },
      failedAt: new Date().toISOString(),
    };
  }
  if (!transport) {
    return {
      ok: false,
      workspaceId: ws,
      issue: { kind: "transport", message: "Desktop Inbox transport is unavailable" },
      failedAt: new Date().toISOString(),
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      transport(ws),
      new Promise<unknown>((_resolve, reject) => {
        timer = setTimeout(() => reject(new InboxProjectionTimeoutError()), timeoutMs);
      }),
    ]);
    const value = validateDesktopInboxSnapshot(raw, ws);
    return { ok: true, workspaceId: ws, value, fetchedAt: new Date().toISOString() };
  } catch (error) {
    return {
      ok: false,
      workspaceId: ws,
      issue: issueFromError(error),
      failedAt: new Date().toISOString(),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
