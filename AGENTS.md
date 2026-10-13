# AGENTS.md — Guide for AI coding agents

Read this file before changing the repository. It describes the universal
EPG scraper tool and the rules every patch must follow.

## Product

This repository contains **epg-scraper**, a Node.js CLI tool whose
plain-HTTP scraping and XMLTV processing use built-ins only. It scrapes
TV programme-guide sources through pluggable provider adapters and outputs
**XMLTV** files (optionally gzipped) with this project's own channel-id
format (`TRTCOCUK.tr` for the Turkish guides, the source-tagged Swedish
spelling for tvnu).

The product is a build-time CLI tool and library, not an app or web UI.
Development tooling includes a static file server in
`scripts/scraper-server.js`; it is not required for scraping.

## Non-negotiable constraints

- **Node ≥ 24.** The plain-HTTP tool uses built-in `fetch`, `node:zlib`,
  `node:stream`, and `node:util` (including `parseEnv()`, which backs the
  optional `.env` loader). Runtime dependencies stay at Playwright, which only
  browser functionality uses.
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
- **Markup parsing.** Provider adapters parse scraped HTML with regexes and
  string operations over known markup: scraped content stays data, and
  `eval`/`Function()` stay out of provider adapters.
- **Offline tests.** Every suite runs offline — fixtures in `test/fixtures/`
  plus a stubbed `fetchImpl`, with `playwright` mocked via `vi.mock()` in the
  browser suite. Live scraping is the manual `npm run scrape` step.
- **Runtime dependencies.** Playwright is a regular dependency in
  `package.json` (not an npm optional dependency) that only browser
  functionality loads: Playwright is dynamically imported for browser mode,
  browser-required providers, or HTTP-vs-browser comparison, so plain-HTTP
  scraping runs without it and a missing install produces a clear error when
  browser functionality is requested.
- **Politeness.** Provider adapters fetch sequentially with a configurable
  delay, a browser-like User-Agent, and bounded retries, and they stay on the
  pages a source publishes for its readers — no telemetry, no hidden
  endpoints.
- **Honest errors.** Remote data that is malformed or unavailable **degrades**:
  a warning, an empty or partial guide, and a non-zero exit only when a run
  could produce nothing at all.
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
  while preserving every valid partial guide.  `generateXmltv()` repeats the
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
4. `src/slug.js` — the channel-id format: `foldChannelId()` (Turkish ids to
   uppercase ASCII with diacritics folded and no separators, `.tr` suffix kept
   verbatim; Swedish ids pass through untouched), `isCanonicalChannelId()` (the
   writer-side check), `channelIdMatchKey()` (the **match key** ids are matched
   through — two ids that differ only in case are one channel; see the
   channel-id format below), and the generic `channelIdFromName()` slug
   (uppercase, non-alphanum → `.`, country suffix) used as the adapters'
   fallback and by the M3U tree's `tvg-id` derivation.
5. `src/model.js` — tolerant `createGuideResult()` used by providers,
   comparison, merge, and the XMLTV reader; it is also the one seam that folds
   channel ids (`foldChannelId()`), so a provider's pre-fold spelling, an alias
   target and a `programme.channel` reference all land on the same emitted id.
   It does **not** rewrite a display name: normalizing the label is the provider
   layer's job (`stripQualityQualifier()` in `src/providers/shared.js`), and this
   seam stores the name exactly as the provider handed it over.
   Strict `validateGuideResult()` used by the writer; it additionally refuses a
   channel id that is not canonical.
6. `src/time.js` — source wall-clock validation/conversion, canonical guide
   instant parsing/order, and XMLTV timestamp conversion.
7. `src/registry.js` — Provider registry (`registerProvider`/`getProvider`/`listProviders`)
   and `buildDateRange()` date helper.
8. `src/provider-catalog.js` — one authored inventory for registrations,
   effective country/language/time-zone metadata, curated channel ids, daily
   CI membership/arguments, and live/CI sports profiles. It also owns
   `COMMAND_PROFILES` (a published merged feed = input guides in precedence
   order + `exclusiveChannels` + output name) and `profileInputFiles()`, which
   resolves a profile to the guide files its inputs are scraped to.
9. `src/xmltv.js` — XMLTV document writer (`generateXmltv` → string, `writeXmltv` → file),
   XML escaping, plus the reader (`parseXmltv` ← string, `readXmltvFile` ←
   `.xml`/`.xml.gz`) so already-scraped guides can be reused without live
   servers. Timestamp functions are re-exported from `src/time.js`.
10. `src/providers/` — Provider adapters, one per catalog entry, plus
    `index.js`, whose `loadProviders()` derives the registry from the catalog.
    Shared plumbing (`wallToIso`, `weekDays`, `weekdayIndex`,
    `normalizeChannelKey`, `defaultDates`, `finishResult`, and
    `stripQualityQualifier()`, which drops a redundant trailing
    `HD`/`FHD`/`UHD`/`SD` from a channel display name at `finishResult()`) lives
    in `src/providers/shared.js`; `wallToIso`/`weekDays` are re-exported from
    `hurriyet.js` for compatibility.
    Per-provider transport, coverage window, curated channel ids and gotchas:
    **`docs/providers.md`** — read the entry for the provider you are changing,
    and add one when you add a provider.
11. `src/env-file.js` — optional `.env` loading for local live runs:
    `readEnvFile(path)` (missing file → `undefined`, unreadable → readable
    error) and `applyEnv(entries)` (never overwrites an existing variable;
    returns the applied names). Parsing is Node's own `node:util` `parseEnv()`,
    so the format matches `node --env-file`. The CLI calls it before any
    provider reads the environment.
12. `src/cli.js` — CLI orchestration, mode dispatch, output writing.
    Exports `runCli({ argv, stdout, stderr, cwd, providerLoader })` for
    testability. One execution lifecycle owns browser creation, scrape option
    construction, result acceptance, error conversion, and browser shutdown;
    the single, compare, merge, and offline mode handlers keep their distinct
    behavior behind that seam. All four modes share the write plumbing
    (`guideOutputPath()` resolves `--out` or the mode's default base name,
    `xmltvExtension()` applies `--gzip`, `isEmptyGuide()` is the shared
    refusal, and `writeGuide()` performs the single `writeXmltv()` call plus
    its log line), and `providerInfo()` memoizes each provider's
    country/language/time zone. `playlistOutputPath()` is the playlist-mode
    counterpart of `xmltvExtension()`: `writeM3U()` takes its path verbatim,
    so the CLI resolves `output.path` + `.gz` (and strips a stale one) to keep
    the logged name and the file on disk in agreement. Flag parsing and
    validation live in `src/cli-flags.js`; provider metadata comes from
    `src/provider-catalog.js`.
13. `src/cli-flags.js` — pure flag parsing and validation, no I/O.
    `deriveFlags()` normalizes the `parseArgs` bag once (provider ids,
    `--from` paths, the window, the date anchor); `FLAG_VALIDATORS` is an
    **ordered** table of `{ when, message }` rows where the first match is the
    error reported, so adding a flag check is one row and reordering one is a
    user-visible change with a test pinning it. `firstFlagViolation()` returns
    that message or null. The integer flags (`--delay-ms`, `--max-channels`,
    and `TRANSPORT_FLAGS`: `--retries`/`--timeout-ms`/`--retry-delay-ms`)
    each declare their own range and complaint beside each other, so a flag's
    bound and its error text cannot drift apart.
14. `src/compare.js` — diffs two scrape() results.  `compareResults()` (same
    provider, plain HTTP vs headless browser) and `compareProviderResults()`
    (two providers, channel by channel) share one `compareSides()` core;
    `renderCompareReport()` / `renderProviderCompareReport()` turn the
    reports into text lines.

15. `src/merge.js` — `mergeResults(results, canonicalize?, options?)` combines N
    providers into one guide: channels unioned by (canonical) id — matched
    case-insensitively through `channelIdMatchKey()` while each entry keeps the
    spelling of the provider that introduced it, so a later provider whose id
    differs only in case fills that channel's gaps instead of opening a second
    one, and its programmes are rewritten onto the surviving spelling (first
    provider's name wins; missing icon/url backfilled from later providers);
    programmes unioned + deduped, conflicting slots resolved first-provider-wins (the
    order in `--provider a,b,c` sets the precedence).
    `{ exclusiveChannels: true }` (CLI `--exclusive-channels`) makes it a
    handover instead of a union: the first provider that lists a channel id
    owns it, and later providers' slots for it are dropped and counted in
    `shadowed` (channels are still unioned, so logos backfill). That is what
    the `hurriyetTrt` profile uses so the TRT channels come only from TRT.
    The published merged feeds are plain `--merge --from` runs (no wrapper
    script): each CI merge job checks which downloaded artifacts survived,
    warns about the rest, and hands the survivors to the CLI in
    `COMMAND_PROFILES` precedence order, which `--from` resolves strictly.
16. `src/m3u/` — the `--m3u` playlist builder: a **standalone** module tree
    with its own result shape, writer and tests. It imports **nothing** from
    `model.js`, `xmltv.js`, `merge.js`, `compare.js`, `providers/` or
    `cli.js` (test-enforced in `test/m3u.test.mjs`); it reuses only
    `fetchText`/`createPoliteFetch`/`redactUrl` from `src/http.js` and
    `channelIdFromName` from `src/slug.js`. Modules:
    - `parser.js` — `parseM3U()` (pure) and `parseAttributes()`. The attribute
      scanner is `indexOf`-anchored and **linear**; the obvious
      `/([A-Za-z0-9_-]+)="([^"]*)"/g` is quadratic on quote-free input (a 100 KB
      junk line measured **11.9 s** — a remote DoS), so it is banned here and
      pinned by a timing regression test.
    - `identity.js` — `foldDiacritics()` (NFKC + uppercase + Turkish-diacritic
      folding to ASCII, shared with the selection matcher), `normalizeName()`
      (adds the alphanumeric collapse), `channelKeys()`, `groupEntries()`
      (union-find), `normalizeStreamUrl()`, `collapseIdenticalFeeds()`,
      `unifyGroupTitles()`, `applyNamingStyle()`, `expandYedek()`,
      `applyMaxCopies()`, `baseDisplayName()`.
    - `selection.js` — `globToMatcher()` (anchored `*`/`?` only, no user
      regex; each literal segment is folded with `foldDiacritics()` so a
      pattern written in its real spelling matches the folded form),
      `selectionForms()`, `selectEntries()`.
    - `writer.js` — `generateM3U()`/`writeM3U()`, mirroring `src/xmltv.js`.
      M3U has no escape syntax, so the writer *removes* a comma from a display
      name (it would re-read as the separator), a quote, and any CR/LF — while
      preserving commas inside attribute values.
    - `collect.js` — `collectEntries()`, `buildM3uReport()`.
    - `liveness.js` — `probeEntries()` (opt-in, manifest-only by default).
    - `config.js` — `loadM3uConfig()`, strict validation + `${ENV_VAR}`.
    - `channels.js` — the curated, data-driven `CHANNEL_CATALOG` that decides
      which channels a run selects, and optionally declares each one's
      `group-title` (Turkish labels that outrank the sources' own), permanent
      `tvg-id`, and display `name` (pinned to the EPG guide's spelling).  Also
      exports `EPG_NAME_CONTRACT` (the three EPG-matching renames) and
      `CATALOG_EPG_GAPS` (channels with no programme data at all, keyed by
      catalog `id` — `TRT 4K`, `Show Türk`, `Show Max`, `TV8 Haber`,
      `Minika Go`, `Baby TV`, `Nickelodeon`, `Flash TV`, `Investigation`,
      `Discovery Channel`, `History`; `TRT Haber` is served by both the `trt`
      and `mynet` guides, so it is not one).  `test/channel-id.test.mjs`
      asserts every catalog `tvg-id` has a curated guide counterpart (folded,
      case-insensitively) unless it is in `CATALOG_EPG_GAPS`, and fails the
      other way on a stale gap — so a new catalog entry cannot ship a channel
      no guide serves.
17. `src/aliases.js` — optional channel-id alias map: `loadAliasMap(path)`
    reads/validates the JSON file, `createCanonicalizer(map)` returns an
    id → canonical-id function that compare and merge apply so ids that
    differ between providers line up.  Resolution is transitive (alias
    chains collapse onto one id) and cycle-safe.  The lookup
    **ignores case** (`channelIdMatchKey()`), because the flag exists for a
    guide that is not ours and need not share our spelling; the canonical
    value is returned verbatim.  It is also an **own**-property check with a
    string target, never `id in map`: an inherited key (`constructor`,
    `toString`, `__proto__`, …) would otherwise resolve a channel id to a
    function/object, which merge rejects as invalid and thereby drops that
    channel and all of its programmes.

The dependency chain flows upward: providers →
catalog/registry/http/xmltv/model/time/slug → env-file → cli.

### Sports coverage

`tvplus` + `beinsports` + `digiturkburada` + `sporekraniapi` + `tivibu` +
`idmantv` merged with `--merge --sports-only` cover **34 distinct sports feeds**:
each provider contributes only its sports subset (`sportsChannelIds()` in the
catalog), because tvplus also curates a general-interest lineup.  The rest —
Exxen stays login-walled, the others are platform-exclusive — are tracked in
`UNSUCCESSFUL.md`.

The daily CI merge skips `beinsports` (its 1-4 feeds are covered by
`digiturkburada`, which keeps full-day schedules) and the rolling SSR
`sporekrani` baseline (the day-scoped `sporekraniapi` adapter matches starts and
bounds final stops at midnight).  `sporekraniapi` adds the tabii spor 1-8
simulcast feeds and S Sport Plus; `tivibu` adds Tivibu Spor and Tivibu Spor 1-4; `idmantv` adds
İdman TV (an Azerbaijani charter).

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
  `--exclusive-channels` makes it a handover instead of a union: the first
  provider that lists a channel owns it and later providers contribute nothing
  for it (the TRT-first merged feed uses this).
  With `--from a.xml.gz,b.xml.gz`, no server is hit: already-scraped guides
  are merged offline (file order sets precedence). The reader preserves the
  first valid input guide language, so Swedish files stay `lang="sv"`;
  country still defaults to `_TR` because XMLTV filenames do not carry it.
  CI uses offline merge to avoid scraping the sports providers twice.
- **Aliases (`--alias-map <path>`)** — JSON `{ aliasId: canonicalId }`
  canonicalizes channel ids in compare and merge; keys are matched
  case-insensitively, since a third-party guide's spelling is not ours.  No
  shipped guide uses it:
  every channel two providers share is curated to one id on both sides
  (`test/channel-id.test.mjs` fails otherwise), so the flag is for reconciling a
  third-party guide with ours, not for fixing our own providers.
- **Credentials (`--dotenv <path>`)** — for local live runs the CLI loads
  `<cwd>/.env`, or the named file (which must exist); precedence and the
  `--env-file` naming trap are in *Local credentials* above. Used for live
  `sporekraniapi` testing without exporting anything by hand.

- **Playlist (`--m3u <config.json>`)** — a separate capability with its own
  result type (`{ entries, failures, sources, stats }`), reached through its own
  flag and never mixed with a guide flag. It gathers channel entries from
  several M3U sources, keeps only the requested channels, groups the same
  channel across sources, renames the extra copies and writes one playlist
  (`playlist.m3u`, gzip off). The requested channels come from the curated,
  **data-driven** `CHANNEL_CATALOG` in `src/m3u/channels.js` (the config's
  `want` and `--m3u-want` append to it; `"catalog": false` disables it),
  mirroring how the EPG side keeps its curated channel ids in each adapter's
  `CHANNEL_ID_MAP`. It never enters the browser lifecycle and imports nothing
  from the guide pipeline.

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
are never retried. POST 403 remains retryable for the session-based APIs, and
each session provider's own recovery is described in `docs/providers.md`.
CLI `--days-back`/
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
   - `BASE_URL` and a curated `CHANNEL_ID_MAP`, whose values are authored in
     **final form** (see the channel-id rule above): Turkish ids uppercase
     ASCII with diacritics folded and no separators (`TRTCOCUK.tr`); a provider whose
     ids are exempt from the rule (tvnu) exports its map verbatim. Every
     provider exports its map because the catalog consumes it.
2. Add one entry to `src/provider-catalog.js`: module, display name,
   effective country/language/time zone, `requiresBrowser` or
   `browserCompatible: false`, CI membership/arguments,
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
npm test                    # the whole suite (the completion criterion below)
npm run inventory           # the authored provider/CI inventory
npm run scrape              # live scrape (hurriyet, 7 days)
npm run merge:sports          # offline merge -> epg_sports_merged_TR.xml.gz
npm run merge:hurriyet-trt    # offline merge -> epg_hurriyet_trt_merged_TR.xml.gz
node scripts/build-release-notes.js --guides guide --date YYYY-MM-DD  # release body
npm run install:playwright  # Chromium binary, needed only for --browser mode
npm run check:browser       # exit 0 = Playwright ready
```

`node bin/epg-scraper.js --help` and `--list-providers` describe the CLI itself.

### Test conventions

- Test files: `test/**/*.test.mjs` (vitest, node environment).
- The `fetchImpl` stub must return Response-like objects:
  `{ ok: true, status: 200, text: async () => html }`. Returning raw
  HTML strings will cause `fetchText` to throw `HTTP undefined`.
- CLI tests drive `runCli()` directly with injected `argv`/`stdout`/`stderr`/
  `cwd`/`providerLoader`, never a child process.
- Use vitest's `beforeEach`/`afterEach` for temp directory setup and
  `globalThis.fetch` restoration. Always restore globals in `finally` blocks.
- Browser tests (`test/browser.test.mjs`) mock `playwright` via `vi.mock()`
  and `vi.resetModules()`. The mock must define `chromium.launch()` returning
  a browser with `newContext()` → `newPage()` → `goto()`/`content()`/`close()`.
- Coverage by file: `test/cli-flags.test.mjs` — the CLI flag table: each rule's
  message, the numeric flags' bounds, and the *order* of the rules (adjacent
  rows are pinned against each other so a reorder fails a test);
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
  `test/m3u.test.mjs` — the `--m3u` playlist builder: the isolation guard,
  the parser (fixtures + a 24-case adversarial table + ReDoS/scale timing
  bounds), identity/grouping/naming/selection/Yedek, the writer's format and
  sanitization rules, source collection, config validation, liveness probing,
  and `runCli()` integration; `test/fixtures/m3u/` holds the two trimmed
  reference playlists.
  `test/channel-id.test.mjs` — the channel-id format itself (folding rule,
  idempotence, Swedish passthrough, the model seam, the writer's refusal, and
  the catalog-wide shape + no-collision checks — see below);
  `test/release-notes.test.mjs` — the release-note builder (one section
  per provider *and* per merged guide, each resolved from its
  `COMMAND_PROFILES` entry).

### Channel-id format (the curated maps are the database)

There is no upstream id list any more: channel ids are **curated here** and
enforced by `test/channel-id.test.mjs`.

- Turkish (`.tr`) ids: **uppercase ASCII**, every Turkish diacritic folded to
  its Latin letter, **no separators** (`BEINSPORTS1.tr`, `SSPORT1.tr`), and the
  `.tr` suffix — the suffix's dot is the only dot in the id.  `foldChannelId()`
  upper-cases, so the rule holds for every id that crosses the seam, curated
  map or not, and it is idempotent, so applying it at any seam is safe.  An
  `HD`/`TRHD` qualifier is never part of the identity (`EUROSPORT1.tr`, not
  `EUROSPORT1HD.tr`), not even for a station available *only* in HD
  (`TRTAVAZ.tr`).  An id names the channel's **current** name, so a rebrand
  is a rename: `NOWTV.tr`, not the dead `FOX.tr`.
- Swedish (`.se`) ids: **exempt**. tvnu keeps its source-tagged upstream
  spelling (`[SVT1HD].SVT1.HD.se`, `[COMSVHD].SVTB/SVT24.HD.se`) verbatim.
- **Casing decides spelling, not identity.**  A Turkish id is upper-cased by
  the seam and a Swedish one is written verbatim, so two guides can spell one
  channel differently; everything that *joins* ids — the alias map, compare,
  merge — therefore matches on the **match key** (`channelIdMatchKey()`)
  instead of the literal string, and a guide keeps the spelling it first
  received.  (Curated ids are not aligned to any playlist's casing for this
  reason.)
- One seam, not per-provider calls: `createGuideResult()` folds ids, so
  providers only have to author `CHANNEL_ID_MAP` values in final form; the
  generic-slug fallback is folded by the same seam (and, in hurriyet/mynet,
  inside `mapChannelId()` so a direct caller sees the final spelling too).
- `validateGuideResult()` throws on a non-canonical id, so the writer is the
  last line of defense when a caller bypasses the seam.
- The M3U tree keeps its own lowercase `tvg-id` namespace
  (`trt1.tr`, `cnnturk.tr`); it is deliberately not aligned with the guide ids.

The suite proves, over every curated id in `src/provider-catalog.js`
(`curatedChannelIds()`), that each one is canonical and that **no two of them
fold onto the same match key** — the one failure mode a rename can introduce now
that matching ignores case.  A new provider therefore means: author its
`CHANNEL_ID_MAP` in final form and let `npm test` prove it.

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

The XMLTV output is standard XMLTV plus this project's channel-id format:
- Channel id: uppercase ASCII with Turkish diacritics folded, no separators,
  `.tr` suffix for the Turkish guides. Swedish (`.se`) ids keep their source tag
  and their casing verbatim (`[SVT1HD].SVT1.HD.se`). See "Channel-id format"
  above.
- Channel `<display-name>`: the source's own label with a redundant trailing
  quality qualifier removed (`A NEWS HD` → `A NEWS`), by
  `stripQualityQualifier()` in the provider layer (`src/providers/shared.js`,
  applied by every adapter through `finishResult()`).  `src/model.js` never
  rewrites a name, so the providers are the only place this happens.
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
tvnu preserves the source's Swedish genre names with `lang="sv"`, so a
category always reads in the guide's own language.

## Commit best practices

- Use Conventional Commits in the repo's existing style: `feat:`, `fix:`,
  `refactor:`, `test:`, `docs:`, `chore:`.  Subject in imperative mood,
  1-2 sentences, focused on the *why*; use the body for details that will
  matter later.
- One logical change per commit.  Inspect `git status` and `git diff`
  first; stage only the files that belong to the change.
- Commit source, tests, docs and fixtures. Secrets/API keys, scratch files
  and scraper output (`epg_*.xml`, `epg_*.xml.gz`, `playlist.m3u`,
  `m3u-report.json` — all gitignored) stay out of history. `playlist.m3u` has
  no snapshot to keep: the `m3u-scraper` workflow rebuilds and publishes it as
  a release asset, and a local review regenerates it with
  `node bin/epg-scraper.js --m3u m3u.config.json --m3u-out playlist.m3u
  --m3u-report m3u-report.json`.
- Only commit lockfile changes when dependencies actually changed.
- An agent session stops at the commit: pushing, deploying and releasing wait
  for an explicit ask.

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
  5. Verify XMLTV output still matches the documented output shape
     (see "When changing output shape").
- Tag releases after the version-bump commit with an annotated tag
  (`git tag -a vX.Y.Z -m "..."`); push the tag with the release.
- This package is `"private": true`, so a release is a version bump plus a
  changelog entry and a git tag — `npm publish` has no part in it.

## Documentation

When behaviour changes, update the docs it reaches, in the same change:

- `README.md` — CLI usage, flags and mode walkthroughs: what a user runs and
  what lands on disk.
- `AGENTS.md` — the rules a patch must follow (this file).
- `docs/providers.md` — the entry for each provider whose behaviour changed.
- `CONTEXT.md` — the domain vocabulary; add a term when a concept gets a name.
- `UNSUCCESSFUL.md` — channels with no working source yet; update it when
  coverage lands or a source is re-verified.
- `CHANGELOG.md` — the release entry for anything a consumer can observe.
- Inline JSDoc/comments — API contracts.
