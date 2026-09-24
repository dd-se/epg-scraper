# AGENTS.md — Guide for AI coding agents

Read this file before changing the repository. It describes the universal
EPG scraper tool and the rules every patch must follow.

## Product

This repository contains **epg-scraper**, a Node.js CLI tool whose
plain-HTTP scraping and XMLTV processing use built-ins only. It scrapes
TV programme-guide sources through pluggable provider adapters and outputs
**XMLTV** files (optionally gzipped) matching epgshare01's per-country
references (`epg_ripper_TR1.xml.gz` and `epg_ripper_SE1.xml.gz`).

The product is a build-time CLI tool and library, not a Tizen app or web UI.
Development tooling includes a static file server in
`scripts/scraper-server.js`; it is not required for scraping.

## Non-negotiable constraints

- **Node ≥ 24.** The plain-HTTP tool uses built-in `fetch`, `node:zlib`,
  `node:stream`, and `node:util` (including `parseEnv()`, which backs the
  optional `.env` loader). Do not add runtime dependencies beyond
  Playwright, which is used only for browser functionality.
- **Local credentials.** A provider that needs secrets reads them from the
  environment (never from a committed file). The CLI additionally loads
  `<cwd>/.env` — or the file named by `--dotenv <path>`, **not** `--env-file`:
  Node parses `--env-file` anywhere in argv, even after the script path, so it
  never reaches the CLI parser (`node --env-file=<path> bin/epg-scraper.js`
  works and wins, being applied before the script) — through
  `src/env-file.js`; names already present in the environment always win, so
  CI secrets are never overridden, and only the number of applied variables
  is logged, never a value. `.env` is gitignored (the tracked `.env.example`
  carries the names as empty placeholders).
- **ES modules only.** The project uses `"type": "module"`. All source files
  are `.js` with `import`/`export`. Test files are `.mjs`.
- **No eval.** Provider adapters must parse scraped HTML with regexes or
  string operations over known markup. Never `eval` or `Function()` scraped
  content.
- **No network in tests.** All test suites run against fixtures in
  `test/fixtures/` and stubbed `fetchImpl` — never against live sites.
  Browser tests mock `playwright` via `vi.mock()`. Live scraping is a
  manual step (`npm run scrape`).
- **Runtime dependencies.** Playwright is currently a regular dependency
  in `package.json` (not an npm optional dependency). Browser functionality
  is optional: Playwright is dynamically imported for browser mode,
  browser-required providers, or HTTP-vs-browser comparison. Plain-HTTP
  scraping does not need it. Missing Playwright produces a clear error
  when browser functionality is requested.
- **Politeness.** Provider adapters use sequential page fetches with a
  configurable delay, a browser-like User-Agent, and bounded retries.
  No telemetry, no hidden endpoints.
- **Honest errors.** Malformed or unavailable remote data degrades to an
  empty/warned result — never a crash of the CLI.
- **Fixed-offset timestamps.** Programme `start`/`stop` are ISO 8601
  strings with one fixed UTC offset (Turkey: `+03:00` year-round; İdman TV
  — Baku — is `+04:00` year-round, since Azerbaijan abolished DST in 2016).
  Providers must never emit fractional seconds or bare UTC offsets.
  A provider whose country observes DST (`tvnu` — Sweden) instead stamps
  each timestamp with the offset in force at that instant (`+01:00` winter,
  `+02:00` summer), because a pinned offset would shift every summer
  programme by an hour; the instants stay absolute either way.  Guides may
  therefore legitimately carry two offsets across a DST switch, which is why
  the writer and the reader compare `start`/`stop` as **instants**
  (`isoToEpochMs()`) rather than as ISO strings.  (Merge/compare only key
  slots on the literal strings — they never order by time.)
- **Hostile-input hardening.** Source wall times pass through
  `parseClockMinutes()` and `wallToInstant()` (`src/time.js`): `24:00`
  is accepted only as an explicit end-of-day boundary, while `24:30`,
  larger offsets, negative minutes, month 13, Feb 30, and day 32 are
  rejected before conversion. Every provider returns through
  `finishResult()` / `createGuideResult()` (`src/model.js`), which drops
  null/hostile channels and programmes, unknown channel references,
  non-canonical or reversed instants, invalid metadata, and exact duplicates
  while preserving every valid partial guide. `generateXmltv()` repeats the
  invariant strictly through `validateGuideResult()` and remains the final
  defense when a caller bypasses the provider seam.

## Runtime map

`bin/epg-scraper.js` is a thin wrapper that calls `runCli()` from
`src/cli.js`. The module tree:

1. `src/http.js` — `fetchText()` (GET) and `fetchResponseWithRetry()`
   (POST or session GET) with UA, hard timeout covering body consumption,
   bounded retries with backoff, and abort control. The latter returns a
   buffered Response-like object so headers and body come from the same
   successful attempt. `createPoliteFetch()` spaces every provider request,
   including retries and session setup; `DEFAULT_UA` and `sleep` are shared
   by browser and provider adapters.  Request descriptions and non-2xx
   transport errors pass URLs through `redactUrl()`, which masks sensitive
   query values (`api_key`, `app_id`, `token`, …) and userinfo before they can
   reach a log line or an error message.
2. `src/browser.js` — `createBrowserFetcher()` lazy-loads Playwright, launches
   headless Chromium, returns a `fetchImpl`-compatible function that renders
   pages and returns HTML.  Also exports `isPlaywrightAvailable()`.  With
   `stealth: true` (CLI `--stealth`) it masks headless fingerprints
   (`--disable-blink-features=AutomationControlled`, `navigator.webdriver` /
   plugins / `window.chrome` via an init script, `Sec-CH-UA*` client hints,
   `tr-TR` locale/timezone) and simulates human interaction (incremental
   scrolling to load lazy content, small mouse movements) before snapshotting
   the DOM. This adapter renders GET pages only; provider registrations that
   POST JSON/forms or speak a JSON API declare `browserCompatible: false`, and
   the CLI rejects an incompatible browser run before any scrape starts.
3. `src/entities.js` — HTML entity/numeric-reference decoder.
4. `src/slug.js` — Generic channel-id slug (uppercase, non-alphanum → `.`,
   country suffix — `.tr` default, `.se` for the Swedish provider).
5. `src/model.js` — tolerant `createGuideResult()` used by providers,
   comparison, merge, and the XMLTV reader; strict
   `validateGuideResult()` used by the writer.
6. `src/time.js` — source wall-clock validation/conversion, canonical guide
   instant parsing/order, and XMLTV timestamp conversion.
7. `src/registry.js` — Provider registry (`registerProvider`/`getProvider`/`listProviders`)
   and `buildDateRange()` date helper.
8. `src/provider-catalog.js` — one authored inventory for registrations,
   effective country/language/time-zone metadata, reference coverage, daily
   CI membership/arguments, and live/CI sports profiles.
9. `src/xmltv.js` — XMLTV document writer (`generateXmltv` → string, `writeXmltv` → file),
   XML escaping, plus the reader (`parseXmltv` ← string, `readXmltvFile` ←
   `.xml`/`.xml.gz`) so already-scraped guides can be reused without live
   servers. Timestamp functions are re-exported from `src/time.js`.
10. `src/providers/` — Provider adapters (shared plumbing — wallToIso,
    weekDays, weekdayIndex, normalizeChannelKey, defaultDates, finishResult —
    lives in `src/providers/shared.js`; wallToIso/weekDays are re-exported
    from hurriyet.js for compatibility):
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
    - `sporekraniapi.js` — Spor Ekranı API: tabii spor 1-8 and S Sport Plus via
      one authenticated `GET https://api.sporekrani.com/v3/events?day=...` per
      requested date. Credentials come only from `SPOREKRANI_API_APP_ID` and
      `SPOREKRANI_API_KEY`; never commit them. `parseApiEnvelope()` /
      `parseDayEvents()` are pure parsers. Every exact curated owner in an
      event's `channels[]` receives the slot. The source has start times only,
      so the adapter chains to the next start on the same channel inside that
      response and ends the final start at midnight; it never chains across
      days. This is the active daily-CI sports source. **Not browser-compatible**
      (JSON API, not rendered HTML). `scrape()` accepts an optional `env`
      (default `process.env`) so tests can inject credentials, and per-day
      warnings summarize a failed request as `HTTP <status>` only —
      credential-bearing URLs never reach the log.
    - `sporekrani.js` — retained Spor Ekranı SSR benchmark baseline: tabii spor
      1-8 and S Sport Plus via `sporekrani.com/home/channel/{slug}`. Quasar SSR
      embeds a rolling ~30-day list in `window.__INITIAL_STATE__`; one fetch per
      channel. Stops chain across the rolling list. It remains registered for
      provider-to-provider benchmarking but is excluded from CI because sparse
      lists can extend a programme for days.
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
      cross-channel note to the last Sunday slots). Baku is UTC+4 year-round
      in 2026 — Azerbaijan abolished DST in 2016 (tzdb `Asia/Baku`), so the
      provider stamps Baku wall times with the fixed `+04:00` (`BAKU_ISO_
      OFFSET`), and its catalog time zone is `Asia/Baku` for the default
      date window. This keeps emitted instants equal to the source's. The XMLTV
      writer/reader compare start/stop as instants, so a merged guide carrying
      both `+03:00` and `+04:00` timestamps stays correct.
    - `tvnu.js` — TV.nu Yayın Akışı (Sweden): 69 Swedish national + Nordic
      pay-TV channels, including TV4 Fotboll/Hockey/Motor/Sportkanalen/Tennis
      and Sport Live 1–4, the Viaplay/V Sport block (V Sport
      1/Extra/Premium/Golf/Motor/Vinter, Fight Sports, V Sport Live 1–5,
      Viaplay Sport) and Eurosport 1–2, via
      `www.tv.nu/kanal/{slug}?datum=YYYY-MM-DD`. Each
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
   - `index.js` — `loadProviders()` registry loader derived from the catalog.
11. `src/env-file.js` — optional `.env` loading for local live runs:
    `readEnvFile(path)` (missing file → `undefined`, unreadable → readable
    error) and `applyEnv(entries)` (never overwrites an existing variable;
    returns the applied names). Parsing is Node's own `node:util` `parseEnv()`,
    so the format matches `node --env-file`. The CLI calls it before any
    provider reads the environment.
12. `src/cli.js` — CLI argument parsing, orchestration, output writing.
    Exports `runCli({ argv, stdout, stderr, cwd, providerLoader })` for
    testability. One execution lifecycle owns browser creation, scrape option
    construction, result acceptance, error conversion, and browser shutdown;
    the single, compare, merge, and offline mode handlers keep their distinct
    behavior behind that seam. Provider metadata comes from
    `src/provider-catalog.js`.
13. `src/compare.js` — diffs two scrape() results.  `compareResults()` (same
    provider, plain HTTP vs headless browser) and `compareProviderResults()`
    (two providers, channel by channel) share one `compareSides()` core;
    `renderCompareReport()` / `renderProviderCompareReport()` turn the
    reports into text lines.

Sports coverage: `tvplus` + `beinsports` + `digiturkburada` + `sporekraniapi` +
`tivibu` + `idmantv` merged (`--provider tvplus,beinsports,digiturkburada,
sporekraniapi,tivibu,idmantv --merge`) cover 38 of the 50 sports channels; the
rest are tracked in `UNSUCCESSFUL.md`. The daily CI merge skips
`beinsports` (its 1-4 feeds are covered by `digiturkburada`, which keeps
full-day schedules) and the rolling SSR `sporekrani` baseline (the day-scoped
`sporekraniapi` adapter matches starts and bounds final stops at midnight).
`sporekraniapi` adds the tabii spor 1-8 simulcast feeds and S Sport Plus;
`tivibu` adds Tivibu Spor 1-4; `idmantv` adds İdman TV (an Azerbaijani
charter, not in the epgshare01 reference).
Exxen stays login-walled and the rest are platform-exclusive feeds.
14. `src/merge.js` — `mergeResults(results, canonicalize?)` combines N
    providers into one guide: channels unioned by (canonical) id (first
    provider's name wins; missing icon/url backfilled from later
    providers), programmes
    unioned + deduped, conflicting slots resolved first-provider-wins (the
    order in `--provider a,b,c` sets the precedence).
15. `src/aliases.js` — optional channel-id alias map: `loadAliasMap(path)`
    reads/validates the JSON file, `createCanonicalizer(map)` returns an
    id → canonical-id function that compare and merge apply so ids that
    differ between providers line up.  Resolution is transitive (alias
    chains collapse onto one id) and cycle-safe.

Script load order is not critical (ES modules resolve automatically), but
the dependency chain flows upward: providers → catalog/registry/http/xmltv/model/time/slug → env-file → cli.

## CLI modes

`--provider` accepts a comma-separated list; the mode is selected by flags:

- **Single (default)** — one provider, one guide
  (`epg_<id>_<COUNTRY>.xml[.gz]`; `TR` by default, `SE` for tvnu).
  `--browser` forces browser rendering; `--stealth` adds anti-bot
  fingerprint masking + scroll/mouse simulation to browser mode.
- **Compare (`--compare`)** — with one provider, compares plain HTTP with
  headless Chromium (requires Playwright + Chromium), writing
  `epg_<id>_<COUNTRY>.http.xml[.gz]` and
  `epg_<id>_<COUNTRY>.browser.xml[.gz]`. With two (`--provider a,b`), compares
  the providers' guides channel by channel and writes
  `epg_compare.<id>.xml[.gz]` for each. Two-provider comparison needs a
  browser only with `--browser` or a browser-required provider. `--out`
  overrides the base used to derive comparison filenames.
- **Merge (`--merge`)** — scrapes every listed provider and writes ONE guide
  (`epg_merged_<COUNTRY>.xml[.gz]`); country and language follow the first
  provider. The first provider wins conflicts, later ones fill the gaps.
  With `--from a.xml.gz,b.xml.gz`, no server is hit: already-scraped guides
  are merged offline (file order sets precedence). The reader preserves the
  first valid input guide language, so Swedish files stay `lang="sv"`;
  country still defaults to `_TR` because XMLTV filenames do not carry it.
  CI uses offline merge to avoid scraping the sports providers twice.
- **Aliases (`--alias-map <path>`)** — JSON `{ aliasId: canonicalId }`
  canonicalizes channel ids in compare and merge (e.g. mynet's `AHABER.tr`
  and hurriyet's `A.HABER.tr` collapse onto one channel).
- **Credentials (`--dotenv <path>`)** — providers that need secrets read
  them from the environment; for local live runs the CLI loads `<cwd>/.env`
  when it exists, or the named file (`--dotenv` names a file that must
  exist). Variables already set in the environment always win, so CI secrets
  are never overridden. The flag is not called `--env-file` because Node
  intercepts that name in argv; Node's own `node --env-file=<path>
  bin/epg-scraper.js` still works and takes precedence over `./.env`. Used for
  live `sporekraniapi` testing without exporting anything by hand.

`--compare` and `--merge` are mutually exclusive; `--compare` supports at
most two providers; multiple providers without either flag is an error.

## Provider contract

Every entry in `src/provider-catalog.js` must supply the following contract
(adapter modules export the parsers, constants and `scrape()` used by that
catalog entry):

```js
{
  id: string,              // unique, used on CLI (--provider <id>)
  name: string,            // human label
  baseUrl: string,         // informational
  requiresBrowser?: boolean, // if true, CLI auto-launches headless Chromium
  browserCompatible?: false, // POST/session/JSON-API sources opt out of browser rendering
  country?: string,        // filename suffix; default TR, tvnu SE
  language?: string,       // output lang attribute; default tr, tvnu sv
  timeZone?: string,       // today anchor; Istanbul default, tvnu Stockholm, idmantv Baku
  scrape({                 // async, returns a canonical guide result
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
    maxChannels,           // optional channel cap where supported (including tvnu)
    env,                   // optional: credential environment for sources that
                             // need secrets (sporekraniapi; default process.env)
  }) => Promise<{ channels, programmes, days, failures, language }>
}
```

Transport failsafes are provided by `src/http.js`, not re-implemented per
provider: `fetchText()` for GET providers, `fetchResponseWithRetry()` for
the JSON/form POST providers. Every request carries a hard timeout that
includes body consumption and is retried on transport errors AND transient
non-2xx responses (5xx/429) with linear backoff. A request that still fails
degrades to a per-page warning; a provider run fails only when it cannot
produce any data. Deterministic statuses (404/410 always; 403 on GET pages)
are never retried. POST 403 remains retryable for the session-based APIs;
TV+ then rebuilds its rotating session once, while Tivibu records the failed
channel-day without another session request. CLI `--days-back`/
`--days-forward` are capped at 60 so a hostile window cannot hang
`buildDateRange()`.

When `requiresBrowser` is true (or `--browser` is passed), `fetchImpl` is
a Playwright-backed function that opens each URL in a headless Chromium tab,
waits for network idle, and returns the rendered HTML.  Provider code that
calls `fetchImpl(url)` works unchanged — the browser layer is transparent.

### Adding a provider

1. Create `src/providers/<id>.js` with:
   - Pure parser function(s) — no I/O, fully fixture-testable. Apply the
     hostile-input hardening rules from the constraints above. Source wall
     times use `parseClockMinutes()`; calendar dates use
     `isRealCalendarDate()`. Absolute epoch-ms sources validate finite values
     inside the supported range and require stop > start. Malformed bodies
     degrade to empty results.
   - `scrape()` — fetches pages, parses, and returns through
     `finishResult()` so every provider crosses the same guide-result seam.
   - `BASE_URL` and a curated `CHANNEL_ID_MAP`. Ids are normalized to the
     epgshare01 reference for the provider's country. A source-tagged
     provider still exports its map because the catalog and reference suite
     consume it.
2. Add one entry to `src/provider-catalog.js`: module, display name,
   effective country/language/time zone, `requiresBrowser` or
   `browserCompatible: false`, reference country, CI membership/arguments,
   and sports-profile membership. `src/providers/index.js` derives the
   registry from this catalog; do not add a second registration list.
3. Add fixtures under `test/fixtures/<id>/`, provider tests, and update
   `test/provider-inventory.test.mjs` when the new operational profile is
   intentional.

## Data flow

```
fetch text ──> pure parser ──> source slots ──> wallToInstant() ──> guide slot
                  │                  │               │
                  │                  │               └─ explicit epoch sources skip wall conversion
                  ▼                  ▼
              scrape() ───────> finishResult() / createGuideResult()
                                    │
                                    ├─ compare or merge as needed
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
npm run inventory           # print the authored provider/CI inventory
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
- CLI tests drive `runCli()` directly with injected `argv`/`stdout`/`stderr`/
  `cwd`/`providerLoader` — no child processes, no live network.
- Use vitest's `beforeEach`/`afterEach` for temp directory setup and
  `globalThis.fetch` restoration. Always restore globals in `finally` blocks.
- Browser tests (`test/browser.test.mjs`) mock `playwright` via `vi.mock()`
  and `vi.resetModules()`. The mock must define `chromium.launch()` returning
  a browser with `newContext()` → `newPage()` → `goto()`/`content()`/`close()`.
  No real browser is launched during `npm test`.
- Coverage by file: `test/core.test.mjs` — units (entities, slug, xmltv,
  registry, guide result, time); `test/provider-inventory.test.mjs` — catalog,
  CI membership, merge profiles, and sports-channel unions;
  `test/hurriyet.test.mjs` — Hürriyet parser, scrape, CLI
  integration; `test/mynet.test.mjs` — Mynet parser, scrape, CLI integration;
  `test/browser.test.mjs` — Playwright fetcher (mocked);
  `test/compare.test.mjs` — http-vs-browser + provider-vs-provider diff
  logic and CLI; `test/merge.test.mjs` — merge logic and CLI;
  `test/idmantv.test.mjs` — iDMAN TV weekly-page parser, scrape, CLI
  integration; `test/tvnu.test.mjs` — TV.nu parser (DST offsets, 06:00 day
  boundary), scrape, CLI integration (`_SE` filename, `lang="sv"`);
  `test/env-file.test.mjs` — `.env` parsing/applying and the CLI's
  `--env-file` wiring, including value precedence and the never-log-values
  rule; `test/sporekraniapi.test.mjs` — Spor Ekranı v3 API parser, scrape,
  and CLI integration;
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
suite **fails when a snapshot's `updated` is older than 7 days**. Provider
membership is derived from `src/provider-catalog.js`; curated ids are read
from each adapter's `CHANNEL_ID_MAP`. Refresh weekly:

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
  guides, bad `--date`, invalid `--max-channels`, missing `--alias-map` file,
  missing `--dotenv` file.
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
  instant; `+0400` for idmantv — Baku year-round), `<title lang="tr">`
  (`lang="sv"` for tvnu), optional `<category lang="tr">` (same language as
  the title).
- Gzip: `node:zlib` level 9, streamed via `pipeline()`.
- Sorting: by channel (codepoint order), then start instant; ISO string
  order breaks ties between equal instants for deterministic output.
- Deduplication: first occurrence per `(channel, start, stop)` wins.

### Adding a new i18n category mapping

If a provider introduces new `data-type` or genre values that need mapping,
add them to the provider's `CATEGORY_MAP` object. Use labels in the guide's
language: Turkish providers emit `<category lang="tr">Label</category>`;
tvnu preserves the source's Swedish genre names with `lang="sv"`. Do not
translate Swedish categories into Turkish.

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
