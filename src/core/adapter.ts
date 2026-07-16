// 文件系统适配器。核心逻辑不直接碰 fs,通过这层接口:
// - 插件实现一版走 Obsidian Vault API(享受 Obsidian 的文件监听/同步)
// - CLI 实现一版走 node:fs(给 skill 调用)
// 同一份核心逻辑两处复用,绝不各算各的。

import { MUTATION_LOCK_PATH } from "./paths.js";

export interface FsAdapter {
  /** 列出 dir 下的直接子项(相对帐根的路径)。 */
  listDir(dir: string): Promise<{ name: string; isDir: boolean }[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /**
   * Read raw bytes (attachments, non-UTF-8 payloads).
   * Path traversal defenses must match readFile.
   */
  readBinary(path: string): Promise<Uint8Array>;
  /**
   * Write raw bytes. Prefer atomic temp+rename where the backend allows.
   * Path traversal defenses must match writeFile.
   */
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  /** 移动/重命名(换爹或改名)。 */
  move(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** 跨进程短期写锁；实现可在锁过期后接管。 */
  withLock?<T>(path: string, action: () => Promise<T>): Promise<T>;
}

export interface Clock {
  /** ISO 字符串。抽象出来便于测试与 resume。 */
  now(): string;
}

export function withTentMutation<T>(fs: FsAdapter, action: () => Promise<T>): Promise<T> {
  // 唯一锁：始终 system root 下 mutation.lock，不使用嵌套 .tent/ 或其他路径。
  return fs.withLock ? fs.withLock(MUTATION_LOCK_PATH, action) : action();
}
