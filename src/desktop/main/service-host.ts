// Main-process service attach host. Does not stop service when windows close.

import type { ChildProcess } from "node:child_process";
import { attachOrStartService, type AttachResult } from "../client/service-attach.js";
import type { ServiceRpcClient } from "../client/rpc-client.js";

export class DesktopServiceHost {
  private attach: AttachResult | null = null;
  private child: ChildProcess | null = null;

  get client(): ServiceRpcClient | null {
    return this.attach?.client ?? null;
  }

  get url(): string | null {
    return this.attach?.url ?? null;
  }

  get startedByUs(): boolean {
    return !!this.attach?.started;
  }

  async ensureAttached(options?: {
    dataDir?: string;
    serviceEntry?: string;
    cwd?: string;
  }): Promise<AttachResult> {
    if (this.attach) {
      try {
        await this.attach.client.health();
        return this.attach;
      } catch {
        this.attach = null;
      }
    }
    const result = await attachOrStartService({
      dataDir: options?.dataDir,
      serviceEntry: options?.serviceEntry,
      env: process.env,
    });
    this.attach = result;
    this.child = result.child;
    return result;
  }

  /**
   * Intentionally empty: closing the desktop shell must not stop Local Service
   * or in-flight tasks (architecture §2).
   */
  async disposeShellOnly(): Promise<void> {
    this.attach = null;
    // Do not kill this.child — service outlives the UI session.
    this.child = null;
  }
}
