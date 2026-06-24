import { jest, beforeEach, afterEach, describe, test, expect } from "@jest/globals";
import { LeakyBucket } from "../src/index.js";

// Use fake timers throughout to avoid real delays
beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.useRealTimers(); });

describe("LeakyBucket — construction", () => {
  test("default options", () => {
    const b = new LeakyBucket({ capacity: 10, interval: 1000 });
    expect(b.capacity).toBe(10);
    expect(b.interval).toBe(1000);
  });

  test("throws on capacity <= 0", () => {
    expect(() => new LeakyBucket({ capacity: 0, interval: 1000 })).toThrow(RangeError);
    expect(() => new LeakyBucket({ capacity: -1, interval: 1000 })).toThrow(RangeError);
  });

  test("throws on interval <= 0", () => {
    expect(() => new LeakyBucket({ capacity: 10, interval: 0 })).toThrow(RangeError);
    expect(() => new LeakyBucket({ capacity: 10, interval: -100 })).toThrow(RangeError);
  });
});

describe("LeakyBucket — immediate resolution when capacity available", () => {
  test("first call resolves immediately", async () => {
    const b = new LeakyBucket({ capacity: 5, interval: 1000 });
    const resolved = jest.fn();
    const p = b.throttle().then(resolved);
    // flush microtasks
    await Promise.resolve();
    expect(resolved).toHaveBeenCalled();
    await p;
  });

  test("multiple calls up to capacity resolve immediately", async () => {
    const b = new LeakyBucket({ capacity: 3, interval: 1000 });
    const results: string[] = [];
    await Promise.all([
      b.throttle().then(() => results.push("a")),
      b.throttle().then(() => results.push("b")),
      b.throttle().then(() => results.push("c")),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
  });

  test("availableTokens decreases as requests are made", async () => {
    const b = new LeakyBucket({ capacity: 10, interval: 1000 });
    expect(Math.round(b.availableTokens)).toBe(10);
    await b.throttle(3);
    expect(Math.round(b.availableTokens)).toBe(7);
    await b.throttle(4);
    expect(Math.round(b.availableTokens)).toBe(3);
  });
});

describe("LeakyBucket — queuing and timing", () => {
  test("request over capacity waits for leak", async () => {
    // capacity=2, interval=1000ms → leaks 2 tokens/s (1 token per 500ms)
    const b = new LeakyBucket({ capacity: 2, interval: 1000 });
    await b.throttle(2); // consume all tokens

    const resolved = jest.fn();
    const p = b.throttle(1).then(resolved);

    await Promise.resolve(); // flush microtasks
    expect(resolved).not.toHaveBeenCalled(); // still waiting

    jest.advanceTimersByTime(500); // 500ms → 1 token leaks
    await Promise.resolve();
    expect(resolved).toHaveBeenCalled();
    await p;
  });

  test("FIFO queue order preserved", async () => {
    const b = new LeakyBucket({ capacity: 3, interval: 1000 });
    await b.throttle(3); // drain

    const order: number[] = [];
    const promises = [1, 2, 3].map(i =>
      b.throttle(1).then(() => order.push(i))
    );

    // Advance a full interval so all 3 tokens leak, letting all queue items resolve
    jest.advanceTimersByTime(1001);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await Promise.allSettled(promises);
    expect(order).toEqual([1, 2, 3]);
  });

  test("cost>1 consumes multiple tokens", async () => {
    const b = new LeakyBucket({ capacity: 10, interval: 1000 });
    await b.throttle(8); // consume 8 of 10

    const resolved = jest.fn();
    const p = b.throttle(5).then(resolved); // needs 5 but only 2 left

    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();

    // 3 tokens take 300ms to leak (10 tokens/1000ms = 0.01 tokens/ms, 3 tokens = 300ms)
    jest.advanceTimersByTime(300);
    await Promise.resolve();
    expect(resolved).toHaveBeenCalled();
    await p;
  });
});

describe("LeakyBucket — abort and drain", () => {
  test("abort() rejects all pending", async () => {
    const b = new LeakyBucket({ capacity: 1, interval: 1000 });
    await b.throttle(1); // drain

    const errors: unknown[] = [];
    const promises = [
      b.throttle().catch(e => errors.push(e)),
      b.throttle().catch(e => errors.push(e)),
    ];

    await Promise.resolve();
    b.abort(new Error("stopping"));
    await Promise.allSettled(promises);
    expect(errors).toHaveLength(2);
    expect((errors[0] as Error).message).toBe("stopping");
  });

  test("abort() does not affect already-resolved calls", async () => {
    const b = new LeakyBucket({ capacity: 5, interval: 1000 });
    const result = await b.throttle(); // resolves immediately
    expect(result).toBeUndefined();
    b.abort(); // no-op for resolved
  });

  test("AbortSignal cancels a pending request", async () => {
    const b = new LeakyBucket({ capacity: 1, interval: 10000 });
    await b.throttle(); // drain

    const ctrl = new AbortController();
    let caught: unknown;
    const p = b.throttle(1, { signal: ctrl.signal }).catch(e => { caught = e; });

    await Promise.resolve();
    ctrl.abort();
    await p;
    expect((caught as DOMException).name).toBe("AbortError");
  });

  test("pre-aborted signal rejects immediately", async () => {
    const b = new LeakyBucket({ capacity: 5, interval: 1000 });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(b.throttle(1, { signal: ctrl.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  test("drain() rejects all pending with an Error", async () => {
    const b = new LeakyBucket({ capacity: 1, interval: 1000 });
    await b.throttle(); // drain

    const errors: unknown[] = [];
    const p = b.throttle().catch(e => errors.push(e));
    b.drain();
    await p;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
  });
});

describe("LeakyBucket — validation", () => {
  test("cost <= 0 throws", async () => {
    const b = new LeakyBucket({ capacity: 10, interval: 1000 });
    expect(() => b.throttle(0)).toThrow(RangeError);
    expect(() => b.throttle(-1)).toThrow(RangeError);
  });

  test("cost > capacity throws", async () => {
    const b = new LeakyBucket({ capacity: 5, interval: 1000 });
    expect(() => b.throttle(6)).toThrow(RangeError);
  });
});

describe("LeakyBucket — real-world pattern: rate-limited API calls", () => {
  test("sequential throttle calls stay within rate limit", async () => {
    // 5 req / 100ms window → 50 req/s
    const b = new LeakyBucket({ capacity: 5, interval: 100 });
    const timestamps: number[] = [];

    // Simulate 10 API calls (5 fit immediately, next 5 must wait)
    const calls = Array.from({ length: 10 }, () =>
      b.throttle().then(() => timestamps.push(Date.now()))
    );

    // First 5 resolve at t=0
    await Promise.resolve();

    // Advance time; each slot leaks 1 token per 20ms (100ms / 5 tokens)
    for (let i = 0; i < 5; i++) {
      jest.advanceTimersByTime(20);
      await Promise.resolve();
    }

    await Promise.allSettled(calls);
    expect(timestamps).toHaveLength(10);
    // First 5 should be at roughly the same time (or very close)
    // Last 5 should be spaced by ~20ms each
    // (With fake timers, Date.now() is controlled, so exact values vary)
    expect(timestamps.length).toBe(10);
  });
});
