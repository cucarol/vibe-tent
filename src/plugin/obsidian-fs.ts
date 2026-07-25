// FsAdapter over Obsidian DataAdapter。帐根是 vault 内的子文件夹(tents/<name>/),
// 核心层路径相对帐根,这里加 tentRoot 前缀转成 vault 相对路径。
// 用低层 vault.adapter(非高层 Vault API):需要文件夹操作 + 访问 .claude 这类 dotfile。

import { App, FileSystemAdapter } from "obsidian";
import * as nodePath from "node:path";
import { FsAdapter, Clock } from "../core/adapter.js";
import { withFileMutationLock } from "../fs/mutation-lock.js";

export class ObsidianFs implements FsAdapter {
  private tentRoot: string;
  private resolvedTentRoot: string;

  constructor(private app: App, tentRoot: string) {
    this.tentRoot = normalizeVaultPath(tentRoot);
    this.resolvedTentRoot = nodePath.posix.resolve("/", this.tentRoot);
  }

  private get a() {
    return this.app.vault.adapter;
  }
  private vp(p: string): string {
    const resolved = nodePath.posix.resolve(this.resolvedTentRoot, normalizeVaultPath(p || "."));
    const inside =
      this.resolvedTentRoot === "/" ||
      resolved === this.resolvedTentRoot ||
      resolved.startsWith(`${this.resolvedTentRoot}/`);
    if (!inside) throw new Error(`Path escapes Tent root: ${p}`);
    return resolved.slice(1);
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

  async readBinary(path: string): Promise<Uint8Array> {
    const ab = await this.a.readBinary(this.vp(path));
    return new Uint8Array(ab);
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    const vp = this.vp(path);
    await this.ensureDirAbs(parentOf(vp));
    // Copy into a fresh ArrayBuffer — vault adapter expects ArrayBuffer, not a view.
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    await this.a.writeBinary(vp, copy.buffer);
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
    return withFileMutationLock(lockPath, action, {
      busyMessage: "帐正在执行另一个写操作,请稍后重试",
      acquireFailedMessage: "无法获取帐 mutation lock",
    });
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

function normalizeVaultPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}
