import type { ArtifactRef } from "../../../core/artifact.js";
import type { ServiceGateway } from "../gateway/service-gateway.js";
import type {
  DocumentIssue,
  FocusBacklink,
  FocusDocumentSnapshot,
} from "../gateway/document-protocol.js";

export type FocusDocumentStatus =
  | "idle"
  | "loading"
  | "read"
  | "edit"
  | "dirty"
  | "saving"
  | "saved"
  | "conflict"
  | "stale"
  | "error"
  | "archived";

export type FocusDocumentView = {
  workspaceId: string | null;
  nodeId: string | null;
  status: FocusDocumentStatus;
  mode: "read" | "edit";
  body: string;
  diskBody?: string;
  etag?: string;
  path?: string;
  dirty: boolean;
  canSave: boolean;
  archived: boolean;
  message?: string;
  backlinks: readonly FocusBacklink[];
  backlinksState: "idle" | "loading" | "ready" | "stale" | "error";
  artifactRefs: readonly ArtifactRef[];
};

export type FocusDocumentActions = {
  beginEdit: () => void;
  updateBody: (body: string) => void;
  save: () => Promise<void>;
  discard: () => void;
  loadDisk: () => void;
  overwriteWithLocal: () => Promise<void>;
  retry: () => Promise<void>;
};

type Entry = {
  workspaceId: string;
  nodeId: string;
  archived: boolean;
  mode: "read" | "edit";
  snapshot: FocusDocumentSnapshot | null;
  draft: string;
  resource: "idle" | "loading" | "ready" | "stale" | "error";
  issue?: DocumentIssue;
  saving: boolean;
  saved: boolean;
  conflictDisk: FocusDocumentSnapshot | null;
  pendingInvalidation: boolean;
  readGeneration: number;
  reloading: boolean;
  pendingReload: boolean;
  pendingForceConflict: boolean;
  backlinks: FocusBacklink[];
  backlinksState: "idle" | "loading" | "ready" | "stale" | "error";
};

export type FocusDocumentGateway = Pick<
  ServiceGateway,
  "focusDocument" | "focusBacklinks" | "writeFocusDocumentBody"
>;

function keyOf(workspaceId: string, nodeId: string): string {
  return `${workspaceId}\u0000${nodeId}`;
}

function createEntry(workspaceId: string, nodeId: string, archived: boolean): Entry {
  return {
    workspaceId,
    nodeId,
    archived,
    mode: "read",
    snapshot: null,
    draft: "",
    resource: "idle",
    saving: false,
    saved: false,
    conflictDisk: null,
    pendingInvalidation: false,
    readGeneration: 0,
    reloading: false,
    pendingReload: false,
    pendingForceConflict: false,
    backlinks: [],
    backlinksState: "idle",
  };
}

export class FocusDocumentController {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private currentKey: string | null = null;
  private online = true;
  private viewCache: FocusDocumentView = {
    workspaceId: null,
    nodeId: null,
    status: "idle",
    mode: "read",
    body: "",
    dirty: false,
    canSave: false,
    archived: false,
    backlinks: [],
    backlinksState: "idle",
    artifactRefs: [],
  };

  constructor(private readonly gateway: FocusDocumentGateway) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getView = (): FocusDocumentView => this.viewCache;

  private buildView(): FocusDocumentView {
    const entry = this.current();
    if (!entry) {
      return {
        workspaceId: null,
        nodeId: null,
        status: "idle",
        mode: "read",
        body: "",
        dirty: false,
        canSave: false,
        archived: false,
        backlinks: [],
        backlinksState: "idle",
        artifactRefs: [],
      };
    }
    const dirty = Boolean(entry.snapshot && entry.draft !== entry.snapshot.body);
    const status: FocusDocumentStatus = entry.resource === "loading"
      ? "loading"
      : entry.resource === "stale"
        ? "stale"
        : entry.resource === "error"
          ? "error"
          : entry.saving
            ? "saving"
            : entry.conflictDisk
              ? "conflict"
              : entry.archived
                ? "archived"
                : dirty
                  ? "dirty"
                  : entry.saved
                    ? "saved"
                    : entry.mode;
    return {
      workspaceId: entry.workspaceId,
      nodeId: entry.nodeId,
      status,
      mode: entry.mode,
      body: entry.draft,
      ...(entry.conflictDisk ? { diskBody: entry.conflictDisk.body } : {}),
      ...(entry.snapshot?.etag ? { etag: entry.snapshot.etag } : {}),
      ...(entry.snapshot?.path ? { path: entry.snapshot.path } : {}),
      dirty,
      canSave:
        this.online &&
        !entry.archived &&
        Boolean(entry.snapshot) &&
        entry.resource === "ready" &&
        dirty &&
        !entry.saving &&
        !entry.conflictDisk,
      archived: entry.archived,
      ...(entry.issue ? { message: entry.issue.message } : {}),
      backlinks: entry.backlinks,
      backlinksState: entry.backlinksState,
      artifactRefs: entry.snapshot?.artifactRefs ?? [],
    };
  }

  actions = (): FocusDocumentActions => ({
    beginEdit: () => this.beginEdit(),
    updateBody: (body) => this.updateBody(body),
    save: () => this.save(false),
    discard: () => this.discard(),
    loadDisk: () => this.loadDisk(),
    overwriteWithLocal: () => this.save(true),
    retry: () => this.retry(),
  });

  select(workspaceId: string, nodeId: string | null, archived = false): void {
    if (!nodeId) {
      this.currentKey = null;
      this.emit();
      return;
    }
    const key = keyOf(workspaceId, nodeId);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = createEntry(workspaceId, nodeId, archived);
      this.entries.set(key, entry);
    } else {
      entry.archived = archived;
      if (archived) entry.mode = "read";
    }
    this.currentKey = key;
    if (!this.online) {
      entry.resource = entry.snapshot ? "stale" : "error";
      entry.issue = { kind: "transport", message: "本地服务连接已中断" };
      if (entry.backlinksState === "ready") entry.backlinksState = "stale";
    }
    this.emit();
    if (
      this.online &&
      (entry.resource === "idle" || entry.resource === "stale" || entry.resource === "error")
    ) {
      void this.reload(entry);
    }
  }

  setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    if (!online) {
      for (const entry of this.entries.values()) {
        // Any read that started while connected must not be allowed to turn a
        // disconnected entry authoritative again when its Promise settles.
        entry.readGeneration += 1;
        entry.resource = entry.snapshot ? "stale" : "error";
        entry.issue = { kind: "transport", message: "本地服务连接已中断" };
        if (entry.backlinksState === "ready") entry.backlinksState = "stale";
      }
      this.emit();
      return;
    }
    const entry = this.current();
    if (!entry) return;
    void this.invalidate();
  }

  beginEdit(): void {
    const entry = this.current();
    if (!entry || entry.archived || !entry.snapshot) return;
    entry.mode = "edit";
    entry.saved = false;
    this.emit();
  }

  updateBody(body: string): void {
    const entry = this.current();
    if (!entry || entry.archived || !entry.snapshot) return;
    entry.draft = body;
    entry.mode = "edit";
    entry.saved = false;
    this.emit();
  }

  discard(): void {
    const entry = this.current();
    if (!entry?.snapshot || entry.saving) return;
    entry.draft = entry.snapshot.body;
    entry.conflictDisk = null;
    entry.saved = false;
    entry.mode = "read";
    this.emit();
  }

  loadDisk(): void {
    const entry = this.current();
    if (
      !entry?.conflictDisk ||
      entry.saving ||
      !this.online ||
      entry.resource !== "ready"
    ) return;
    entry.snapshot = entry.conflictDisk;
    entry.draft = entry.conflictDisk.body;
    entry.conflictDisk = null;
    entry.resource = "ready";
    entry.issue = undefined;
    entry.saved = false;
    entry.mode = "read";
    this.emit();
  }

  async retry(): Promise<void> {
    const entry = this.current();
    if (!entry || !this.online || entry.saving) return;
    await this.reload(entry);
  }

  async invalidate(): Promise<void> {
    const entry = this.current();
    if (!entry) return;
    if (entry.saving) {
      entry.pendingInvalidation = true;
      this.emit();
      return;
    }
    if (!this.online) {
      entry.resource = entry.snapshot ? "stale" : "error";
      this.emit();
      return;
    }
    await this.reload(entry);
  }

  private async save(useConflictEtag: boolean): Promise<void> {
    const entry = this.current();
    if (
      !entry?.snapshot ||
      entry.archived ||
      !this.online ||
      entry.saving ||
      entry.resource !== "ready"
    ) return;
    const dirty = entry.draft !== entry.snapshot.body;
    if (!dirty) return;
    if (entry.conflictDisk && !useConflictEtag) return;
    const baseEtag = useConflictEtag
      ? entry.conflictDisk?.etag
      : entry.snapshot.etag;
    if (!baseEtag) return;
    const savedBody = entry.draft;
    const keyAtStart = this.currentKey;
    entry.saving = true;
    entry.saved = false;
    entry.issue = undefined;
    this.emit();
    const write = await this.gateway.writeFocusDocumentBody(
      entry.workspaceId,
      entry.nodeId,
      savedBody,
      baseEtag
    );
    entry.saving = false;
    const pending = entry.pendingInvalidation;
    entry.pendingInvalidation = false;
    if (!write.ok) {
      entry.issue = write.issue;
      if (write.issue.code === -32009 && this.online) {
        await this.reload(entry, true);
      } else if (pending && this.online) {
        await this.reload(entry);
      } else {
        entry.resource = entry.snapshot ? "stale" : "error";
      }
      if (this.currentKey === keyAtStart) this.emit();
      return;
    }
    entry.conflictDisk = null;
    if (!this.online) {
      // The write may have committed, but a disconnected renderer cannot use
      // that response as its new authority. Keep the prior snapshot and local
      // draft until reconnect performs a read: matching disk content then
      // converges to saved, while a different etag becomes a real conflict.
      entry.resource = "stale";
      entry.issue = { kind: "transport", message: "保存响应已收到，重新连接后将复核磁盘版本" };
      entry.saved = false;
      if (entry.backlinksState === "ready") entry.backlinksState = "stale";
    } else {
      entry.snapshot = {
        ...entry.snapshot,
        body: savedBody,
        etag: write.value.etag,
        path: write.value.path,
      };
      entry.resource = "ready";
      entry.issue = undefined;
      entry.saved = entry.draft === savedBody;
      if (entry.saved) entry.mode = "read";
    }
    if (this.currentKey === keyAtStart) this.emit();
    if (pending && this.online) await this.reload(entry);
  }

  private async reload(entry: Entry, forceConflict = false): Promise<void> {
    if (entry.reloading) {
      entry.pendingReload = true;
      entry.pendingForceConflict ||= forceConflict;
      return;
    }
    entry.reloading = true;
    const generation = ++entry.readGeneration;
    const hadSnapshot = Boolean(entry.snapshot);
    entry.resource = hadSnapshot ? "stale" : "loading";
    entry.issue = undefined;
    entry.backlinksState = entry.backlinks.length ? "stale" : "loading";
    this.emitIfCurrent(entry);
    try {
      const [documentRead, backlinksRead] = await Promise.all([
        this.gateway.focusDocument(entry.workspaceId, entry.nodeId),
        this.gateway.focusBacklinks(entry.workspaceId, entry.nodeId),
      ]);
      if (generation !== entry.readGeneration) return;
      if (!documentRead.ok) {
        entry.resource = entry.snapshot ? "stale" : "error";
        entry.issue = documentRead.issue;
      } else {
        const disk = documentRead.value;
        const dirty = Boolean(entry.snapshot && entry.draft !== entry.snapshot.body);
        const changed = Boolean(entry.snapshot && entry.snapshot.etag !== disk.etag);
        if (dirty && changed && disk.body === entry.draft) {
          entry.snapshot = disk;
          entry.conflictDisk = null;
          entry.resource = "ready";
          entry.issue = undefined;
          entry.saved = true;
          entry.mode = "read";
        } else if ((forceConflict || dirty) && changed) {
          entry.conflictDisk = disk;
          entry.resource = "ready";
        } else {
          entry.snapshot = disk;
          if (!dirty) entry.draft = disk.body;
          entry.conflictDisk = null;
          entry.resource = "ready";
          entry.issue = undefined;
        }
      }
      if (backlinksRead.ok) {
        entry.backlinks = [...backlinksRead.value.backlinks];
        entry.backlinksState = "ready";
      } else {
        entry.backlinksState = entry.backlinks.length ? "stale" : "error";
        if (!entry.issue && entry.resource === "error") entry.issue = backlinksRead.issue;
      }
      this.emitIfCurrent(entry);
    } finally {
      entry.reloading = false;
      const pending = entry.pendingReload;
      const pendingForce = entry.pendingForceConflict;
      entry.pendingReload = false;
      entry.pendingForceConflict = false;
      if (pending && this.online) await this.reload(entry, pendingForce);
    }
  }

  private current(): Entry | null {
    return this.currentKey ? this.entries.get(this.currentKey) ?? null : null;
  }

  private emitIfCurrent(entry: Entry): void {
    if (this.current() === entry) this.emit();
  }

  private emit(): void {
    this.viewCache = this.buildView();
    for (const listener of this.listeners) listener();
  }
}
