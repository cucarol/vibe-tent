import type { FsAdapter } from "../core/adapter.js";
import { withTentMutation } from "../core/adapter.js";
import { parseFrontmatter } from "../core/frontmatter.js";
import { ATTACHMENTS_DIR } from "../core/paths.js";
import { loadTent } from "../core/tree.js";
import {
  extractAttachmentArtifactRefs,
  extractAttachmentReferences,
  resolveAttachmentPath,
} from "./attachment-refs.js";

export const ATTACHMENT_GC_GRACE_DAYS = 30;
export const ATTACHMENT_GC_STATE_PATH = `${ATTACHMENTS_DIR}/.gc-state.json`;
const DAY_MS = 24 * 60 * 60 * 1000;

type AttachmentGcState = {
  version: 1;
  candidates: Record<string, string>;
};

export type AttachmentGcResult = {
  scanned: number;
  retainedByOwner: number;
  retainedByReference: number;
  candidates: number;
  deleted: string[];
  warnings: string[];
};

export type AttachmentGcOptions = {
  now?: string | Date;
  graceDays?: number;
};

/**
 * Conservative mark-and-sweep for Tent-managed binary attachments.
 * A live concept owns its whole attachment directory; textual references are
 * only consulted after that owner disappears. The persisted state records when
 * an orphan was first observed, so old files are never deleted immediately
 * after an accidental concept removal.
 */
export async function sweepAttachmentGc(
  fs: FsAdapter,
  options: AttachmentGcOptions = {}
): Promise<AttachmentGcResult> {
  return withTentMutation(fs, async () => {
    const result: AttachmentGcResult = {
      scanned: 0,
      retainedByOwner: 0,
      retainedByReference: 0,
      candidates: 0,
      deleted: [],
      warnings: [],
    };
    if (!(await fs.exists(ATTACHMENTS_DIR))) return result;

    const nowMs = resolveNow(options.now);
    const graceDays = options.graceDays ?? ATTACHMENT_GC_GRACE_DAYS;
    if (!Number.isFinite(graceDays) || graceDays < 0) {
      throw new Error("attachment GC graceDays must be a non-negative number");
    }

    let tent;
    try {
      tent = await loadTent(fs);
    } catch (error) {
      result.warnings.push(`concept scan failed: ${message(error)}`);
      return result;
    }
    if (tent.duplicateIds.size > 0 || [...tent.byPath.values()].some((box) => box.invalid)) {
      result.warnings.push("concept index is ambiguous or invalid; attachment deletion skipped");
      return result;
    }

    let files: string[];
    let references: Set<string>;
    try {
      files = (await listFiles(fs, ATTACHMENTS_DIR)).filter(
        (path) => path !== ATTACHMENT_GC_STATE_PATH
      );
      references = await collectAttachmentReferences(fs);
    } catch (error) {
      result.warnings.push(`attachment reference scan failed: ${message(error)}`);
      return result;
    }
    result.scanned = files.length;

    const loadedState = await readState(fs);
    if (loadedState.warning) result.warnings.push(loadedState.warning);
    const state: AttachmentGcState = loadedState.state;
    const nextCandidates: Record<string, string> = {};
    const owners = new Set(tent.byId.keys());
    const liveFiles = new Set(files);

    for (const file of files) {
      const owner = file.split("/")[1] ?? "";
      if (owner && owners.has(owner)) {
        result.retainedByOwner += 1;
        continue;
      }
      if (references.has(file)) {
        result.retainedByReference += 1;
        continue;
      }

      const firstSeen = loadedState.valid ? state.candidates[file] : undefined;
      const firstSeenMs = firstSeen ? Date.parse(firstSeen) : Number.NaN;
      if (
        loadedState.valid &&
        Number.isFinite(firstSeenMs) &&
        nowMs - firstSeenMs >= graceDays * DAY_MS
      ) {
        try {
          await fs.remove(file);
          result.deleted.push(file);
        } catch (error) {
          result.warnings.push(`failed to delete ${file}: ${message(error)}`);
          nextCandidates[file] = firstSeen!;
        }
      } else {
        nextCandidates[file] = Number.isFinite(firstSeenMs)
          ? firstSeen!
          : new Date(nowMs).toISOString();
      }
    }

    // Drop state rows for files that no longer exist, became owned, or became referenced.
    for (const path of Object.keys(state.candidates)) {
      if (!liveFiles.has(path)) delete nextCandidates[path];
    }
    result.candidates = Object.keys(nextCandidates).length;
    await fs.writeFile(
      ATTACHMENT_GC_STATE_PATH,
      JSON.stringify({ version: 1, candidates: nextCandidates }, null, 2) + "\n"
    );
    await removeEmptyOwnerDirs(fs, result);
    return result;
  });
}

async function collectAttachmentReferences(fs: FsAdapter): Promise<Set<string>> {
  const refs = new Set<string>();
  for (const path of await listFiles(fs, "")) {
    if (!path.endsWith(".md") || path.startsWith(`${ATTACHMENTS_DIR}/`)) continue;
    const raw = await fs.readFile(path);
    const parsed = parseFrontmatter(raw);
    for (const ref of extractAttachmentReferences(parsed.body, path)) refs.add(ref.path);
    for (const ref of extractAttachmentArtifactRefs(parsed.data, path)) refs.add(ref.path);

    // Operational frontmatter may encode ArtifactRef arrays as JSON strings.
    // Keeping a false positive is safe; missing one is not.
    for (const match of raw.matchAll(
      /(?:\.tent\/)?(?:\.\.\/|\.\/)*attachments\/[A-Za-z0-9._~!$&+,;=@%()\[\]\-\/]+/g
    )) {
      const resolved = resolveAttachmentPath(match[0], path);
      if (resolved) refs.add(resolved);
    }
  }
  return refs;
}

async function listFiles(fs: FsAdapter, dir: string): Promise<string[]> {
  if (dir && !(await fs.exists(dir))) return [];
  const out: string[] = [];
  for (const entry of await fs.listDir(dir)) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDir) out.push(...(await listFiles(fs, path)));
    else out.push(path);
  }
  return out;
}

async function readState(
  fs: FsAdapter
): Promise<{ state: AttachmentGcState; valid: boolean; warning?: string }> {
  const empty: AttachmentGcState = { version: 1, candidates: {} };
  if (!(await fs.exists(ATTACHMENT_GC_STATE_PATH))) return { state: empty, valid: true };
  try {
    const parsed = JSON.parse(await fs.readFile(ATTACHMENT_GC_STATE_PATH)) as Partial<AttachmentGcState>;
    if (parsed.version !== 1 || !parsed.candidates || typeof parsed.candidates !== "object") {
      throw new Error("unsupported state shape");
    }
    const candidates: Record<string, string> = {};
    for (const [path, firstSeen] of Object.entries(parsed.candidates)) {
      if (
        path.startsWith(`${ATTACHMENTS_DIR}/`) &&
        path !== ATTACHMENT_GC_STATE_PATH &&
        typeof firstSeen === "string" &&
        Number.isFinite(Date.parse(firstSeen))
      ) {
        candidates[path] = firstSeen;
      }
    }
    return { state: { version: 1, candidates }, valid: true };
  } catch (error) {
    return {
      state: empty,
      valid: false,
      warning: `attachment GC state reset: ${message(error)}`,
    };
  }
}

async function removeEmptyOwnerDirs(fs: FsAdapter, result: AttachmentGcResult): Promise<void> {
  for (const entry of await fs.listDir(ATTACHMENTS_DIR)) {
    if (!entry.isDir) continue;
    const dir = `${ATTACHMENTS_DIR}/${entry.name}`;
    try {
      if ((await fs.listDir(dir)).length === 0) await fs.remove(dir);
    } catch (error) {
      result.warnings.push(`failed to remove empty attachment directory ${dir}: ${message(error)}`);
    }
  }
}

function resolveNow(value: string | Date | undefined): number {
  const ms = value instanceof Date ? value.getTime() : value ? Date.parse(value) : Date.now();
  if (!Number.isFinite(ms)) throw new Error("attachment GC now must be a valid date");
  return ms;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
