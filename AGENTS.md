# AGENTS.md — Guide for AI coding agents

Read this file before changing the repository. It describes the universal
EPG scraper tool and the rules every patch must follow.

## Product

This repository contains **epg-scraper**, a zero-dependency Node.js CLI
tool that scrapes TV programme-guide sources through pluggable provider
adapters and outputs **XMLTV** files (optionally gzipped) matching the
shape of epgshare01's `epg_ripper_TR1.xml.gz` reference.

It does NOT ship a Tizen app, a web UI, or a server. It is a build-time
CLI tool and library.

## Non-negotiable constraints

- **Node ≥ 18.** The tool uses built-in `fetch`, `node:zlib`, `node:stream`,
  and `node:util` — no runtime dependencies. Do not add runtime deps
  except Playwright (optional, for browser mode).
- **ES modules only.** The project uses `"type": "module"`. All source files
  are `.js` with `import`/`export`. Test files are `.mjs`.
- **No eval.** Provider adapters must parse scraped HTML with regexes or
  string operations over known markup. Never `eval` or `Function()` scraped
  content.
- **No network in tests.** All test suites run against fixtures in
  `test/fixtures/` and stubbed `fetchImpl` — never against live sites.
  Browser tests mock `playwright` via `vi.mock()`. Live scraping is a
  manual step (`npm run scrape`).
- **Runtime dependencies.** Zero by default. Playwright is an optional
  runtime dependency loaded via dynamic `import()` only when `--browser`
  is passed or a provider sets `requiresBrowser: true`.  A clear error
  is thrown if it is not installed.
- **Politeness.** Provider adapters use sequential page fetches with a
  configurable delay, a browser-like User-Agent, and bounded retries.
  No telemetry, no hidden endpoints.
- **Honest errors.** Malformed or unavailable remote data degrades to an
  empty/warned result — never a crash of the CLI.
- **Fixed-offset timestamps.** Programme `start`/`stop` are ISO 8601
  strings with one fixed UTC offset (Turkey: `+03:00` year-round).
  Providers must never emit fractional seconds or bare UTC offsets.
- **Hostile-input hardening.** Every parser must apply the same guards as
  the existing providers: reject out-of-clock wall times (hours > 24,
  minutes > 59) and impossible calendar dates (month 13, Feb 30, day 32)
  before converting with `wallToIso()` — `Date.UTC` normalizes overflow, so
  validate with a round-trip comparison like `toXmltvTimestamp()` does
  (a bare month/day range check misses Feb 30); drop reversed/zero-length
  slots (`stop <= start`, compared on the ISO strings after conversion);
  skip null/hostile channel and programme entries; degrade non-string /
  non-array fields to empty.  Providers must never push a corrupt slot
  into the merge/compare pipeline — the writer (`generateXmltv`) is the
  last line of defense, not the first.

## Runtime map

`bin/epg-scraper.js` is a thin wrapper that calls `runCli()` from
`src/cli.js`. The module tree:

1. `src/http.js` — `fetchText()` (GET) and `fetchResponseWithRetry()` (POST/raw
   Response) with UA, hard timeout, bounded retries with backoff, abort
   control.  `DEFAULT_UA` and `sleep` are exported for the browser layer.
   The POST transport is what gives the JSON/form providers (tvplus,
   digiturkburada, tivibu) the same failsafes the GET providers have.
2. `src/browser.js` — `createBrowserFetcher()` lazy-loads Playwright, launches
   headless Chromium, returns a `fetchImpl`-compatible function that renders
   pages and returns HTML.  Also exports `isPlaywrightAvailable()`.  With
   `stealth: true` (CLI `--stealth`) it masks headless fingerprints
   (`--disable-blink-features=AutomationControlled`, `navigator.webdriver` /
   plugins / `window.chrome` via an init script, `Sec-CH-UA*` client hints,
   `tr-TR` locale/timezone) and simulates human interaction (incremental
   scrolling to load lazy content, small mouse movements) before snapshotting
   the DOM.
3. `src/entities.js` — HTML entity/numeric-reference decoder.
4. `src/slug.js` — Generic channel-id slug (uppercase, non-alphanum → `.`, `.tr` suffix).
5. `src/model.js` — `createChannel()` / `createProgramme()` validation helpers.
6. `src/registry.js` — Provider registry (`registerProvider`/`getProvider`/`listProviders`)
   and `buildDateRange()` date helper.
7. `src/xmltv.js` — XMLTV document writer (`generateXmltv` → string, `writeXmltv` → file),
   timestamp formatter, XML escaping.
8. `src/providers/` — Provider adapters (shared plumbing — wallToIso,
   weekDays, weekdayIndex, normalizeChannelKey, calendar-date validation,
   defaultDates, dedupe/sort, finishResult — lives in
   `src/providers/shared.js`; wallToIso/weekDays are re-exported from
   hurriyet.js for compatibility):
    - `hurriyet.js` — Hürriyet TV Rehberi: `parseDayPage(html)`, `scrape()`, day
      slug/date mapping, curated channel-id map.  Uses positional rail/row
      pairing; handles the `passive` class added by client-side JS.  Channel
      logos come from the rail `<img src>` with the `?v=…` query stripped.
    - `mynet.js` — Mynet TV Rehberi:     `parseMainPage(html)` discovers channels
      (slug, name, logo from card `data-original`/`src`),
     `parseChannelPage(html)` extracts time/name slots.  3-day coverage
      (today + 2 forward), anchored on the first requested date so `--date`
      is honored regardless of the real clock; supports `maxChannels`
      option.  Default `politenessDelayMs` is 500 (vs hurriyet's 250)
      because a full run is ~90 channel pages per day (~260 requests for 3
      days).
    - `tvplus.js` — TV+ (Turkcell) Yayın Akışı: a **plain-HTTP JSON API**
      provider (16 channels incl. TRT Spor/Yıldız, A Spor, HT Spor, FB TV,
      tabii spor, S Sport 1/2, Eurosport 1/2, Sports TV, TRT 1, ATV, TV8,
      TV8,5, A2).  Flow: `POST /get-platform-info` → rotating API base,
      `POST {base}/EPG/JSON/Authenticate` → session cookie, then
      `POST {base}/EPG/JSON/PlayBillList` per channel+day (explicit
      start/stop, pre-stamped `UTC+03:00`).  `parsePlaybill()` /
      `parsePlatformInfo()` / `parseApiInstant()` / `extractSessionCookie()`
      are the pure parsers.  **Failsafe:** if a PlayBillList call exhausts
      its transport retries, the session (rotating host + auth cookie) is
      re-established once and the channel-day retried before it counts as a
      failure.  **Not browser-compatible** (POSTs JSON; do not pass
      `--browser`).  Supports `maxChannels`.
    - `beinsports.js` — beIN Sports Yayın Akışı: beIN Sports 1-4 via the
      `__NEXT_DATA__` JSON embedded in `beinsports.com.tr/yayin-akisi/
      {channel}/{weekday}` pages.  `parseDayPage()` / `parseChannelList()`
      are the pure parsers.  Like hurriyet, the site publishes one Mon–Sun
      week; programme stops derive from the next slot (24:00 for the last).
    - `digiturkburada.js` — DigiturkBurada Yayın Akışı: beIN Sports 5,
      beIN Sports Max 1-2 and GS TV (feeds no other free source carries —
      digiturk.com.tr is Azure-WAF-blocked for datacenter IPs and
      beinsports.com.tr stops at beIN 4).  Static per-channel pages with a
      `<table>` of NAME / HH:MM rows; multi-day via a `POST` of
      `yayin=DD.MM.YYYY` (the served date in the `<h2>` is verified against
      the request).  `parseDayPage()` / `parseServedDate()` are the pure
      parsers.  **Not browser-compatible** (POSTs form data).
    - `sporekrani.js` — Spor Ekranı Yayın Akışı: tabii spor 1-8 (match-day
      simulcast feeds) and S Sport Plus via `sporekrani.com/home/channel/
      {slug}` pages.  Quasar SSR with the schedule in a `window.__INITIAL_
      STATE__` JSON script tag; each page carries a rolling ~30-day event
      list (one fetch per channel).  `extractInitialState()` /
      `parseChannelPage()` are the pure parsers.  Events are filtered to
      the page's own channel (`channels[].name`), and because the source
      publishes **start times only**, stops derive from the next event on
      the page (24:00 for the last), like beinsports.
    - `tivibu.js` — Tivibu Yayın Akışı: Tivibu Spor 1-4 via
      `tivibu.com.tr/kanallar/{slug}` (the old `/yayin-akisi` path is dead)
      and its plain-HTTP JSON API.  One session GET per channel captures the
      ASP.NET antiforgery cookie, hidden-input token and channel code; a
      `POST /Channel/GetPrevueList` per channel-day returns
      `mobilPrevueViewModel[]` with **explicit start/stop** (+ `genre`,
      `description`).  `parseChannelPage()` / `parsePrevueResponse()` /
      `sessionGet()` / `prevuePost()` are the pure parsers/transport.
      Cross-midnight tails from the previous day are dropped (each
      programme belongs to the day it starts on).  **Not browser-
      compatible** (POSTs form data + antiforgery cookie).  Supports
      `maxChannels`.
   - `index.js` — `loadProviders()` registry loader.
9. `src/cli.js` — CLI argument parsing, orchestration, output writing.
   Exports `runCli({ argv, stdout, stderr, cwd })` for testability.
   Manages browser lifecycle when `--browser` or `requiresBrowser`.
   Dispatches between the modes described under "CLI modes".
10. `src/compare.js` — diffs two scrape() results.  `compareResults()` (same
    provider, plain HTTP vs headless browser) and `compareProviderResults()`
    (two providers, channel by channel) share one `compareSides()` core;
    `renderCompareReport()` / `renderProviderCompareReport()` turn the
    reports into text lines.

Sports coverage: `tvplus` + `beinsports` + `digiturkburada` + `sporekrani` +
`tivibu` merged (`--provider tvplus,beinsports,digiturkburada,sporekrani,
tivibu --merge`) cover 37 of the 50 sports channels; the rest are tracked
in `UNSUCCESSFUL.md`.  `sporekrani` adds the tabii spor 1-8 simulcast feeds
and S Sport Plus; `tivibu` adds Tivibu Spor 1-4.  iDMAN TV now has a
**verified candidate source** listed in `UNSUCCESSFUL.md` but no provider
yet; Exxen stays login-walled and the rest are platform-exclusive feeds.
11. `src/merge.js` — `mergeResults(results, canonicalize?)` combines N
    providers into one guide: channels unioned by (canonical) id (first
    provider's name wins; missing icon/url backfilled from later
    providers), programmes
    unioned + deduped, conflicting slots resolved first-provider-wins (the
    order in `--provider a,b,c` sets the precedence).
12. `src/aliases.js` — optional channel-id alias map: `loadAliasMap(path)`
    reads/validates the JSON file, `createCanonicalizer(map)` returns an
    id → canonical-id function that compare and merge apply so ids that
    differ between providers line up.  Resolution is transitive (alias
    chains collapse onto one id) and cycle-safe.

Script load order is not critical (ES modules resolve automatically), but
the dependency chain flows upward: providers → registry/http/xmltv/model/slug → cli.

## CLI modes

`--provider` accepts a comma-separated list; the mode is selected by flags:

- **Single (default)** — one provider, one guide (`epg_<id>_TR.xml[.gz]`).
  `--browser` forces browser rendering; `--stealth` adds anti-bot
  fingerprint masking + scroll/mouse simulation to browser mode.
- **Compare (`--compare`)** — runs twice and diffs the results.  With one
  provider: plain HTTP vs a headless browser.  With two (`--provider a,b`):
  the two providers' guides channel by channel (e.g. is hurriyet's ATV
  schedule the same as mynet's?).  Both sides are written as
  `epg_compare.<id>.xml[.gz]`.  Requires Playwright + Chromium.
- **Merge (`--merge`)** — scrapes every listed provider and writes ONE guide
  (`epg_merged_TR.xml[.gz]`) with the union of channels and programmes; the
  first provider wins conflicts, later ones fill the gaps.
- **Aliases (`--alias-map <path>`)** — JSON `{ aliasId: canonicalId }`
  canonicalizes channel ids in compare and merge (e.g. mynet's `AHABER.tr`
  and hurriyet's `A.HABER.tr` collapse onto one channel).

`--compare` and `--merge` are mutually exclusive; `--compare` supports at
most two providers; multiple providers without either flag is an error.

## Provider contract

Every provider adapter must export:

```js
{
  id: string,              // unique, used on CLI (--provider <id>)
  name: string,            // human label
  baseUrl: string,         // informational
  requiresBrowser?: boolean, // if true, CLI auto-launches headless Chromium
  scrape({                 // async, returns { channels, programmes, days, failures }
    dates,                 // YYYY-MM-DD[] — the week window to cover
    fetchImpl,             // injected: HTTP fetch or browser fetcher
    log,                   // (line: string) => void — progress output
    politenessDelayMs,     // ms between page fetches (provider default;
                             // hurriyet 250, mynet 500 — scale with page count;
                             // overridable via CLI --delay-ms)
    fetchOptions,          // passed through to the transport (retries,
                             // timeoutMs, retryDelayMs, ... — set by the CLI
                             // flags --retries / --timeout-ms /
                             // --retry-delay-ms)
    maxChannels,           // optional cap on the number of channels (mynet)
  }) => Promise<{ channels, programmes, days, failures }>
}
```

Transport failsafes are provided by `src/http.js`, not re-implemented per
provider: `fetchText()` for GET providers, `fetchResponseWithRetry()` for
the JSON/form POST providers.  Every request carries a hard timeout, is
retried on transport errors AND transient non-2xx responses (5xx/429) with
linear backoff, and a request that still fails degrades to a per-page
warning — a provider run fails only when it cannot produce any data at all.

When `requiresBrowser` is true (or `--browser` is passed), `fetchImpl` is
a Playwright-backed function that opens each URL in a headless Chromium tab,
waits for network idle, and returns the rendered HTML.  Provider code that
calls `fetchImpl(url)` works unchanged — the browser layer is transparent.

### Adding a provider

1. Create `src/providers/<id>.js` with:
   - Pure parser function(s) — no I/O, fully fixture-testable.  Apply the
     hostile-input hardening rules from the constraints above: validate
     wall-clock times AND calendar dates before `wallToIso()` (a `Date.UTC`
     round-trip catches month 13 / Feb 30 / day 32), drop reversed /
     zero-length slots and null entries, and degrade malformed bodies to
     empty results — never emit a slot whose instant would silently roll
     into a different day/month.
   - `scrape()` — fetches pages, parses, merges, dedupes.
   - A curated channel-id map for channels that need case-sensitive or
     aliased ids (see `hurriyet.js` for the pattern).  Ids are normalized
     to the epgshare01 reference (`epg_ripper_TR1.xml.gz`) as the source
     of truth — diacritics kept, HD-only ids where the reference has no
     SD variant, renamed/split feeds collapsed (NOW→FOX.tr, TV2→TEVE2.tr).
   - If the source requires JS rendering, set `requiresBrowser: true` in
     the exported provider object.  The CLI will auto-launch Playwright.
2. Register in `src/providers/index.js`:
   ```js
   import * as myProvider from './my-provider.js';
   // Inside loadProviders():
   registerProvider({ id: 'my-provider', name: '...', baseUrl: myProvider.BASE_URL, scrape: myProvider.scrape });
   // If JS-rendered:
   registerProvider({ id: 'my-provider', name: '...', baseUrl: myProvider.BASE_URL, requiresBrowser: true, scrape: myProvider.scrape });
   ```
3. Add fixtures under `test/fixtures/<id>/` and tests under `test/`.

## Data flow

```
fetch text ──> parseDayPage() ──> { channels, slots } ──> wallToIso() ──> { channel, start, stop, title }
                  │                       │
                  │ (7 pages)             │
                  ▼                       ▼
              scrape() ──────────> merge channels (dedupe by id)
                                   merge programmes (dedupe by channel|start|stop|title)
                                   sort by channel then start
                                          │
                                          ▼
                                   generateXmltv() ──> writeXmltv() ──> .xml.gz file
```

## Editing and testing workflow

Inspect current files and `git status` before editing. Use the repository's
npm scripts:

```bash
npm install                 # install dev dependencies (vitest)
npm test                    # vitest run — all tests, no live network
npm run test:watch          # interactive vitest mode
npm run scrape              # live scrape (hurriyet, 7 days)
npm run scrape:gz           # same, gzip output
npm run install:playwright  # install Chromium browser binary for --browser mode
npm run check:browser       # verify Playwright is installed (exit 0 = ready)
node bin/epg-scraper.js --help
node bin/epg-scraper.js --list-providers
```

### Test conventions

- Test files: `test/**/*.test.mjs` (vitest, node environment).
- All network behavior is tested with **fixtures** and **stubbed `fetchImpl`**
  — never against live sites.
- The `fetchImpl` stub must return Response-like objects:
  `{ ok: true, status: 200, text: async () => html }`. Returning raw
  HTML strings will cause `fetchText` to throw `HTTP undefined`.
- CLI tests drive `runCli()` directly with injected `argv`/`stdout`/`stderr`
  — no child processes, no live network.
- Use vitest's `beforeEach`/`afterEach` for temp directory setup and
  `globalThis.fetch` restoration. Always restore globals in `finally` blocks.
- Browser tests (`test/browser.test.mjs`) mock `playwright` via `vi.mock()`
  and `vi.resetModules()`. The mock must define `chromium.launch()` returning
  a browser with `newContext()` → `newPage()` → `goto()`/`content()`/`close()`.
  No real browser is launched during `npm test`.
- Coverage by file: `test/core.test.mjs` — units (entities, slug, xmltv,
  registry, model); `test/hurriyet.test.mjs` — Hürriyet parser, scrape, CLI
  integration; `test/mynet.test.mjs` — Mynet parser, scrape, CLI integration;
  `test/browser.test.mjs` — Playwright fetcher (mocked);
  `test/compare.test.mjs` — http-vs-browser + provider-vs-provider diff
  logic and CLI; `test/merge.test.mjs` — merge logic and CLI;
  `test/reference.test.mjs` — provider id normalization against the
  vendored epgshare01 snapshot (no network; see below).

### Channel-id reference snapshot (keep ≤ 7 days fresh)

Provider channel ids are normalized to epgshare01's `epg_ripper_TR1.xml.gz`.
The upstream id list is vendored at `test/fixtures/epgshare01/reference.json`
(`{ source, updated: "YYYY-MM-DD", channelCount, knownGaps, channels }`)
and enforced by `test/reference.test.mjs`: every curated provider id must
exist upstream (or sit in `knownGaps` with a reason), and the suite **fails
when `updated` is older than 7 days**. Refresh weekly:

```bash
npm run update:reference   # re-downloads, re-extracts, stamps today's date
npm test                    # must stay green
```

`scripts/update-reference-ids.js` preserves `knownGaps` and reports ids
added/removed upstream plus gaps that upstream now covers (drop those from
`knownGaps`). If upstream renamed an id a provider uses, update the
provider's `CHANNEL_ID_MAP` in the same change. Commit the refreshed
`reference.json` together with any map updates.

### Testing best practices

- Add a test for every new flag or mode: at minimum an exit-code assertion
  (0 on success, 1 on validation/launch errors) and, when a file is
  produced, an `existsSync()` + content check.
- Exercise failure and degradation paths explicitly: all pages fail, empty
  guides, bad `--date`, invalid `--max-channels`, missing `--alias-map` file.
- Assert the semantics that are easy to get wrong: merge precedence (first
  provider wins), compare `matched` / `changed` / `only-one-side` counts,
  and alias collapse onto the canonical id.
- Keep fixtures deterministic — fixed dates like `2026-09-07`, never
  "today" — and use uniquely-named fake providers (via `registerProvider`)
  for CLI mode tests so they never collide with real providers.
- Run the full suite (`npm test`) before considering a change complete;
  a red suite is a reason not to commit.

### When changing output shape

The XMLTV output must match the epgshare01 reference format:
- Channel id: uppercase, non-alphanum → `.`, `.tr` suffix, case-sensitive
  exceptions mapped explicitly.
- Programme: `start`/`stop` as `YYYYMMDDHHMMSS +0300`, `<title lang="tr">`,
  optional `<category lang="tr">`.
- Gzip: `node:zlib` level 9, streamed via `pipeline()`.
- Sorting: by channel (codepoint order) then start (ISO string order).
- Deduplication: first occurrence per `(channel, start, stop)` wins.

### Adding a new i18n category mapping

If a provider introduces new `data-type` or genre values, add them to the
provider's `CATEGORY_MAP` object. Categories are emitted as
`<category lang="tr">Label</category>` — use Turkish labels.

## Commit best practices

- Use Conventional Commits in the repo's existing style: `feat:`, `fix:`,
  `refactor:`, `test:`, `docs:`, `chore:`.  Subject in imperative mood,
  1-2 sentences, focused on the *why*; use the body for details that will
  matter later.
- One logical change per commit.  Inspect `git status` and `git diff`
  first; stage only the files that belong to the change.
- Never commit: secrets/API keys, scratch files, or scraper output
  (`epg_*.xml`, `epg_*.xml.gz` — already gitignored).
- Run `npm test` before committing; a red suite means the change is not
  done.
- Only commit lockfile changes when dependencies actually changed.
- Do not push, deploy, or release from an agent session unless explicitly
  asked to.

## Release best practices

- Semantic versioning in `package.json` (+ `package-lock.json`): minor for
  features, patch for fixes, major for breaking changes.
- Keep a `CHANGELOG.md` (Keep a Changelog style) listing Added / Changed /
  Fixed per version.
- Pre-release checklist:
  1. `npm test` green.
  2. `npm run check:browser` if browser/compare features changed.
  3. Manual smoke scrape of the affected providers (`npm run scrape`).
  4. `npm ci && npm test` to prove a clean install builds and passes.
  5. Verify XMLTV output still matches the epgshare01 reference shape.
- Tag releases after the version-bump commit with an annotated tag
  (`git tag -a vX.Y.Z -m "..."`); push the tag with the release.
- This package is `"private": true` — do not `npm publish`.  Releases are
  version bumps + changelog entries + git tags.

## Documentation

When behavior changes, update the relevant docs in the same change:
`README.md` for usage, `AGENTS.md` for agent-facing rules, and
inline JSDoc/comments for API contracts.
