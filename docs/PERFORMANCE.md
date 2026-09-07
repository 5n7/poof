# Performance review

Measured on 2026-09-07, comparing baseline `af4599c` with the working changes on `perf/runtime-io`.

The changes reduce repeated JWKS fetches, overlap independent R2 operations, and avoid unnecessary browser highlighting. The review followed the [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) and checked resource use against [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

## R2 operations

Document creation, version uploads, rollback checks, and title source reads now run at most four R2 operations concurrently. Results retain input order. After a failure, the scheduler stops starting work and waits for active operations before returning the error. Upload cleanup therefore cannot race a late successful write. Binary summaries use `head()` instead of opening and cancelling an object body.

The benchmark called the actual application functions with Bun SQLite, applying the repository's migrations. An in-memory R2 substitute added 10 ms of latency to each operation. Setup ran outside the timed interval; each result is the median of three runs. Title inference returned a fixed local response. These measurements isolate waiting on independent operations; they are not production R2 latency measurements.

| Operation          | Files |  Baseline |    After |
| ------------------ | ----: | --------: | -------: |
| Create             |    20 |  235.7 ms |  57.4 ms |
| Update             |    20 |  239.9 ms |  56.8 ms |
| Rollback           |    20 |  234.8 ms |  56.6 ms |
| Create             |   100 | 1143.7 ms | 276.5 ms |
| Update             |   100 | 1109.8 ms | 282.5 ms |
| Rollback           |   100 | 1107.1 ms | 273.2 ms |
| Title source reads |     8 |   93.0 ms |  24.5 ms |

Peak concurrent R2 operations increased from one to four in every scenario. Tests cover the concurrency limit, result ordering, hidden staged versions, cleanup after delayed writes, and binary summary/download behavior.

## Access verification

Public signing keys use `jose.createRemoteJWKSet`, following the [Cloudflare Access JWT validation example](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/). Each isolate retains at most four issuer key sets with a maximum cache age of 10 minutes. Unknown-key refreshes have a 30-second cooldown, and JWKS fetches time out after five seconds.

The cache stores public keys. Every request still verifies its signature, algorithm, issuer, audience, timestamps, and the claims required by its owner or MCP route. A test making three valid owner requests, followed by invalid signature, audience, and expiry cases, used one JWKS fetch. Tests also cover key rotation, expiry, refresh failures, issuer isolation, and eviction.

Concurrent requests can each fetch keys while the cache is cold; only completed key sets are reused across requests.

## Worker bundle

Wrangler minification is enabled. The measured deployment bundle includes the explicit `jose` dependency.

| Bundle size  |    Baseline |       After |
| ------------ | ----------: | ----------: |
| Uncompressed | 1984.11 KiB | 1103.04 KiB |
| Gzip         |  394.83 KiB |  307.77 KiB |

The gzip bundle is 22.1% smaller. These results do not establish a Worker startup latency improvement.

## Browser highlighting

Plain notes, logs, explicitly unhighlighted code, empty blocks, and blocks longer than 10,000 UTF-16 code units skip syntax highlighting. Their text remains visible. Highlighting assets load only when an eligible block exists. Eligible blocks use [highlight.js `highlightElement()`](https://highlightjs.readthedocs.io/en/latest/api.html#highlightelement) in separate timer tasks, allowing the browser to process other work between blocks.

Measurements used ego-browser Chromium 150 on macOS, a visible 1280 × 800 tab, ten reported logical processors, disabled network cache, and no CPU or network throttling. The actual renderer generated baseline and updated HTML from identical inputs. Each fixture loaded through a data URI, isolating rendering from D1, R2, Access, and the owner iframe. A `PerformanceObserver` recorded long tasks; navigation and resource timing were collected 1.5 seconds after navigation. Each baseline/updated fixture was run twice. Concurrent local test activity may have affected timings.

For a 102,400-byte plain-text fixture:

| Metric                 | Baseline, two runs | After, two runs |
| ---------------------- | -----------------: | --------------: |
| Maximum long task      |      942 / 1055 ms |       0 / 59 ms |
| `loadEventEnd`         |   1509 / 1596.4 ms | 106.4 / 96.9 ms |
| CDN encoded body bytes |             44,488 |               0 |
| DOM elements           |               6414 |              12 |

Zero means no task of at least 50 ms was observed. These are local renderer observations, not Lighthouse scores, Core Web Vitals, or production page latency.

A separate fixture contained 50 eligible code blocks, each with 100 lines of JavaScript, totaling 205,000 source bytes. One initial updated run completed only 20 blocks within the 1.5-second observation window, so it was excluded from the completion comparison. A follow-up run waited five seconds and instrumented the highlight.js calls with `performance.now()`. All 50 blocks finished in both versions, and the DOM element count stayed at 15,112. The baseline's synchronous `highlightAll()` call took 322.4 ms; individual `highlightElement()` calls took 3.3 to 25.4 ms after the change. The page's maximum long task increased from 350 ms to 502 ms in that comparison. The supported conclusion is smaller units of synchronous highlighting work; the code fixture does not establish lower overall page blocking time.

## Validation

`bun run test` passed with the default configuration: 407 Worker tests across 21 files and 81 CLI tests across seven files, for 488 passing tests. Type checking, linting, formatting with incremental checks disabled, and diff whitespace checks passed. A final Wrangler dry run reproduced the bundle sizes above.

Re-run validation from the repository root:

```sh
bun run test
bun run typecheck
bun run lint
bunx dprint check --incremental=false
git diff --check
bunx wrangler deploy --dry-run
```

## Remaining candidates

Individual document, token, version, and file lookups already use primary keys or existing indexes. The remaining growth-sensitive paths are the complete document list and share aggregation, weekly cleanup's accumulated expired keys and sequential D1 probes, and full HTML/Markdown conversion of sources up to 10 MiB. Downloads and raw HTML already stream; title source reads already have a 64 KiB limit per file.

Changes to pagination, database indexes, cleanup scheduling, or conversion behavior need measurements with representative document counts, share history, and source sizes. This review did not collect production traffic or database-size evidence to justify those changes.
