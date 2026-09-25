# Performance review

## Measuring uploads

Set `POOF_TIMING=1` for a CLI `push` or `update` to print one JSON timing record to stderr. The command still prints its normal URL and version to stdout. The timing record includes local file collection, request preparation, credential lookup, HTTP time through response headers, total command time through the upload response, the server's `Server-Timing` phases, and a trace ID. For `push --share`, the record covers the upload only; issuing the share link happens afterward.

```sh
POOF_TIMING=1 poof push example.md
POOF_TIMING=1 poof update <doc-id> example.md
```

The CLI requests server measurements with `X-Poof-Timing: 1`. After authentication, the Worker adds `Server-Timing` and `X-Poof-Trace` response headers and writes one structured `upload_timing` log on a successful upload. The trace ID joins the CLI record to that log. The log contains the operation, file count, total source bytes, durations, and measurement counts. It contains no document content, title, file path, document ID, or credential. Requests without the header do not create these measurements or logs.

For MCP `push` or `update`, pass `measure: true`. The tool result then includes a `Timing` line with the same phases and a trace ID, and the Worker writes the same structured log. MCP `total` starts when the tool handler begins and, for `push` with `share: true`, includes share issuance. Normal MCP calls do not create timing logs.

`parse` includes receiving and parsing the multipart body. `title` includes AI inference when the caller omitted a Markdown title. `d1_*` names identify database steps; `r2_put` covers all blob writes under the configured concurrency limit. `total` is Worker time from entry into the upload route through response construction. CLI `httpMs` includes upload transfer, network time, Worker processing, and return transit, so it must not be added to the server phase durations. The gap between `httpMs` and server `total` is only an estimate of network and edge overhead because the two clocks are independent and measure slightly different boundaries.

For a baseline, collect repeated runs separately for a small file, a large file, and a multi-file directory. Keep `push` and `update` results separate, and record whether OAuth credentials were warm or refreshed. Report the median and slowest runs alongside file counts and byte sizes. Local timings alone do not describe production latency; the sample below used the deployed Worker.

### Production MCP sample, 2026-09-24

The instrumented Worker was deployed to the existing `poof` custom domains. A synthetic owner-only document was pushed, updated, and deleted after measurement. The client was the connected MCP tool in this session; its wall time includes connector overhead. The source contained no private data. All figures are milliseconds.

| Case                                     | Runs | MCP wall time | Worker total |     R2 put |         D1 steps |
| ---------------------------------------- | ---: | ------------: | -----------: | ---------: | ---------------: |
| Small Markdown push                      |    1 |         1,594 |        1,033 |        791 |              242 |
| Small Markdown update                    |    5 |  1,542 median | 1,353 median | 782 median | about 560 median |
| Update with 20 files of about 1 KiB each |    1 |         5,286 |        4,964 |      4,385 |              579 |
| Update with a 1 MiB text source          |    1 |         2,964 |        2,013 |      1,428 |              585 |

The probe was created with an explicit title, and the five small updates retained it, so they did not invoke title inference. Each D1 step took roughly 108 to 125 ms. For those updates, R2 accounted for about 55% to 60% of Worker time; the sequential D1 steps accounted for most of the rest. The 20-file R2 time reflects five waves at the existing four-operation concurrency limit. The 1 MiB update ran after the 20-file update, so its D1 stage included references to the existing file set. These are a few runs from one client, not a latency distribution across users or regions. The five small update MCP wall times were 1,450, 1,589, 1,542, 1,441, and 2,019 ms; the slowest run's Worker time was 1,353 ms, so the extra delay was outside the instrumented tool handler.

The CLI was measured separately with another synthetic Markdown file, an explicit title, and the same deployed Worker. The CLI probe was also deleted after measurement. A small push took 1,424 ms end to end, including 2.6 ms for file collection, 19.6 ms for credential lookup, 1,398 ms through the HTTP response headers, and 832 ms inside the Worker. Its R2 write took 607 ms.

Three CLI updates of the same unchanged file took 2,577, 1,943, and 1,716 ms end to end. Their Worker totals were 1,262, 1,301, and 1,222 ms; R2 writes took 640, 681, and 598 ms; the six sequential D1 steps took 622, 620, and 624 ms in total. File collection took 1.4 to 1.7 ms, and credential lookup took 15.5 to 18.7 ms. HTTP time exceeded Worker time by 1,292, 615, and 471 ms. This difference includes upload transfer, edge handling, network transit, and clock-boundary differences; the current probe does not separate those components.

### First optimization and repeat, 2026-09-24

The API update response now uses the staged version's first file kind and file count, removing its final D1 file-list query. The R2 concurrency limit increased from four to six. The latter matches the [Workers simultaneous outgoing connection limit](https://developers.cloudflare.com/workers/platform/limits/); the R2 writes in this path run after the D1 staging step and before the D1 publication step.

| Case                              |   Before |    After | Interpretation                                                      |
| --------------------------------- | -------: | -------: | ------------------------------------------------------------------- |
| 20-file MCP update, R2 write      | 4,385 ms | 3,122 ms | One run per version; 29% less R2 wait in this sample.               |
| 20-file MCP update, Worker total  | 4,964 ms | 3,719 ms | One run per version; 25% less Worker time in this sample.           |
| Small MCP update, Worker median   | 1,353 ms | 1,332 ms | Five runs per version; this path had no final API response query.   |
| Small CLI update, Worker median   | 1,262 ms | 1,232 ms | Three runs per version; R2 variability masks part of the D1 saving. |
| Small CLI update, D1 steps median |   622 ms |   534 ms | The removed response query previously took 98 to 101 ms.            |

The three repeated CLI updates took 1,801, 1,793, and 1,947 ms end to end. Their Worker totals were 1,168, 1,232, and 1,332 ms. The before and after samples use separate synthetic documents and were taken in the same session. The multi-file comparison has only one run on each version, so its percentage is an observed result rather than a stable latency estimate. All synthetic documents were deleted after measurement.

### Fewer D1 reads, 2026-09-24

The update route now reads the current document and its ordered file snapshot in one D1 query. The same query also reads `MAX(version) + 1`, which preserves numbering after a rollback. If another writer takes that number before staging, the existing unique-constraint retry fetches a fresh number. The ordinary update path now makes three sequential D1 requests: snapshot, staged version, and publication, with the R2 write between the latter two.

| Small update                      | Initial implementation | Combined snapshot | Combined snapshot and next version |
| --------------------------------- | ---------------------: | ----------------: | ---------------------------------: |
| MCP D1 steps, median of five      |           about 560 ms |            470 ms |                             365 ms |
| MCP Worker total, median of five  |               1,353 ms |          1,097 ms |                           1,146 ms |
| CLI D1 steps, median of three     |                 622 ms |            438 ms |                             325 ms |
| CLI Worker total, median of three |               1,262 ms |          1,207 ms |                             943 ms |
| CLI end to end, median of three   |               1,943 ms |          1,897 ms |                           1,486 ms |

The Worker-time medians also include variable R2 latency. In the last two CLI samples, the R2 median changed from 734 to 618 ms, so the Worker-time difference cannot be attributed entirely to the D1 change. In the final sample, the three D1 steps took about 100 to 130 ms each. An update after rollback created version 7 after version 6 had previously existed, and a 20-file update retained all 20 paths. The final 20-file update took 3,462 ms inside the Worker, including 3,090 ms for R2. These samples remain too small to establish a production percentile distribution. The synthetic documents were deleted.

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
| Gzip         |  394.83 KiB |  307.77 KiB |
| Uncompressed | 1984.11 KiB | 1103.04 KiB |

The gzip bundle is 22.1% smaller. These results do not establish a Worker startup latency improvement.

## Browser highlighting

Plain notes, logs, explicitly unhighlighted code, empty blocks, and blocks longer than 10,000 UTF-16 code units skip syntax highlighting. Their text remains visible. Highlighting assets load only when an eligible block exists. Eligible blocks use [highlight.js `highlightElement()`](https://highlightjs.readthedocs.io/en/latest/api.html#highlightelement) in separate timer tasks, allowing the browser to process other work between blocks.

Measurements used ego-browser Chromium 150 on macOS, a visible 1280 × 800 tab, ten reported logical processors, disabled network cache, and no CPU or network throttling. The actual renderer generated baseline and updated HTML from identical inputs. Each fixture loaded through a data URI, isolating rendering from D1, R2, Access, and the owner iframe. A `PerformanceObserver` recorded long tasks; navigation and resource timing were collected 1.5 seconds after navigation. Each baseline/updated fixture was run twice. Concurrent local test activity may have affected timings.

For a 102,400-byte plain-text fixture:

| Metric                 | Baseline, two runs | After, two runs |
| ---------------------- | -----------------: | --------------: |
| CDN encoded body bytes |             44,488 |               0 |
| DOM elements           |               6414 |              12 |
| `loadEventEnd`         |   1509 / 1596.4 ms | 106.4 / 96.9 ms |
| Maximum long task      |      942 / 1055 ms |       0 / 59 ms |

Zero means no task of at least 50 ms was observed. These are local renderer observations, not Lighthouse scores, Core Web Vitals, or production page latency.

A separate fixture contained 50 eligible code blocks, each with 100 lines of JavaScript, totaling 205,000 source bytes. One initial updated run completed only 20 blocks within the 1.5-second observation window, so it was excluded from the completion comparison. A follow-up run waited five seconds and instrumented the highlight.js calls with `performance.now()`. All 50 blocks finished in both versions, and the DOM element count stayed at 15,112. The baseline's synchronous `highlightAll()` call took 322.4 ms; individual `highlightElement()` calls took 3.3 to 25.4 ms after the change. The page's maximum long task increased from 350 ms to 502 ms in that comparison. The supported conclusion is smaller units of synchronous highlighting work; the code fixture does not establish lower overall page blocking time.

## Validation

`bun run test` passed with the default configuration: 407 Worker tests across 21 files and 81 CLI tests across seven files, for 488 passing tests. Type checking, linting, formatting with incremental checks disabled, and diff whitespace checks passed. A final Wrangler dry run reproduced the bundle sizes above.

Re-run validation from the repository root:

```sh
bun run test
bun run typecheck
bun run lint
bun run fmt:check
git diff --check
bunx wrangler deploy --dry-run
```

## Remaining candidates

Individual document, token, version, and file lookups already use primary keys or existing indexes. The remaining growth-sensitive paths are the complete document list and share aggregation, weekly cleanup's accumulated expired keys and sequential D1 probes, and full HTML/Markdown conversion of sources up to 10 MiB. Downloads and raw HTML already stream; title source reads already have a 64 KiB limit per file.

Changes to pagination, database indexes, cleanup scheduling, or conversion behavior need measurements with representative document counts, share history, and source sizes. This review did not collect production traffic or database-size evidence to justify those changes.
