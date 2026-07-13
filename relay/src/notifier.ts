export type WaitOutcome = "notified" | "timeout" | "cancelled";

export interface WaitHandle {
  promise: Promise<WaitOutcome>;
  cancel: () => void;
}

export interface RoomNotifierOptions {
  maxPerRoom?: number;
  maxTotal?: number;
}

interface Waiter {
  timer?: NodeJS.Timeout;
  finish: (outcome: WaitOutcome) => void;
}

export class WaiterLimitError extends Error {
  constructor() {
    super("Too many concurrent long-poll waiters");
    this.name = "WaiterLimitError";
  }
}

export class RoomNotifier {
  readonly #waiters = new Map<string, Set<Waiter>>();
  readonly #maxPerRoom: number;
  readonly #maxTotal: number;
  #total = 0;

  constructor(options: RoomNotifierOptions = {}) {
    this.#maxPerRoom = options.maxPerRoom ?? 100;
    this.#maxTotal = options.maxTotal ?? 1_000;
  }

  get waiterCount(): number {
    return this.#total;
  }

  wait(roomId: string, timeoutMs: number): WaitHandle {
    const roomWaiters = this.#waiters.get(roomId) ?? new Set<Waiter>();
    if (
      roomWaiters.size >= this.#maxPerRoom ||
      this.#total >= this.#maxTotal
    ) {
      throw new WaiterLimitError();
    }
    this.#waiters.set(roomId, roomWaiters);

    let resolvePromise: (outcome: WaitOutcome) => void = () => undefined;
    const promise = new Promise<WaitOutcome>((resolve) => {
      resolvePromise = resolve;
    });
    let finished = false;
    const waiter: Waiter = {
      finish: (outcome) => {
        if (finished) {
          return;
        }
        finished = true;
        if (waiter.timer !== undefined) {
          clearTimeout(waiter.timer);
        }
        if (roomWaiters.delete(waiter)) {
          this.#total -= 1;
        }
        if (roomWaiters.size === 0) {
          this.#waiters.delete(roomId);
        }
        resolvePromise(outcome);
      },
    };
    waiter.timer = setTimeout(() => waiter.finish("timeout"), timeoutMs);
    roomWaiters.add(waiter);
    this.#total += 1;

    return {
      promise,
      cancel: () => waiter.finish("cancelled"),
    };
  }

  notify(roomId: string): void {
    const roomWaiters = this.#waiters.get(roomId);
    if (roomWaiters === undefined) {
      return;
    }
    for (const waiter of [...roomWaiters]) {
      waiter.finish("notified");
    }
  }

  close(): void {
    for (const roomWaiters of this.#waiters.values()) {
      for (const waiter of [...roomWaiters]) {
        waiter.finish("cancelled");
      }
    }
  }
}
