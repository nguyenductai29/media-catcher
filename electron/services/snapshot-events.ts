/** Complete snapshots avoid initial-load/delta races; bursts are coalesced to 5 Hz. */
export class SnapshotEvents<T> {
  private readonly listeners = new Set<(snapshot: T) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly snapshot: () => T) {}
  subscribe(listener: (snapshot: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  notify(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const state = this.snapshot();
      for (const listener of this.listeners) listener(state);
    }, 200);
  }
  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.listeners.clear();
  }
}
