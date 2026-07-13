interface Waiter {
  finish: (notified: boolean) => void;
  timer: NodeJS.Timeout;
}

export class RoomNotifier {
  readonly #waiters = new Map<string, Set<Waiter>>();

  wait(roomId: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const roomWaiters = this.#waiters.get(roomId) ?? new Set<Waiter>();
      this.#waiters.set(roomId, roomWaiters);

      const placeholder = setTimeout(() => undefined, timeoutMs);
      const waiter: Waiter = {
        finish: (notified) => {
          clearTimeout(waiter.timer);
          roomWaiters.delete(waiter);
          if (roomWaiters.size === 0) {
            this.#waiters.delete(roomId);
          }
          resolve(notified);
        },
        timer: placeholder,
      };
      clearTimeout(placeholder);
      waiter.timer = setTimeout(() => waiter.finish(false), timeoutMs);
      roomWaiters.add(waiter);
    });
  }

  notify(roomId: string): void {
    const roomWaiters = this.#waiters.get(roomId);
    if (roomWaiters === undefined) {
      return;
    }
    for (const waiter of [...roomWaiters]) {
      waiter.finish(true);
    }
  }

  close(): void {
    for (const roomWaiters of this.#waiters.values()) {
      for (const waiter of [...roomWaiters]) {
        waiter.finish(false);
      }
    }
  }
}
