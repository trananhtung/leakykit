export interface LeakyBucketOptions {
  /** Maximum number of requests the bucket holds. Default: 60. */
  capacity: number;
  /** Time window in ms over which `capacity` requests leak through. Default: 1000. */
  interval: number;
}

interface Pending {
  cost: number;
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Leaky bucket rate limiter.
 *
 * Traffic is smoothed to at most `capacity` requests per `interval` ms.
 * Unlike a token bucket, the leaky bucket does not allow bursts — each
 * call to throttle() waits its proportional share before resolving.
 *
 * Inspired by Python ratelimiter and Go golang.org/x/time/rate (leaky-bucket mode).
 *
 * @example
 * // 10 req/s
 * const bucket = new LeakyBucket({ capacity: 10, interval: 1000 });
 * await bucket.throttle();        // waits if needed, then resolves
 * await bucket.throttle(3);       // costs 3 slots
 *
 * // With AbortSignal
 * const ctrl = new AbortController();
 * await bucket.throttle(1, { signal: ctrl.signal });
 */
export class LeakyBucket {
  private readonly _capacity: number;
  private readonly _interval: number;
  private readonly _leakPerMs: number;

  private _tokens: number;    // current available tokens (floating-point)
  private _lastLeak: number;  // timestamp of last leak
  private _queue: Pending[] = [];
  private _timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: LeakyBucketOptions) {
    if (options.capacity <= 0) throw new RangeError("capacity must be > 0");
    if (options.interval <= 0) throw new RangeError("interval must be > 0");
    this._capacity = options.capacity;
    this._interval = options.interval;
    this._leakPerMs = options.capacity / options.interval;
    this._tokens = options.capacity; // start full
    this._lastLeak = Date.now();
  }

  /** Current available capacity (number of requests that can proceed immediately). */
  get availableTokens(): number {
    this._leak();
    return Math.min(this._tokens, this._capacity);
  }

  get capacity(): number { return this._capacity; }
  get interval(): number { return this._interval; }

  /**
   * Throttle: wait until there is capacity for `cost` requests, then resolve.
   *
   * @param cost  How many capacity slots to consume. Default: 1.
   * @param opts  Optional AbortSignal to cancel waiting.
   */
  throttle(cost = 1, opts?: { signal?: AbortSignal }): Promise<void> {
    if (cost <= 0) throw new RangeError("cost must be > 0");
    if (cost > this._capacity) throw new RangeError(`cost ${cost} exceeds capacity ${this._capacity}`);

    this._leak();

    if (opts?.signal?.aborted) {
      return Promise.reject(opts.signal.reason ?? new DOMException("Aborted", "AbortError"));
    }

    // If we have enough tokens right now, consume and return immediately.
    if (this._tokens >= cost) {
      this._tokens -= cost;
      return Promise.resolve();
    }

    // Otherwise queue the request.
    return new Promise<void>((resolve, reject) => {
      const pending: Pending = { cost, resolve, reject, signal: opts?.signal };

      if (opts?.signal) {
        const onAbort = () => {
          const i = this._queue.indexOf(pending);
          if (i !== -1) this._queue.splice(i, 1);
          reject(opts.signal!.reason ?? new DOMException("Aborted", "AbortError"));
        };
        pending.onAbort = onAbort;
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      this._queue.push(pending);
      this._scheduleFlush();
    });
  }

  /**
   * Abort all pending throttle() calls with an AbortError.
   * Does not affect already-resolved calls.
   */
  abort(reason?: unknown): void {
    const err = reason ?? new DOMException("LeakyBucket aborted", "AbortError");
    const queue = this._queue.splice(0);
    for (const p of queue) {
      if (p.signal && p.onAbort) {
        p.signal.removeEventListener("abort", p.onAbort);
      }
      p.reject(err);
    }
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /** Drain all pending requests immediately (for cleanup). */
  drain(): void {
    this.abort(new Error("LeakyBucket drained"));
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _leak(): void {
    const now = Date.now();
    const elapsed = now - this._lastLeak;
    this._tokens = Math.min(this._capacity, this._tokens + elapsed * this._leakPerMs);
    this._lastLeak = now;
  }

  private _scheduleFlush(): void {
    if (this._timer !== null || this._queue.length === 0) return;

    const first = this._queue[0];
    const needed = first.cost - this._tokens;
    const delay = Math.ceil(needed / this._leakPerMs);

    this._timer = setTimeout(() => {
      this._timer = null;
      this._flush();
    }, delay);
  }

  private _flush(): void {
    this._leak();

    while (this._queue.length > 0) {
      const first = this._queue[0];
      if (this._tokens < first.cost) break;
      this._queue.shift();
      this._tokens -= first.cost;
      if (first.signal && first.onAbort) {
        first.signal.removeEventListener("abort", first.onAbort);
      }
      first.resolve();
    }

    if (this._queue.length > 0) this._scheduleFlush();
  }
}
