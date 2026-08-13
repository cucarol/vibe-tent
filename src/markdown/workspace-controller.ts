// Platform-agnostic Markdown workspace view-model (B3).
// Electron renderer / HTML preview shell bind to this controller; they do not own docs truth.

import type { DocsClient } from "./docs-client.js";
import { renderMarkdownToHtml } from "./render.js";
import type {
  BacklinkHit,
  NodeEditSnapshot,
  NodeProjection,
  SearchHit,
} from "./types.js";

export type EditorMode = "source" | "preview";

export type ConflictState = {
  message: string;
  disk: NodeEditSnapshot;
};

export type TabState = {
  nodeId: string;
  path: string;
  name: string;
  type?: string;
  etag: string;
  buffer: string;
  savedRaw: string;
  dirty: boolean;
  mode: EditorMode;
  conflict: ConflictState | null;
  frontmatter: Record<string, unknown>;
};

export type WorkspaceSnapshot = {
  tree: NodeProjection[];
  tabs: TabState[];
  activeCx: string | null;
  searchQuery: string;
  searchHits: SearchHit[];
  backlinks: BacklinkHit[];
  statusMessage: string | null;
};

export class WorkspaceController {
  private tree: NodeProjection[] = [];
  private tabs = new Map<string, TabState>();
  private tabOrder: string[] = [];
  private activeCx: string | null = null;
  private searchQuery = "";
  private searchHits: SearchHit[] = [];
  private backlinks: BacklinkHit[] = [];
  private statusMessage: string | null = null;
  private listeners = new Set<() => void>();

  constructor(private readonly docs: DocsClient) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): WorkspaceSnapshot {
    return {
      tree: this.tree,
      tabs: this.tabOrder.map((cx) => this.tabs.get(cx)!).filter(Boolean),
      activeCx: this.activeCx,
      searchQuery: this.searchQuery,
      searchHits: this.searchHits,
      backlinks: this.backlinks,
      statusMessage: this.statusMessage,
    };
  }

  getActiveTab(): TabState | null {
    return this.activeCx ? this.tabs.get(this.activeCx) ?? null : null;
  }

  async refreshTree(): Promise<void> {
    this.tree = await this.docs.list();
    this.emit();
  }

  async openNode(cxOrPath: string): Promise<TabState> {
    const snap = await this.docs.readForEdit(cxOrPath);
    const existing = this.tabs.get(snap.nodeId);
    if (existing && existing.dirty) {
      this.activeCx = snap.nodeId;
      this.statusMessage = "Tab already open with unsaved changes.";
      this.emit();
      return existing;
    }
    const tab: TabState = {
      nodeId: snap.nodeId,
      path: snap.path,
      name: snap.name,
      type: snap.type,
      etag: snap.etag,
      buffer: snap.raw,
      savedRaw: snap.raw,
      dirty: false,
      mode: existing?.mode ?? "source",
      conflict: null,
      frontmatter: snap.frontmatter,
    };
    if (!this.tabs.has(snap.nodeId)) this.tabOrder.push(snap.nodeId);
    this.tabs.set(snap.nodeId, tab);
    this.activeCx = snap.nodeId;
    this.backlinks = await this.docs.backlinks(snap.nodeId);
    this.statusMessage = null;
    this.emit();
    return tab;
  }

  setActive(cx: string): void {
    if (!this.tabs.has(cx)) return;
    this.activeCx = cx;
    void this.docs.backlinks(cx).then((hits) => {
      this.backlinks = hits;
      this.emit();
    });
    this.emit();
  }

  closeTab(cx: string): void {
    const tab = this.tabs.get(cx);
    if (!tab) return;
    if (tab.dirty) {
      this.statusMessage = "Cannot close dirty tab; save or discard first.";
      this.emit();
      return;
    }
    this.tabs.delete(cx);
    this.tabOrder = this.tabOrder.filter((id) => id !== cx);
    if (this.activeCx === cx) {
      this.activeCx = this.tabOrder[this.tabOrder.length - 1] ?? null;
    }
    this.emit();
  }

  updateBuffer(cx: string, raw: string): void {
    const tab = this.tabs.get(cx);
    if (!tab) return;
    tab.buffer = raw;
    tab.dirty = raw !== tab.savedRaw;
    if (tab.dirty && tab.conflict) {
      // keep conflict until resolved
    }
    this.emit();
  }

  setMode(cx: string, mode: EditorMode): void {
    const tab = this.tabs.get(cx);
    if (!tab) return;
    tab.mode = mode;
    this.emit();
  }

  previewHtml(cx: string): string {
    const tab = this.tabs.get(cx);
    if (!tab) return "";
    const body = splitBody(tab.buffer);
    return renderMarkdownToHtml(body, {
      resolveWikiHref: (raw) => `#open=${encodeURIComponent(raw)}`,
    });
  }

  async save(cx: string): Promise<boolean> {
    const tab = this.tabs.get(cx);
    if (!tab) return false;
    const result = await this.docs.write({
      nodeId: tab.nodeId,
      baseEtag: tab.etag,
      raw: tab.buffer,
    });
    if (!result.ok) {
      if (result.code === "etag_conflict" && result.disk) {
        tab.conflict = {
          message: result.message,
          disk: result.disk,
        };
        this.statusMessage = result.message;
        this.emit();
        return false;
      }
      this.statusMessage = result.message;
      this.emit();
      return false;
    }
    tab.etag = result.etag;
    tab.savedRaw = tab.buffer;
    tab.dirty = false;
    tab.conflict = null;
    this.statusMessage = "Saved.";
    await this.refreshTree();
    this.emit();
    return true;
  }

  /** Conflict UI: load disk version into buffer. */
  loadDiskVersion(cx: string): void {
    const tab = this.tabs.get(cx);
    if (!tab?.conflict) return;
    const disk = tab.conflict.disk;
    tab.buffer = disk.raw;
    tab.etag = disk.etag;
    tab.savedRaw = disk.raw;
    tab.dirty = false;
    tab.frontmatter = disk.frontmatter;
    tab.conflict = null;
    this.statusMessage = "Loaded disk version.";
    this.emit();
  }

  /** Conflict UI: keep mine and overwrite disk (re-base etag then write). */
  async overwriteWithMine(cx: string): Promise<boolean> {
    const tab = this.tabs.get(cx);
    if (!tab?.conflict) return false;
    tab.etag = tab.conflict.disk.etag;
    tab.conflict = null;
    return this.save(cx);
  }

  discard(cx: string): void {
    const tab = this.tabs.get(cx);
    if (!tab) return;
    tab.buffer = tab.savedRaw;
    tab.dirty = false;
    tab.conflict = null;
    this.statusMessage = "Discarded local edits.";
    this.emit();
  }

  async search(query: string): Promise<void> {
    this.searchQuery = query;
    this.searchHits = query.trim() ? await this.docs.search(query) : [];
    this.emit();
  }

  async createNote(name: string, parentPath?: string): Promise<string> {
    const created = await this.docs.createNote({ name, parentPath });
    await this.refreshTree();
    await this.openNode(created.nodeId);
    this.statusMessage = `Created note ${created.path}`;
    this.emit();
    return created.nodeId;
  }

  /** Apply external node.changed: reload clean tabs only. */
  async onNodeChanged(cx: string): Promise<void> {
    const tab = this.tabs.get(cx);
    if (!tab) {
      await this.refreshTree();
      return;
    }
    if (tab.dirty) {
      try {
        const disk = await this.docs.readForEdit(cx);
        if (disk.etag !== tab.etag) {
          tab.conflict = {
            message: "Disk content changed externally while tab is dirty.",
            disk,
          };
          this.statusMessage = tab.conflict.message;
          this.emit();
        }
      } catch {
        /* removed? */
      }
      return;
    }
    await this.openNode(cx);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function splitBody(raw: string): string {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return raw;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return raw;
  const after = text.indexOf("\n", end + 1);
  return after === -1 ? "" : text.slice(after + 1);
}
