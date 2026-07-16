// node:fs 实现的 FsAdapter。给 CLI(skill 调用)和测试用。
// 插件那侧另有一版走 Obsidian Vault API。

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { FsAdapter, Clock } from "../core/adapter.js";

export class NodeFs implements FsAdapter {
  private root: string;

  constructor(root: string) {
    this.root = nodePath.resolve(root);
  }

  private abs(p: string): string {
    const resolved = nodePath.resolve(this.root, p);
    const root = process.platform === "win32" ? this.root.toLowerCase() : this.root;
    const candidate = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (candidate !== root && !candidate.startsWith(root + nodePath.sep)) {
      throw new Error(`Path escapes Tent root: ${p}`);
    }
    return resolved;
  }

  async listDir(dir: string): Promise<{ name: string; isDir: boolean }[]> {
    const entries = await fs.readdir(this.abs(dir), { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith(".git"))
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  }

  async readFile(path: string): Promise<string> {
    return fs.readFile(this.abs(path), "utf8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    await fs.mkdir(nodePath.dirname(this.abs(path)), { recursive: true });
    await fs.writeFile(this.abs(path), content, "utf8");
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const buf = await fs.readFile(this.abs(path));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    const abs = this.abs(path);
    await fs.mkdir(nodePath.dirname(abs), { recursive: true });
    // Atomic replace: write temp sibling then rename into place.
    const tmp = `${abs}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    try {
      await fs.writeFile(tmp, payload);
      await fs.rename(tmp, abs);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(this.abs(path));
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string): Promise<void> {
    await fs.mkdir(this.abs(path), { recursive: true });
  }

  async move(from: string, to: string): Promise<void> {
    await fs.mkdir(nodePath.dirname(this.abs(to)), { recursive: true });
    await fs.rename(this.abs(from), this.abs(to));
  }

  async remove(path: string): Promise<void> {
    await fs.rm(this.abs(path), { recursive: true, force: true });
  }

  async withLock<T>(path: string, action: () => Promise<T>): Promise<T> {
    const lockPath = this.abs(path);
    await fs.mkdir(nodePath.dirname(lockPath), { recursive: true });
    let handle: fs.FileHandle | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        handle = await fs.open(lockPath, "wx");
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const stale = await isStaleLock(lockPath);
        if (!stale || attempt > 0) throw new Error("Tent is already running another write operation; try again later.");
        await fs.rm(lockPath, { force: true });
      }
    }
    if (!handle) throw new Error("Cannot acquire the Tent mutation lock.");
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
      return await action();
    } finally {
      await handle.close();
      await fs.rm(lockPath, { force: true });
    }
  }
}

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function isStaleLock(path: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path);
    return Date.now() - stat.mtimeMs > 120_000;
  } catch {
    return true;
  }
}
