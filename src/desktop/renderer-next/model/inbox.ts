import type { DesktopInboxSnapshot } from "../../inbox-ipc.js";
import type {
  ProjectionIssue,
  ProjectionRead,
} from "../gateway/workspace-projections.js";

export type InboxModel =
  | { state: "idle" }
  | { state: "loading"; workspaceId: string; previous?: DesktopInboxSnapshot }
  | { state: "ready"; workspaceId: string; snapshot: DesktopInboxSnapshot; fetchedAt: string }
  | {
      state: "stale";
      workspaceId: string;
      snapshot: DesktopInboxSnapshot;
      issue: ProjectionIssue;
      failedAt: string;
    }
  | {
      state: "error";
      workspaceId: string;
      issue: ProjectionIssue;
      failedAt: string;
    };

export function settleInboxModel(
  current: InboxModel,
  read: ProjectionRead<DesktopInboxSnapshot>
): InboxModel {
  if (read.ok) {
    return {
      state: "ready",
      workspaceId: read.workspaceId,
      snapshot: read.value,
      fetchedAt: read.fetchedAt,
    };
  }
  const previous =
    current.state === "ready" && current.workspaceId === read.workspaceId
      ? current.snapshot
      : current.state === "stale" && current.workspaceId === read.workspaceId
        ? current.snapshot
        : current.state === "loading" && current.workspaceId === read.workspaceId
          ? current.previous
          : undefined;
  return previous
    ? {
        state: "stale",
        workspaceId: read.workspaceId,
        snapshot: previous,
        issue: read.issue,
        failedAt: read.failedAt,
      }
    : {
        state: "error",
        workspaceId: read.workspaceId,
        issue: read.issue,
        failedAt: read.failedAt,
      };
}
