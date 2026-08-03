// Machine-local encrypted launch-secret store (Windows MVP).
// Service process only — never Electron safeStorage, never workspace/git.
// Plaintext secrets: set input + resolve() return only; never list/projection/logs/argv.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  backupCorruptMachineFile,
  isNotFoundError,
  warnCorruptMachineState,
  writeJsonAtomic,
} from "../machine-state.js";
import {
  createPlatformLaunchSecretProtector,
  type LaunchSecretProtector,
} from "./launch-secret-protector.js";

/** Shared id shape for launch-secret entries and Connection launchSecretRef values. */
export const LAUNCH_SECRET_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;

/** Non-secret metadata bag stored alongside ciphertext. */
export type LaunchSecretMetadata = {
  label?: string;
};

/** Safe projection returned by list / set — never secret or ciphertext. */
export type LaunchSecretProjection = {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Optional non-secret label (also mirrored as top-level label for convenience). */
  label?: string;
  metadata?: LaunchSecretMetadata;
};

type LaunchSecretRecord = {
  id: string;
  /** Opaque ciphertext from protector.protect(); never plaintext. */
  ciphertext: string;
  createdAt: string;
  updatedAt: string;
  metadata?: LaunchSecretMetadata;
};

export type LaunchSecretStoreOptions = {
  /** Injectable protect/unprotect (offline tests). Production: Windows DPAPI. */
  protector?: LaunchSecretProtector;
};

const MAX_SECRET_BYTES = 64 * 1024;
const MAX_LABEL_LEN = 200;

export function launchSecretsPath(dataDir: string): string {
  return path.join(dataDir, "launch-secrets.json");
}

export function assertLaunchSecretId(id: string): string {
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("Missing or invalid launch secret id");
  }
  const trimmed = id.trim();
  if (!LAUNCH_SECRET_ID_RE.test(trimmed)) {
    throw new Error(
      `Invalid launch secret id: must match ${LAUNCH_SECRET_ID_RE} (lowercase letter, then a-z0-9-, max 63)`
    );
  }
  return trimmed;
}

function project(rec: LaunchSecretRecord): LaunchSecretProjection {
  const out: LaunchSecretProjection = {
    id: rec.id,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
  if (rec.metadata?.label) {
    out.label = rec.metadata.label;
    out.metadata = { label: rec.metadata.label };
  }
  return out;
}

function normalizeSetOpts(
  opts?: LaunchSecretMetadata | { label?: string | null; metadata?: LaunchSecretMetadata }
): LaunchSecretMetadata | undefined | null {
  if (opts === undefined) return undefined;
  if (opts === null) return null;
  // Support { label }, { metadata: { label } }, or { label: null } clear.
  if ("metadata" in opts && opts.metadata !== undefined) {
    return normalizeMetadata(opts.metadata);
  }
  if ("label" in opts) {
    if (opts.label === null) return null; // clear label
    if (opts.label === undefined) return undefined;
    return normalizeMetadata({ label: opts.label });
  }
  return normalizeMetadata(opts);
}

function normalizeMetadata(raw: unknown): LaunchSecretMetadata | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid launch secret metadata: must be a plain object when set");
  }
  const obj = raw as Record<string, unknown>;
  const out: LaunchSecretMetadata = {};
  if ("label" in obj) {
    if (obj.label === undefined || obj.label === null) {
      // omit
    } else if (typeof obj.label !== "string") {
      throw new Error("Invalid launch secret metadata.label: must be a string");
    } else {
      const t = obj.label.trim();
      if (!t) throw new Error("Invalid launch secret metadata.label: must be non-empty when set");
      if (t.length > MAX_LABEL_LEN) {
        throw new Error(
          `Invalid launch secret metadata.label: exceeds ${MAX_LABEL_LEN} characters`
        );
      }
      out.label = t;
    }
  }
  for (const key of Object.keys(obj)) {
    if (key !== "label") {
      throw new Error(`Unknown launch secret metadata field: ${key}`);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isValidDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

/**
 * Strict disk-row parser. Returns null for any malformed row so the loader can
 * quarantine the whole launch-secrets.json — never silently skip bad rows.
 * Only the canonical fields are accepted; unknown keys fail the whole file.
 */
function parseLaunchSecretRecord(value: unknown): LaunchSecretRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const item = value as Record<string, unknown>;
  const allowed = new Set(["id", "ciphertext", "createdAt", "updatedAt", "metadata"]);
  if (Object.keys(item).some((key) => !allowed.has(key))) return null;

  if (typeof item.id !== "string") return null;
  let id: string;
  try {
    id = assertLaunchSecretId(item.id);
  } catch {
    return null;
  }

  if (typeof item.ciphertext !== "string" || item.ciphertext.length === 0) {
    return null;
  }
  if (typeof item.createdAt !== "string" || item.createdAt.length === 0) {
    return null;
  }
  if (typeof item.updatedAt !== "string" || item.updatedAt.length === 0) {
    return null;
  }
  if (!isValidDate(item.createdAt) || !isValidDate(item.updatedAt)) {
    return null;
  }

  let metadata: LaunchSecretMetadata | undefined;
  if (item.metadata !== undefined && item.metadata !== null) {
    try {
      metadata = normalizeMetadata(item.metadata);
    } catch {
      return null;
    }
  }

  const rec: LaunchSecretRecord = {
    id,
    ciphertext: item.ciphertext,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  if (metadata) rec.metadata = metadata;
  return rec;
}

/**
 * Machine-local launch-secret store under dataDir/launch-secrets.json.
 * Ciphertext only on disk; list never returns secrets; resolve is service-internal.
 */
export class LaunchSecretStore {
  private readonly file: string;
  private readonly protector: LaunchSecretProtector;
  private records = new Map<string, LaunchSecretRecord>();
  private loaded = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(dataDir: string, options?: LaunchSecretStoreOptions | LaunchSecretProtector) {
    this.file = launchSecretsPath(dataDir);
    // Accept options bag or bare protector for flexible inject.
    if (options && typeof options === "object" && "protect" in options && "unprotect" in options) {
      this.protector = options as LaunchSecretProtector;
    } else if (options && typeof options === "object" && "protector" in options) {
      this.protector =
        (options as LaunchSecretStoreOptions).protector ?? createPlatformLaunchSecretProtector();
    } else {
      this.protector = createPlatformLaunchSecretProtector();
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    return this.enqueue(async () => {
      if (this.loaded) return;
      await this.loadFromDisk();
    });
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        await this.quarantineCorrupt();
        this.loaded = true;
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        await this.quarantineCorrupt();
        this.loaded = true;
        return;
      }
      const root = parsed as Record<string, unknown>;
      if (Object.keys(root).some((key) => key !== "launchSecrets")) {
        await this.quarantineCorrupt();
        this.loaded = true;
        return;
      }
      const list = root.launchSecrets;
      if (!Array.isArray(list)) {
        await this.quarantineCorrupt();
        this.loaded = true;
        return;
      }
      const loaded = new Map<string, LaunchSecretRecord>();
      for (const item of list) {
        const restored = parseLaunchSecretRecord(item);
        if (!restored) {
          // One bad row poisons the whole machine-state file — never skip.
          await this.quarantineCorrupt();
          this.loaded = true;
          return;
        }
        loaded.set(restored.id, restored);
      }
      this.records = loaded;
      this.loaded = true;
    } catch (err) {
      if (isNotFoundError(err)) {
        this.loaded = true;
        return;
      }
      throw err;
    }
  }

  private async quarantineCorrupt(): Promise<void> {
    const backupPath = await backupCorruptMachineFile(this.file);
    warnCorruptMachineState(this.file, backupPath, "reset");
    this.records.clear();
  }

  private async persist(): Promise<void> {
    const launchSecrets = [...this.records.values()]
      .map((r) => {
        const row: Record<string, unknown> = {
          id: r.id,
          ciphertext: r.ciphertext,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        };
        if (r.metadata) row.metadata = { ...r.metadata };
        return row;
      })
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    await writeJsonAtomic(this.file, { launchSecrets });
  }

  /**
   * Sync presence after ensureLoaded (projection helper).
   * Call ensureLoaded() first from async handlers when needed.
   */
  has(idRaw: string): boolean {
    try {
      const id = assertLaunchSecretId(idRaw);
      return this.records.has(id);
    } catch {
      return false;
    }
  }

  async list(): Promise<LaunchSecretProjection[]> {
    await this.ensureLoaded();
    return this.enqueue(async () =>
      [...this.records.values()]
        .map(project)
        .sort((a, b) => a.id.localeCompare(b.id))
    );
  }

  /**
   * Store secret under id. Overwrites ciphertext if id exists.
   * Response is id/metadata only — never echoes secret or ciphertext.
   */
  async set(
    idRaw: string,
    secret: string,
    opts?: LaunchSecretMetadata | { label?: string | null; metadata?: LaunchSecretMetadata }
  ): Promise<LaunchSecretProjection> {
    const id = assertLaunchSecretId(idRaw);
    if (typeof secret !== "string" || secret.length === 0) {
      throw new Error("launch secret must be a non-empty string");
    }
    if (Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES) {
      throw new Error(`launch secret exceeds ${MAX_SECRET_BYTES} bytes`);
    }
    const metaNorm = normalizeSetOpts(opts);

    await this.ensureLoaded();
    return this.enqueue(async () => {
      const ciphertext = await this.protector.protect(secret);
      if (typeof ciphertext !== "string" || !ciphertext.trim()) {
        throw new Error("launch secret protect() returned empty ciphertext");
      }
      if (ciphertext === secret) {
        throw new Error("launch secret protect() must not return plaintext");
      }

      const now = new Date().toISOString();
      const prev = this.records.get(id);
      const record: LaunchSecretRecord = {
        id,
        ciphertext: ciphertext.trim(),
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      };
      if (opts !== undefined) {
        if (metaNorm === null) {
          // explicit clear
        } else if (metaNorm !== undefined) {
          record.metadata = metaNorm;
        }
      } else if (prev?.metadata) {
        record.metadata = { ...prev.metadata };
      }

      this.records.set(id, record);
      try {
        await this.persist();
      } catch (err) {
        if (prev) this.records.set(id, prev);
        else this.records.delete(id);
        throw err;
      }
      return project(record);
    });
  }

  async delete(idRaw: string): Promise<{ deleted: string }> {
    const id = assertLaunchSecretId(idRaw);
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (!this.records.has(id)) {
        throw new Error(`Launch secret not found: ${id}`);
      }
      const prev = this.records.get(id)!;
      this.records.delete(id);
      try {
        await this.persist();
      } catch (err) {
        this.records.set(id, prev);
        throw err;
      }
      return { deleted: id };
    });
  }

  /**
   * Service-internal only — returns plaintext for LaunchPlan.env injection.
   * Never exposed as client RPC. Fail-loud when missing.
   */
  async resolve(idRaw: string): Promise<string> {
    const id = assertLaunchSecretId(idRaw);
    await this.ensureLoaded();
    return this.enqueue(async () => {
      const rec = this.records.get(id);
      if (!rec) {
        throw new Error(`Launch secret not found: ${id}`);
      }
      const plain = await this.protector.unprotect(rec.ciphertext);
      if (typeof plain !== "string" || !plain) {
        throw new Error(`Launch secret unprotect failed for ${id}`);
      }
      return plain;
    });
  }
}
