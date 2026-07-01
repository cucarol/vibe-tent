// FsAdapter over Obsidian DataAdapter。帐根是 vault 内的子文件夹(tents/<name>/),
// 核心层路径相对帐根,这里加 tentRoot 前缀转成 vault 相对路径。
// 用低层 vault.adapter(非高层 Vault API):需要文件夹操作 + 访问 .claude 这类 dotfile。

import { App, FileSystemAdapter } from "obsidian";
import * as nodePath from "node:path";
import * as nodeFs from "node:fs/promises";
import { FsAdapter, Clock } from "../core/adapter.js";

export class ObsidianFs implements FsAdapter {
  constructor(private app: App, private tentRoot: string) {}

  private get a() {
    return this.app.vault.adapter;
  }
  private vp(p: string): string {
    return p ? `${this.tentRoot}/${p}` : this.tentRoot;
  }

  async listDir(dir: string): Promise<{ name: string; isDir: boolean }[]> {
    const listing = await this.a.list(this.vp(dir));
    const out: { name: string; isDir: boolean }[] = [];
    for (const f of listing.folders) out.push({ name: base(f), isDir: true });
    for (const f of listing.files) out.push({ name: base(f), isDir: false });
    return out;
  }

  async readFile(path: string): Promise<string> {
    return this.a.read(this.vp(path));
  }

  // 逐级建目录,对齐 node-fs 的 { recursive: true }(Obsidian adapter.mkdir 不保证递归)。
  private async ensureDirAbs(vaultPath: string): Promise<void> {
    if (!vaultPath) return;
    const parts = vaultPath.split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!(await this.a.exists(cur))) await this.a.mkdir(cur);
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.ensureDirAbs(parentOf(this.vp(path)));
    await this.a.write(this.vp(path), content);
  }

  async exists(path: string): Promise<boolean> {
    return this.a.exists(this.vp(path));
  }

  async mkdir(path: string): Promise<void> {
    await this.ensureDirAbs(this.vp(path));
  }

  async move(from: string, to: string): Promise<void> {
    await this.ensureDirAbs(parentOf(this.vp(to)));
    await this.a.rename(this.vp(from), this.vp(to));
  }

  async remove(path: string): Promise<void> {
    const vp = this.vp(path);
    const stat = await this.a.stat(vp);
    if (stat?.type === "folder") await this.a.rmdir(vp, true);
    else await this.a.remove(vp);
  }

  async withLock<T>(path: string, action: () => Promise<T>): Promise<T> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return action();
    const lockPath = nodePath.join(adapter.getBasePath(), this.vp(path));
    await nodeFs.mkdir(nodePath.dirname(lockPath), { recursive: true });
    let handle: nodeFs.FileHandle | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        handle = await nodeFs.open(lockPath, "wx");
        break;
      } catch (error) {
        const exists = typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
        if (!exists) throw error;
        const stat = await nodeFs.stat(lockPath).catch(() => undefined);
        if (!stat || Date.now() - stat.mtimeMs > 120_000) {
          await nodeFs.rm(lockPath, { force: true });
          continue;
        }
        throw new Error("Tent 正在执行另一个写操作,请稍后重试");
      }
    }
    if (!handle) throw new Error("无法获取 Tent mutation lock");
    try {
      await handle.writeFile(JSON.stringify({ createdAt: new Date().toISOString() }), "utf8");
      return await action();
    } finally {
      await handle.close();
      await nodeFs.rm(lockPath, { force: true });
    }
  }
}

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

function base(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}
function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}
