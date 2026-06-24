# leakykit

[![All Contributors](https://img.shields.io/badge/all_contributors-1-orange.svg?style=flat-square)](#contributors-)

Zero-dependency TypeScript leaky bucket rate limiter. Smooths traffic to a constant output rate — no bursts. Port of Python `ratelimiter` / Go `golang.org/x/time/rate` leaky-bucket mode.

[![npm](https://img.shields.io/npm/v/leakykit)](https://www.npmjs.com/package/leakykit)
[![license](https://img.shields.io/npm/l/leakykit)](LICENSE)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)

## Install

```bash
npm install leakykit
```

## Leaky bucket vs. token bucket

Both limit request rates, but they differ in one key way:

| | Token bucket | Leaky bucket |
|---|---|---|
| Burst traffic | Allowed (up to capacity) | Not allowed — smoothed to constant rate |
| Use case | APIs that permit short bursts | Outgoing webhooks, SMS, strict per-second limits |
| npm alternatives | `limiter`, `bottleneck` | `leaky-bucket` (abandoned 2021) |

## Usage

```typescript
import { LeakyBucket } from "leakykit";

// Allow 10 requests per second (one every 100ms)
const bucket = new LeakyBucket({ capacity: 10, interval: 1000 });

for (const request of requests) {
  await bucket.throttle(); // waits if needed, then resolves
  await sendRequest(request);
}
```

### With AbortSignal

```typescript
const ctrl = new AbortController();

try {
  await bucket.throttle(1, { signal: ctrl.signal });
} catch (e) {
  if (e instanceof DOMException && e.name === "AbortError") {
    console.log("Request was cancelled");
  }
}

// Cancel all pending requests:
ctrl.abort();
```

### Variable cost per request

```typescript
// Bulk operations cost more tokens
const bucket = new LeakyBucket({ capacity: 100, interval: 1000 }); // 100 units/s

await bucket.throttle(1);   // single item — 1 unit
await bucket.throttle(10);  // bulk batch — 10 units
await bucket.throttle(50);  // large batch — 50 units
```

### Rate-limit API calls to an external service

```typescript
import { LeakyBucket } from "leakykit";

// Stripe allows 100 req/s in live mode
const stripe = new LeakyBucket({ capacity: 100, interval: 1000 });

async function chargeCustomers(customers: Customer[]) {
  return Promise.all(customers.map(async customer => {
    await stripe.throttle();
    return fetch(`/api/charge/${customer.id}`, { method: "POST" });
  }));
}
```

### Graceful shutdown

```typescript
const bucket = new LeakyBucket({ capacity: 10, interval: 1000 });

// On shutdown, reject all waiting requests
process.on("SIGTERM", () => {
  bucket.abort(new Error("Server shutting down"));
});
```

## API

### `new LeakyBucket(options)`

```typescript
interface LeakyBucketOptions {
  capacity: number;  // max requests per interval
  interval: number;  // time window in milliseconds
}
```

### `throttle(cost?, opts?): Promise<void>`

Wait for `cost` tokens to become available, then resolve. Calls are queued in FIFO order.

- `cost`: tokens to consume (default: `1`, must be `1..capacity`)
- `opts.signal`: an `AbortSignal` to cancel this specific wait

Throws `RangeError` if `cost <= 0` or `cost > capacity`.

### `abort(reason?): void`

Reject all currently-pending `throttle()` calls with `reason` (default: `DOMException("AbortError")`). Does not affect already-resolved calls.

### `drain(): void`

Alias for `abort(new Error("LeakyBucket drained"))`.

### `availableTokens: number`

Current available capacity (accounting for time elapsed since last request).

### `capacity: number` / `interval: number`

Read-only configuration values.

## How it works

The bucket starts full (`capacity` tokens). Each `throttle()` call:
1. Checks how many tokens have leaked back since the last call (`elapsed * capacity / interval`).
2. If enough tokens are available, consumes them and resolves immediately.
3. Otherwise, schedules a `setTimeout` for when enough tokens will have leaked, then resolves.

This is the same algorithm used by nginx's `limit_req_zone`, Stripe's API rate limiter, and Go's `golang.org/x/time/rate` in leaky-bucket mode.

## Contributors ✨

This project follows the [all-contributors](https://github.com/all-contributors/all-contributors) specification. Contributions of any kind are welcome — code, docs, bug reports, ideas, reviews! See the [emoji key](https://allcontributors.org/docs/en/emoji-key) for how each contribution is recognized, and open a PR or issue to get involved.

Thanks goes to these wonderful people:

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tbody>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/trananhtung"><img src="https://avatars.githubusercontent.com/u/30992229?v=4?s=100" width="100px;" alt="Tung Tran"/><br /><sub><b>Tung Tran</b></sub></a><br /><a href="https://github.com/trananhtung/leakykit/commits?author=trananhtung" title="Code">💻</a> <a href="#maintenance-trananhtung" title="Maintenance">🚧</a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->

## License

MIT
