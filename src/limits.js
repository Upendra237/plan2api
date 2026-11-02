export class QueueFullError extends Error {
  constructor() {
    super('The queue is full.');
    this.name = 'QueueFullError';
  }
}

export class ShutdownError extends Error {
  constructor() {
    super('The server is shutting down.');
    this.name = 'ShutdownError';
  }
}

export class AbortedError extends Error {
  constructor() {
    super('The request was cancelled.');
    this.name = 'AbortedError';
  }
}

/** Runs at most `concurrency` tasks at once; up to `maxQueue` more wait in line. */
export class Limiter {
  #concurrency;
  #maxQueue;
  #active = 0;
  #queue = [];
  #closed = false;

  constructor({ concurrency, maxQueue }) {
    this.#concurrency = Math.max(1, concurrency);
    this.#maxQueue = Math.max(0, maxQueue);
  }

  get active() {
    return this.#active;
  }

  get queued() {
    return this.#queue.length;
  }

  /**
   * Runs `task` when a slot is free. Rejects with QueueFullError when the line is full,
   * AbortedError if `signal` fires while waiting, or ShutdownError after close().
   */
  run(task, signal) {
    if (this.#closed) return Promise.reject(new ShutdownError());
    if (signal?.aborted) return Promise.reject(new AbortedError());

    return new Promise((resolve, reject) => {
      const entry = { task, resolve, reject, signal, onAbort: null };
      if (this.#active < this.#concurrency) {
        this.#start(entry);
        return;
      }
      if (this.#queue.length >= this.#maxQueue) {
        reject(new QueueFullError());
        return;
      }
      if (signal) {
        entry.onAbort = () => {
          this.#queue = this.#queue.filter((queued) => queued !== entry);
          reject(new AbortedError());
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.#queue.push(entry);
    });
  }

  /** Rejects everything still waiting and refuses new work. Running tasks are left alone. */
  close() {
    this.#closed = true;
    const waiting = this.#queue;
    this.#queue = [];
    for (const entry of waiting) {
      entry.signal?.removeEventListener('abort', entry.onAbort);
      entry.reject(new ShutdownError());
    }
  }

  #start(entry) {
    this.#active += 1;
    if (entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
    // The slot is freed before the caller hears back, so the caller never sees stale counts.
    Promise.resolve()
      .then(entry.task)
      .then(
        (value) => {
          this.#release();
          entry.resolve(value);
        },
        (error) => {
          this.#release();
          entry.reject(error);
        },
      );
  }

  #release() {
    this.#active -= 1;
    this.#startNext();
  }

  #startNext() {
    while (!this.#closed && this.#active < this.#concurrency && this.#queue.length > 0) {
      this.#start(this.#queue.shift());
    }
  }
}

/** Sliding-window request counter: at most `limit` hits per `windowMs` for each id. 0 = off. */
export class RateLimiter {
  #limit;
  #windowMs;
  #now;
  #hits = new Map();

  constructor({ limit, windowMs = 60_000, now = Date.now }) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** Records a request for `id`. Returns `{ allowed: true }` or `{ allowed: false, retryAfterSeconds }`. */
  hit(id) {
    if (this.#limit <= 0) return { allowed: true };

    const now = this.#now();
    const recent = (this.#hits.get(id) ?? []).filter((time) => time > now - this.#windowMs);
    if (recent.length >= this.#limit) {
      this.#hits.set(id, recent);
      const retryAfterMs = recent[0] + this.#windowMs - now;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    recent.push(now);
    this.#hits.set(id, recent);
    return { allowed: true };
  }
}
