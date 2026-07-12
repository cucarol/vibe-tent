// Serialize mutations per mounted workspace (service sole mutation entry).

export class MutationBus {
  private tails = new Map<string, Promise<unknown>>();

  async run<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = prev.catch(() => undefined).then(() => gate);
    this.tails.set(workspaceId, chain);

    await prev.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.tails.get(workspaceId) === chain) {
        this.tails.delete(workspaceId);
      }
    }
  }
}
