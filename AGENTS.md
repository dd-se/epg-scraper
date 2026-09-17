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
  A provider whose country observes DST (`tvnu` — Sweden) instead stamps
  each timestamp with the offset in force at that instant (`+01:00` winter,
  `+02:00` summer), because a pinned offset would shift every summer
  programme by an hour; the instants stay absolute either way.  Guides may
  therefore legitimately carry two offsets across a DST switch, which is why
  the writer and the reader compare `start`/`stop` as **instants**
  (`isoToEpochMs()`) rather than as ISO strings.  (Merge/compare only key
  slots on the literal strings — they never order by time.)
- **Hostile-input hardening.** Every parser must apply the same guards as
  the existing providers: reject out-of-clock wall times (hours > 24,
  minutes > 59) and impossible calendar dates (month 13, Feb 30, day 32)
  before converting with `wallToIso()` — `Date.UTC` normalizes overflow, so
  validate with a round-trip comparison like `toXmltvTimestamp()` does
  (a bare month/day range check misses Feb 30); drop reversed/zero-length
  slots (`stop <= start` — compared as instants when the provider stamps
  more than one offset, i.e. in a DST zone; compare on the ISO strings when
  the provider pins a single offset);
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
4. `src/slug.js` — Generic channel-id slug (uppercase, non-alphanum → `.`,
   country suffix — `.tr` default, `.se` for the Swedish provider).
5. `src/model.js` — `createChannel()` / `createProgramme()` validation helpers.
6. `src/registry.js` — Provider registry (`registerProvider`/`getProvider`/`listProviders`)
   and `buildDateRange()` date helper.
7. `src/xmltv.js` — XMLTV document writer (`generateXmltv` → string, `writeXmltv` → file),
   timestamp formatter, XML escaping, plus the reader (`parseXmltv` ← string,
   `readXmltvFile` ← `.xml`/`.xml.gz`, `fromXmltvTimestamp` for `start`/`stop`)
   so already-scraped guides can be reused without hitting live servers.
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
      `POST {base}/EPG/JSON/Authenticate` → session cookie, one
      `POST {base}/EPG/JSON/ChannelList` for all channel logos, then
      `POST {base}/EPG/JSON/PlayBillList` per channel+day (explicit
      start/stop, pre-stamped `UTC+03:00`).  `parsePlaybill()` /
      `parsePlatformInfo()` / `parseApiInstant()` / `extractSessionCookie()` /
      `parseChannelListLogos()` / `pickLogoUrl()` are the pure parsers.
      Channel logos come from the ChannelList `picture` map with fixed field
      priority `channelpic` → `poster` → `icon` (`icon` is a portrait show
      poster on several channels, `ad`/`still` are programme stills; sizes
      are not encoded in the URLs, so shape sniffing is impossible).
      **Failsafe:** if a PlayBillList call exhausts
      its transport retries, the session (rotating host + auth cookie) is
      re-established once and the channel-day retried before it counts as a
      failure.  **Not browser-compatible** (POSTs JSON; do not pass
      `--browser`).  Supports `maxChannels`.
    - `beinsports.js` — beIN Sports Yayın Akışı: beIN Sports 1-4 via the
      `__NEXT_DATA__` JSON embedded in `beinsports.com.tr/yayin-akisi/
      {channel}/{weekday}` pages.  `parseDayPage()` / `parseChannelList()`
      are the pure parsers.  Like hurriyet, the site publishes one Mon–Sun
      week; programme stops derive from the next slot (24:00 for the last).
      Channel logos come from `activeLeagues[].image` (single clean URLs
      only — pipe-joined garbage like upstream epgshare01 carries is
      rejected).
    - `digiturkburada.js` — DigiturkBurada Yayın Akışı: beIN Sports 1-5,
      beIN Sports Max 1-2 and GS TV.  beIN 1-4 intentionally duplicate the
      beinsports provider (same feed, verified title agreement ~96%; this
      source keeps full-day schedules while beinsports.com.tr prunes
      already-aired slots intraday) so the daily CI can cover beIN 1-4
      without the beinsports week-scrape.  Static per-channel pages with a
      `<table>` of NAME / HH:MM rows; multi-day via a `POST` of
      `yayin=DD.MM.YYYY` (the served date in the `<h2>` is verified against
      the request; the site purges past days, so only recent/future dates
      serve slots).  `parseDayPage()` / `parseServedDate()` /
      `parseChannelLogo()` are the pure parsers (logos come from the
      `border="0"` header `<img>`, `?rkt=` query stripped).  **Not browser-
      compatible** (POSTs form data).
    - `sporekrani.js` — Spor Ekranı Yayın Akışı: tabii spor 1-8 (match-day
      simulcast feeds) and S Sport Plus via `sporekrani.com/home/channel/
      {slug}` pages.  Quasar SSR with the schedule in a `window.__INITIAL_
      STATE__` JSON script tag; each page carries a rolling ~30-day event
      list (one fetch per channel).  `extractInitialState()` /
      `parseChannelPage()` / `parseChannelIcon()` are the pure parsers.
      Events are filtered to
      the page's own channel (`channels[].name`), and because the source
      publishes **start times only**, stops derive from the next event on
      the page (24:00 for the last), like beinsports.  Channel logos come
      from the page channel's own `channels[].icon` (first matching event
      wins; pipe-joined garbage rejected).
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
    - `idmantv.js` — iDMAN TV Yayın Proqramı (İdman Televiziyası,
      Azerbaijan's first sports channel): the old `idmantv.com.tr` domain is
      dead; the real site is `idmantv.az/az/program`, a static SSR weekly
      page (no JS/API/login) that publishes exactly one Mon–Sun week of
      HH:MM slots in Azerbaijani.  `parseWeeklyPage()` / `parseDayTitle()`
      are the pure parsers; one fetch covers all seven requested days and
      dates outside the published week are skipped with a warning.  The
      single channel carries the site's navbar brand logo
      (`parseBrandLogo()`, from the `w-nav-brand` header image).  Stops
      derive from the next slot (24:00 for the last), matching beinsports.
      Titles are emitted verbatim (the page sometimes appends a stray
      cross-channel note to the last Sunday slots).  Baku wall times are
      stamped with the repo's fixed `+03:00` like every provider — Baku is
      UTC+4/+5, so idmantv instants can sit an hour behind the Turkish
      channels while Azerbaijan observes summer time.
    - `tvnu.js` — TV.nu Yayın Akışı (Sweden): 54 Swedish national + Nordic
      pay-TV channels, including TV4 Fotboll/Hockey/Motor/Sportkanalen/Tennis
      and Sport Live 1–4, via `www.tv.nu/kanal/{slug}?datum=YYYY-MM-DD`. Each
      day page ships the schedule as a JSON string assignment
      (`__INITIAL_STATE__ = "…"`); `extractInitialState()` /
      `parseChannelPage()` / `parseBroadcast()` are the pure parsers
      (logos from the page channel's own `themedLogo`).  Source timestamps
      are **absolute epoch ms** (explicit start+stop — never derived), one
      fetch per channel+day, and pages run 06:00 → 06:00 local, so the day
      before the window is fetched too and slots are bucketed by the
      Stockholm date they start on.  This is the one provider in a DST zone:
      it stamps `epochToIso()` with the Europe/Stockholm offset in force at
      each instant (`+01:00` winter / `+02:00` summer); the CLI registration
      declares `country: 'SE'` (`_SE` filenames), `language: 'sv'`
      (`lang="sv"` titles) and `timeZone: 'Europe/Stockholm'` (Stockholm
      "today"), and ids normalize to the Swedish `epg_ripper_SE1.xml.gz`
      snapshot (`reference-se.json`).
   - `index.js` — `loadProviders()` registry loader.
9. `src/cli.js` — CLI argument parsing, orchestration, output writing.
   Exports `runCli({ argv, stdout, stderr, cwd })` for testability.
   Manages browser lifecycle when `--browser` or `requiresBrowser`.
   Dispatches between the modes described under "CLI modes".  Providers may
   declare `country` (output filename suffix, default `TR`), `language`
   (`lang` attribute, default `tr`) and `timeZone` (default window anchor,
   default `Europe/Istanbul`) — tvnu declares `SE` / `sv` /
   `Europe/Stockholm`.  Compare/merge filenames and merge language follow
   the same declarations; offline `--merge --from` keeps the TR/tr defaults.
10. `src/compare.js` — diffs two scrape() results.  `compareResults()` (same
    provider, plain HTTP vs headless browser) and `compareProviderResults()`
    (two providers, channel by channel) share one `compareSides()` core;
    `renderCompareReport()` / `renderProviderCompareReport()` turn the
    reports into text lines.

Sports coverage: `tvplus` + `beinsports` + `digiturkburada` + `sporekrani` +
`tivibu` + `idmantv` merged (`--provider tvplus,beinsports,digiturkburada,
sporekrani,tivibu,idmantv --merge`) cover 38 of the 50 sports channels; the
rest are tracked in `UNSUCCESSFUL.md`.  The daily CI merge skips
`beinsports` (its 1-4 feeds are covered by `digiturkburada`, which keeps
full-day schedules).  `sporekrani` adds the tabii spor 1-8
simulcast feeds and S Sport Plus; `tivibu` adds Tivibu Spor 1-4; `idmantv`
adds İdman TV (an Azerbaijani charter, not in the epgshare01 reference).
Exxen stays login-walled and the rest are platform-exclusive feeds.
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
  first provider wins conflicts, later ones fill the gaps.  With `--from
  a.xml.gz,b.xml.gz` no server is hit: already-scraped guides are merged
  offline (file order sets the precedence) — this is how CI scrapes each
  provider exactly once and merges the artifacts.
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
Deterministic statuses (404/410 always; 403 on GET pages, e.g. WAF-blocked
hosts) are never retried — except 403 on API POSTs, where TV+/Tivibu signal
session expiry and the providers' re-auth failsafe depends on the retry.
CLI `--days-back`/`--days-forward` are capped at 60 so a hostile window
cannot hang `buildDateRange()`.

When `requiresBrowser` is true (or `--browser` is passed), `fetchImpl` is
a Playwright-backed function that opens each URL in a headless Chromium tab,
waits for network idle, and returns the rendered HTML.  Provider code that
calls `fetchImpl(url)` works unchanged — the browser layer is transparent.

### Adding a provider

1. Create `src/providers/<id>.js` with:
   - Pure parser function(s) — no I/O, fully fixture-testable.  Apply the
     hostile-input hardening rules from the constraints above: validate
     wall-clock times AND calendar dates before converting (a `Date.UTC`
     round-trip catches month 13 / Feb 30 / day 32 — a DST-zone provider
     like tvnu validates epoch ms through the same round-trip; see
     `tvnu.js` `parseBroadcast()`), drop reversed /
     zero-length slots and null entries, and degrade malformed bodies to
     empty results — never emit a slot whose instant would silently roll
     into a different day/month.
   - `scrape()` — fetches pages, parses, merges, dedupes.
   - A curated channel-id map for channels that need case-sensitive or
     aliased ids (see `hurriyet.js` for the pattern).  Ids are normalized
     to the epgshare01 reference for the provider's own country
     (`epg_ripper_TR1.xml.gz` for the Turkish providers,
     `epg_ripper_SE1.xml.gz` for tvnu) as the source
     of truth — diacritics kept, HD-only ids where the reference has no
     SD variant, renamed/split feeds collapsed (NOW→FOX.tr, TV2→TEVE2.tr;
     tvnu collapses playlist quality variants FHD/HD/SD onto the one id
     the Swedish reference carries per feed, e.g. `SVT.1.se` →
     `[SVT1HD].SVT1.HD.se`).  A provider whose ids carry a source tag must
     export `CHANNEL_ID_MAP` (name → id) for `test/reference.test.mjs` —
     tvnu's is derived from the `CHANNELS` table.
   - If the source requires JS rendering, set `requiresBrowser: true` in
     the exported provider object.  The CLI will auto-launch Playwright.
     Otherwise declare the guide's locale in `src/providers/index.js`:
     `country` (filename suffix, default `TR`), `language` (`lang`
     attribute, default `tr`) and `timeZone` (default-window anchor,
     default `Europe/Istanbul`) — tvnu is the so-far only provider that
     declares all three (`SE` / `sv` / `Europe/Stockholm`) because Sweden
     observes DST.
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
  `test/idmantv.test.mjs` — iDMAN TV weekly-page parser, scrape, CLI
  integration; `test/tvnu.test.mjs` — TV.nu parser (DST offsets, 06:00 day
  boundary), scrape, CLI integration (`_SE` filename, `lang="sv"`);
  `test/reference.test.mjs` — provider id normalization against
  the vendored per-country epgshare01 snapshots (TR + SE; no network — see
  below).

### Channel-id reference snapshots (keep ≤ 7 days fresh)

Provider channel ids are normalized to epgshare01's per-country guides: the
Turkish providers to `epg_ripper_TR1.xml.gz`, the Swedish `tvnu` provider to
`epg_ripper_SE1.xml.gz`.  The upstream id lists are vendored at
`test/fixtures/epgshare01/reference.json` (TR) and
`test/fixtures/epgshare01/reference-se.json` (SE)
(`{ source, country, updated: "YYYY-MM-DD", channelCount, knownGaps, channels }`)
and enforced by `test/reference.test.mjs`: every curated provider id must
exist upstream (or sit in that snapshot's `knownGaps` with a reason), and the
suite **fails when a snapshot's `updated` is older than 7 days**.  tvnu's
`CHANNEL_ID_MAP` is the `CHANNELS` table's id column — the per-slug map the
test imports.  Refresh weekly:

```bash
npm run update:reference   # re-downloads, re-extracts, stamps today's date
npm test                    # must stay green
```

`scripts/update-reference-ids.js` refreshes **both** snapshots (TR + SE),
preserves each file's `knownGaps`, and reports ids
added/removed upstream plus gaps that upstream now covers (drop those from
`knownGaps`). If upstream renamed an id a provider uses, update the
provider's `CHANNEL_ID_MAP` in the same change. Commit the refreshed
snapshots together with any map updates.

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
- Channel id: uppercase, non-alphanum → `.`, `.tr` suffix for the Turkish
  guides (`.se` for the Swedish tvnu guide), case-sensitive
  exceptions mapped explicitly.  A guide whose reference ids carry a source
  tag (`[SVT1HD].SVT1.HD.se`) keeps the tag verbatim.
- Programme: `start`/`stop` as `YYYYMMDDHHMMSS +0300` for the Turkish guides
  (`+0100`/`+0200` for tvnu, following the Stockholm offset in force at each
  instant), `<title lang="tr">` (`lang="sv"` for tvnu),
  optional `<category lang="tr">` (same language as the title).
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
