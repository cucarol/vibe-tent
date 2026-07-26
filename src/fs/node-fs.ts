// node:fs 实现的 FsAdapter。给 CLI(skill 调用)和测试用。
// 插件那侧另有一版走 Obsidian Vault API。

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { FsAdapter, Clock } from "../core/adapter.js";
import { withFileMutationLock } from "./mutation-lock.js";

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
    const abs = this.abs(path);
    await fs.mkdir(nodePath.dirname(abs), { recursive: true });
    await this.atomicReplace(abs, content, "utf8");
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const buf = await fs.readFile(this.abs(path));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    const abs = this.abs(path);
    await fs.mkdir(nodePath.dirname(abs), { recursive: true });
    const payload = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    await this.atomicReplace(abs, payload);
  }

  private async atomicReplace(
    abs: string,
    data: string | Uint8Array,
    encoding?: BufferEncoding
  ): Promise<void> {
    const tmp = `${abs}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fs.writeFile(tmp, data, encoding);
      await this.renameReplacingWithRetry(tmp, abs);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  private async renameReplacingWithRetry(from: string, to: string): Promise<void> {
    const attempts = process.platform === "win32" ? 10 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await fs.rename(from, to);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
        if (!transient || attempt === attempts - 1) throw err;
        const delayMs = Math.min(10 * 2 ** attempt, 100);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
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
    return withFileMutationLock(this.abs(path), action, {
      busyMessage: "Tent is already running another write operation; try again later.",
      acquireFailedMessage: "Cannot acquire the Tent mutation lock.",
    });
  }
}

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}
