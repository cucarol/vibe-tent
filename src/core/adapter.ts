// 文件系统适配器。核心逻辑不直接碰 fs,通过这层接口:
// - 插件实现一版走 Obsidian Vault API(享受 Obsidian 的文件监听/同步)
// - CLI 实现一版走 node:fs(给 skill 调用)
// 同一份核心逻辑两处复用,绝不各算各的。

export interface FsAdapter {
  /** 列出 dir 下的直接子项(相对帐根的路径)。 */
  listDir(dir: string): Promise<{ name: string; isDir: boolean }[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
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
  return fs.withLock ? fs.withLock(".tent/mutation.lock", action) : action();
}
