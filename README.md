# epg-scraper

Universal EPG (electronic programme guide) scraper. Provider adapters scrape
different TV-guide sources; the pipeline normalizes them into one internal
model and writes **XMLTV** files matching the shape of epgshare01's
reference guides (`epg_ripper_TR1.xml.gz` for the Turkish providers,
`epg_ripper_SE1.xml.gz` for the Swedish `tvnu` provider), optionally gzipped.

```
source site ──> provider adapter ──> internal model ──> XMLTV writer ──> epg_<provider>_<COUNTRY>.xml.gz
                (src/providers/)     (src/model.js)      (src/xmltv.js)   (TR unless the provider declares otherwise — tvnu writes _SE)
```

Plain-HTTP scraping and XMLTV processing use Node built-ins only (Node ≥ 24).
Browser mode is optional, but Playwright is currently a regular dependency
in `package.json` and is installed by `npm install`. Vitest and saxes are dev
dependencies; Chromium installation is a separate browser-mode setup step.

## Usage

```bash
npm install                  # package dependencies, including Playwright and test tools
npm run scrape               # hurriyet provider, epg_hurriyet_TR.xml.gz
npm run scrape:gz            # same (gzip is the default)
npm run inventory           # print provider, CI, and merge inventory
node bin/epg-scraper.js --list-providers
node bin/epg-scraper.js --provider hurriyet --no-gzip --out out/guide.xml
node bin/epg-scraper.js --provider hurriyet --date 2026-09-14   # anchor week
npm test
```

Options: `--provider`, `--out`, `--gzip/--no-gzip`, `--date YYYY-MM-DD`,
`--days-back N`, `--days-forward N` (both 0–60), `--delay-ms N`,
`--max-channels N`, `--retries N`,
`--timeout-ms N`, `--retry-delay-ms N`, `--browser`, `--stealth`, `--compare`,
`--merge`, `--from <files>`, `--alias-map <path>`, `--dotenv <path>`,
`--quiet`, `--list-providers`.

Providers that need secrets read them from the environment. For local live
runs the CLI also loads `./.env` (or the file named by `--dotenv`); real
environment variables always win, so CI secrets are never overridden. The
flag is `--dotenv` because Node itself intercepts `--env-file` anywhere in
argv — for that file, use Node's own flag before the script:
`node --env-file=.env.local bin/epg-scraper.js …`.

```bash
cp .env.example .env      # then fill in SPOREKRANI_API_APP_ID / _API_KEY
node bin/epg-scraper.js --provider sporekraniapi --date 2026-09-30
```

`--delay-ms` overrides the per-request politeness delay (ms between page
fetches; defaults: hurriyet 250, mynet 500, tvplus 400, beinsports 300,
digiturkburada 400, sporekrani 500, sporekraniapi 300, tivibu 400, tvnu 400 —
mynet fetches ~90 channel pages per day and tvnu one page per channel **and
day**, so keep this polite).

The default output name carries the provider's own country: `_TR` for the
Turkish providers (the default) and `_SE` for `tvnu`, e.g.
`epg_tvnu_SE.xml.gz`.  A provider may also declare the language of its guide
(`tvnu` writes `lang="sv"` instead of `lang="tr"`) and the time zone that
decides what "today" means for the default window (`tvnu` anchors on
Stockholm and `idmantv` on Baku, so a late-evening run in another zone
still means today in the guide's country).

Transport failsafes are tunable: `--retries N` sets the retry attempts per
request after the first (defaults: 2 for plain-HTTP page GETs, 1 for the
JSON/form API POSTs), `--timeout-ms N` the per-request hard timeout
(default 20000, including response-body consumption), and
`--retry-delay-ms N` the base backoff between attempts (default 400,
scaled linearly per attempt). Transient failures (HTTP 5xx/429, network
errors, timeouts, body-read failures) are retried. Deterministic statuses
fail on the first attempt: 404/410 and 403 on GET requests. Session API POST
403 remains retryable; TV+ rebuilds its session once after exhaustion, while
Tivibu records the failed channel-day. Raise `--retries` for unreliable
links, or lower `--timeout-ms` to fail fast on dead hosts. Request
descriptions and non-2xx error messages pass URLs through `redactUrl()`, which
masks sensitive query values (`app_id`, `api_key`, `token`, …) and userinfo, so
a credential-bearing URL cannot leak into output or CI logs.

The Turkish/Azerbaijani sports guide uses `tvplus`, `beinsports`,
`digiturkburada`, `sporekraniapi`, `tivibu`, and `idmantv` (38 channels together).
Separately, `tvnu` covers nine Swedish TV4 sports feeds. See the dedicated
sections below and `UNSUCCESSFUL.md` for channels still lacking a usable source.

## Browser mode

Some TV-guide sites render their schedule grids with client-side JavaScript
(React, Vue, infinite scroll, etc.) and cannot be scraped with plain HTTP
fetches.  The `--browser` flag (or `requiresBrowser: true` on the provider)
launches a headless Chromium via [Playwright](https://playwright.dev/) to
render pages before parsing.

### Setup

```bash
# Install the npm package + Chromium browser binary
npm install playwright
npm run install:playwright      # shortcut: npx playwright install chromium

# Verify everything is in place
npm run check:browser           # exits 0 if ready, 1 if not
```

The Chromium binary is downloaded once into Playwright's cache directory
(~/.cache/ms-playwright by default).  On CI or Docker you may need
system libraries (`libnss3`, `libatk-bridge2.0-0`, `libasound2`, etc.) —
see [Playwright system requirements](https://playwright.dev/docs/intro#system-requirements).

### Usage

```bash
# Force browser mode for any provider
node bin/epg-scraper.js --provider my-provider --browser

# Providers with requiresBrowser: true auto-launch the browser
node bin/epg-scraper.js --provider my-provider
```

How it works:
1. `src/browser.js` lazy-loads Playwright and launches a shared Chromium
   browser with a single context.
2. Each page is opened in a new tab, navigated to the URL, and rendered
   with `waitUntil: 'networkidle'`.  Images, stylesheets, fonts, and media
   are blocked to keep scraping fast.
3. The rendered HTML is returned as a Response-like object compatible with
   `fetchText()` — provider code needs no changes.
4. The browser is torn down in a `finally` block when scraping completes.

### Stealth

Some sites serve different (or empty) content to headless browsers, or block
them outright.  `--stealth` makes the headless session harder to fingerprint
as automated (use it with `--browser`, `--compare`, or `--merge`):

```bash
node bin/epg-scraper.js --provider my-provider --browser --stealth
node bin/epg-scraper.js --provider hurriyet,mynet --compare --stealth
```

What it does:
- **Automation flag:** `--disable-blink-features=AutomationControlled` plus an
  init script that masks `navigator.webdriver`.
- **Extensions/plugins:** fakes `window.chrome`, `navigator.plugins` and
  `navigator.mimeTypes` (Chrome PDF viewer, Native Client) so plugin probes
  don't come back empty.
- **Client hints:** sends a matching `Sec-CH-UA*` header family derived from
  the configured User-Agent.
- **Locale/timezone:** `tr-TR` locale, `Europe/Istanbul` timezone, matching
  `navigator.languages` / `hardwareConcurrency` / `deviceMemory`.
- **Human interaction:** after each page loads, scrolls down in steps (to
  trigger lazy-loaded / infinite-scroll content), wanders the mouse a little,
  then settles back at the top before the DOM is snapshotted.  Adds ~1-2s
  per page.

Stealth is opt-in — plain browser mode keeps the current fast behavior.

## Compare mode (HTTP vs browser)

Useful when a provider *can* be scraped with plain HTTP but you want to see
whether a headless browser would change the result — JS-only channels,
lazy-loaded rows, differently-rendered titles, and so on.  `--compare` runs
the provider **twice** (plain HTTP, then headless Chromium) and reports what
differs:

```bash
node bin/epg-scraper.js --provider hurriyet --compare
```

- Both runs scrape the same date window with the same options (e.g.
  `--max-channels`), sequentially, tagged `http:` / `browser:` in the log.
- The summary shows channel/programme counts per side, how many slots matched
exactly, and samples of the differences: the same time slot with a different
title/category (`[changed]`), or programmes/channels present on only one side
(`[only http]` / `[only browser]`).  Differences do **not** fail the run —
the mode is diagnostic.
- Two guides are written so you can diff them:
  `epg_<provider>_<COUNTRY>.http.xml[.gz]` and `epg_<provider>_<COUNTRY>.browser.xml[.gz]`
  (`<COUNTRY>` is the provider's own — `TR` unless it declares otherwise,
  e.g. tvnu writes `epg_tvnu_SE.http.xml.gz`)
  (or derived from `--out`, e.g. `--out guide.xml` → `guide.http.xml` +
  `guide.browser.xml`).
- Requires Playwright + Chromium (see Browser mode setup); `--compare`
  ignores `--browser` and always runs both modes.  Exits 1 if the browser
  cannot be launched or both sides produce nothing.

### Provider vs provider

With **two** providers, `--compare` diffs the two guides instead — e.g. does
hurriyet's ATV schedule match mynet's ATV schedule?

```bash
node bin/epg-scraper.js --provider hurriyet,mynet --compare
```

- Each provider runs in its natural mode (`requiresBrowser` / `--browser`),
  sharing a single headless Chromium when any of them needs it.
- The report shows overall counts, then a **per-channel breakdown**: for
  every channel id, whether it exists on both sides and how many slots
  matched / changed / are missing on each side.  Channels present on only
  one side are listed too.
- Sample differences (`[changed]`, `[only <provider>]`) show the first few
  mismatches, capped at 10 per run.
- Both guides are written for manual diffing: `epg_compare.<provider>.xml[.gz]`
  (or derived from `--out`, e.g. `--out cmp.xml` → `cmp.hurriyet.xml` +
  `cmp.mynet.xml`).

## Merge mode (multiple providers)

Different sources cover different channels and date windows (e.g. hurriyet
publishes a full Mon–Sun week, mynet only today + 2 days).  `--merge` scrapes
**every listed provider** and combines the results into **one** complete
XMLTV file:

```bash
node bin/epg-scraper.js --provider hurriyet,mynet --merge
```

- `--provider` accepts a comma-separated list; `--merge` unions the results.
  Multiple providers without `--merge` is an error.
- **Channels** are unioned by XMLTV channel id (the first provider's
  name wins; a missing icon/url is backfilled from later providers so merged
  guides keep TV logos even when the primary source lacks them).  **Programmes** are unioned and exact duplicates
  `(channel, start, stop, title)` removed.
- Conflicting slots (same channel + time range, different title) keep the
  **first** provider's version — the order in `--provider a,b,c` sets the
  precedence, so list the most authoritative source first and let later
  providers fill the gaps.
- Each provider runs with its own `requiresBrowser` / `--browser` handling,
  sharing a single headless Chromium when any of them needs it.
- One file is written: `epg_merged_<COUNTRY>.xml[.gz]` (or `--out path`),
  where `<COUNTRY>` follows the first (lead) provider — `TR` unless it
  declares otherwise, e.g. a tvnu-led merge writes `epg_merged_SE.xml.gz`.
  Offline `--merge --from` has no providers, so it keeps `epg_merged_TR`.
  `--compare` and `--merge` cannot be combined; `--compare` supports at most
  two providers.

```bash
# Scrape everything both sources have, hurriyet winning conflicts
node bin/epg-scraper.js --provider hurriyet,mynet --merge --out out/guide.xml.gz
```

### Offline merge (reuse scraped guides, zero live hits)

`--merge --from` merges **already-scraped XMLTV files** instead of scraping —
no server is contacted at all. File order sets the precedence (first file
wins conflicts), mirroring `--provider` order for live scrapes:

```bash
node bin/epg-scraper.js --merge --from guides/epg_a_TR.xml.gz,guides/epg_b_TR.xml.gz --out out/guide.xml.gz
```

- Accepts plain `.xml` and gzipped `.xml.gz` (detected by extension).
- `--provider` is ignored when `--from` is given; `--alias-map` still
  applies, so aliased channel ids collapse across files.
- The first valid input language is preserved, so an offline merge of
  Swedish guides keeps `lang="sv"`. Country is not encoded in XMLTV, so the
  default output filename still uses `_TR`; pass `--out ..._SE.xml.gz` when
  the desired asset name is Swedish.
- This is how CI avoids scraping twice: per-provider jobs upload their
  guides, the sports-merge job downloads them and merges offline.

## Channel-id aliases

Providers sometimes emit different XMLTV ids for the same channel — e.g.
hurriyet's curated `A.HABER.tr` vs mynet's generic-slug `AHABER.tr`.  Without
help, `--compare` reports them as two unrelated channels and `--merge` writes
both into the guide.  An optional alias map tells the tool they are the same
channel:

```json
// aliases.json
{
  "AHABER.tr": "A.HABER.tr",
  "TV8HD.tr": "TV8.tr"
}
```

```bash
node bin/epg-scraper.js --provider hurriyet,mynet --compare --alias-map aliases.json
node bin/epg-scraper.js --provider hurriyet,mynet --merge   --alias-map aliases.json
```

- The map is a flat JSON object `{ aliasId: canonicalId }` — the key is
  replaced, the value is kept.  Aliases are applied when comparing or merging
  providers (they have no effect on single-provider runs).
- `--compare`: the aliased ids collapse onto the canonical channel in the
  per-channel breakdown, so the schedules are actually diffed against each
  other.
- `--merge`: the channel appears once under its canonical id and every
  programme's channel reference is rewritten to match, keeping the guide
  internally consistent.
- Paths are resolved relative to the working directory; a missing or invalid
  file is a hard error (exit 1).

## Dev tools

A unified lifecycle manager (`scripts/dev-tools.js`) manages detached
background services for the scraper harness and browser experiments.
Both services are launched with own process groups so they survive the
calling tool call — the same pattern as the sports-tv dev-tools.

**Services:**
- `browser` — shared headless Chromium (CDP on `127.0.0.1:9222`)
- `server` — static file server for EPG output and test fixtures
  (port `8080`)

```bash
npm run dev:up          # start both services detached
npm run dev:down        # stop both services
npm run dev:status      # health-check both (exit 0 when all up)

npm run dev:start       # start server only (detached)
npm run dev:check       # check server only
npm run dev:stop        # stop server only
npm run dev:logs        # tail server log

npm run chrome:headless # start browser only (detached)
npm run chrome:check    # check browser only
npm run chrome:stop     # stop browser only
npm run chrome:logs     # tail browser log

npm run dev             # foreground server (non-detached)
```

### How it works

`scripts/dev-tools.js` reads a service registry table and for each service:
1. Checks for an existing running instance via pidfile
2. Spawns the process detached (`detached: true` + `child.unref()`)
3. Writes the pidfile and polls endpoints until ready (or timeout)

Stopping sends `SIGTERM` to the recorded process and its process group.
Logs are written to `~/.cache/epg-scraper/<service>.log`.

The static file server (`scripts/scraper-server.js`) serves the project
root — useful for previewing output XML files, test fixtures, and docs
in a browser.

### Browser service

The browser service launches Playwright's Chromium with
`--remote-debugging-port=9222` so other tools can connect via CDP.
The binary is resolved from Playwright's cache
(`~/.cache/ms-playwright/`); if missing, the `install` command guides
you to install it.

```bash
node scripts/dev-tools.js install browser   # verify/download Chromium
node scripts/dev-tools.js start browser      # launch detached
node scripts/dev-tools.js status browser     # check CDP endpoint
```Environment variables:
- `DEV_STATE_DIR` — pidfile/log directory (default `~/.cache/epg-scraper`)
- `CHROME_DEBUG_HOST` / `CHROME_DEBUG_PORT` — CDP bind (default `127.0.0.1:9222`)
- `CHROME_CACHE_DIR` — browser binary cache (default `~/.cache/ms-playwright`)
- `SERVER_PORT` / `SERVER_ROOT` — static server config (default `8080`, project root)

## Adding a provider

1. Create `src/providers/<id>.js` exporting:
   - `BASE_URL` and a curated `CHANNEL_ID_MAP`,
   - pure fixture-testable parsers,
   - `async scrape({ dates, fetchImpl, log, ... })` returning through
     `finishResult()`.
2. Add one entry to `src/provider-catalog.js` with its display name,
   country/language/time zone, browser capability, reference country, CI
   arguments, and sports-profile membership. `src/providers/index.js` derives
   registrations from that catalog.
3. Add fixtures, provider tests, and any intentional provider-inventory
   assertions.

Conventions every provider must follow:

- **Never eval scraped content.** Parse with regexes over known markup; a
  malformed or missing page must degrade to an empty/warned result, not a crash.
- **Fixed offset instants.** Programme `start`/`stop` are ISO 8601 strings with
  one fixed UTC offset (Turkey: `+03:00` year-round). Wall-clock slot times from
  the page are converted with that offset.  The one exception is a provider
  whose country observes DST (`tvnu` — Sweden): it stamps each timestamp with
  the Stockholm offset in force at that instant (`+01:00` winter, `+02:00`
  summer), because a pinned offset would shift every summer programme by an
  hour; the instants stay absolute either way.
- **Curated channel-id map.** XMLTV channel ids follow the epgshare01
  convention (name uppercased, non-alphanumeric runs → `.`, `.tr` suffix for
  the Turkish guides — `.se` for the Swedish tvnu guide;
  case-sensitive exceptions like `beIN.SPORTS.1.tr` are mapped explicitly).
  Ids are normalized to the epgshare01 guide for the provider's own country
  (`epg_ripper_TR1.xml.gz` for the Turkish providers,
  `epg_ripper_SE1.xml.gz` for tvnu) as the source of truth:
  diacritics are kept (`CNN.TÜRK.tr`, `TRT.ÇOCUK.tr`), stations the
  reference lists HD-only use the HD id (`A.NEWS.HD.tr`), and renamed/split
  feeds collapse onto one id (`NOW` → `FOX.tr`, `TV2` → `TEVE2.tr`,
  `TRT 3 / TRT SPOR` → `TRT.SPOR.tr`).  Channels the reference does not
  carry keep the generic slug.
  Unknown channels fall back to the generic slug.
- **Politeness.** Sequential day-page fetches with a small delay; browser-like
  User-Agent; bounded retries; no other endpoints, no telemetry.

### Provider contract

```js
{
  id: string,              // unique, used on CLI (--provider <id>)
  name: string,            // human label
  baseUrl: string,         // informational
  requiresBrowser?: boolean, // if true, CLI auto-launches headless Chromium
  browserCompatible?: false, // POST/session/JSON-API sources opt out of browser rendering
  country?: string,        // output filename suffix (default: 'TR' — tvnu: 'SE')
  language?: string,       // `lang` attribute on titles/names (default: 'tr' — tvnu: 'sv')
  timeZone?: string,       // default-window "today" anchor (Istanbul default; tvnu Stockholm; idmantv Baku)
  scrape({                 // async
    dates,                 // YYYY-MM-DD[] — the week window
    fetchImpl,             // injected: HTTP fetch or browser fetcher
    log,                   // (line) => void — progress output
    politenessDelayMs,     // ms between page fetches
    fetchOptions,          // transport options for fetchText / fetchResponseWithRetry
    maxChannels,           // optional channel cap where supported (including tvnu)
    env,                   // optional: credential environment (sporekraniapi — default process.env)
  }) => Promise<{ channels, programmes, days, failures, language }>
}
```

When `requiresBrowser` is true (or `--browser` is passed), `fetchImpl` is
a Playwright-backed function that opens each URL in a headless Chromium tab,
waits for network idle, and returns the rendered HTML.  Provider code
that calls `fetchImpl(url)` works unchanged — the browser layer is
transparent. Registrations with `browserCompatible: false` are rejected before
any scrape when `--browser` or a one-provider browser comparison would assign
browser transport to them.

## Provider: hurriyet

- Source: `https://www.hurriyet.com.tr/tv-rehberi/tum-programlar/{pazartesi..pazar}/`
  — one page per weekday, each carrying the **whole week's Mon–Sun grid** for
  that day-of-week. Whatever date window is requested is clamped to one
  Monday..Sunday week; the seven day slugs map to that week's wall dates.
- Page anatomy: sticky channel rail (`flow-module-channel` entries with logo
  `alt` names) + one `flow-module-row` per channel of `flow-module-col`
  programme slots (title in `column-title`, genre in `data-type`, times in
  `column-time` as `HH:MM - HH:MM`). Rail↔rows pairing is **positional**.
  Channel logos come from the rail `<img src>` with the deploy-version
  `?v=…` query stripped so guide diffs stay stable.
- Programme slots after midnight are normalized to the next calendar date
  before the shared wall-time converter stamps the stop instant.
- Genres: the page's `data-type` values map to Turkish category labels
  (`dizi` → `Dizi`, `film` → `Film`, …). The source has no descriptions, so
  `<desc>` is not emitted.

## Provider: tvplus

- Source: `https://tvplus.com.tr/canli-tv/yayin-akisi/{channel}--{id}`
  (Turkcell's OTT platform).  The web app is a Next.js SPA, but the schedule
  it shows comes from a plain-HTTP JSON API (discovered via chrome-devtools):
  1. `POST /get-platform-info` → the (rotating) EPG API base URL
  2. `POST {base}/EPG/JSON/Authenticate` → session cookie
  3. `POST {base}/EPG/JSON/PlayBillList` with `channelid` + `begintime`/
     `endtime` → the day's programmes with explicit `starttime`/`endtime`
     (already stamped `UTC+03:00`)
- Coverage: **any requested date range** (the API serves past and future
  days), for the channels TV+ carries:
  TRT 1, TRT Spor, TRT Spor Yıldız, A Spor, HT Spor, FB TV, tabii spor,
  S Sport, S Sport 2, Eurosport 1, Eurosport 2, Sports TV, ATV, TV8, TV8,5, A2.
- **Plain HTTP only** — this provider POSTs JSON, so it cannot run under
  `--browser` (the Playwright fetcher renders pages and cannot POST).  Do not
  pass `--browser` with `--provider tvplus`.
- Categories: the API's `genres` value (already a Turkish label like
  "Spor", "Dizi") is emitted as `<category lang="tr">` when present.
- The `--max-channels N` flag caps how many of the 16 channels are scraped.

```bash
# All 16 channels, today
node bin/epg-scraper.js --provider tvplus --date 2026-09-09 --days-forward 0

# A whole week
node bin/epg-scraper.js --provider tvplus --date 2026-09-09
```

## Provider: digiturkburada

- Source: `https://www.digiturkburada.com.tr/{page}.html` — a static
  third-party mirror of the Digiturk guide (Digiturk's own site blocks
  datacenter IPs at the network level, and beinsports.com.tr only publishes
  beIN Sports 1-4).  Covers **beIN Sports 1-5, beIN Sports Max 1,
  beIN Sports Max 2, GS TV** — including the feeds no other free source
  has (5, Max 1-2, GS TV).
- Page anatomy: one day's schedule as a `<table>` of
  `NAME` / `HH:MM` cells (Turkish HTML entities decoded).  Multi-day works
  via the page's own "Sonraki Gün" form: `POST` the same page with
  `yayin=DD.MM.YYYY`; the served date is echoed in an `<h2>` heading and is
  verified against the requested date before use.
- Programme stop times are derived from the next programme's start
  (24:00 for the last slot); timestamps use the fixed `+03:00` offset.
- **Plain HTTP only** — this provider POSTs form data, so it cannot run
  under `--browser`.

```bash
# beIN Sports 1-5 + Max 1-2 + GS TV for today and tomorrow
node bin/epg-scraper.js --provider digiturkburada --date 2026-09-08 --days-forward 1
```

## Providers: sporekraniapi and sporekrani

These adapters cover the feeds no other free source carries: **tabii spor 1-8**
(match-day simulcast channels) and **S Sport Plus** (D-Smart-only premium feed).

### Active provider: `sporekraniapi`

- Source: Spor Ekranı's plain-HTTPS v3 content API,
  `GET https://api.sporekrani.com/v3/events?day=YYYY-MM-DD` with the
  `app_id` and `api_key` query parameters. The JSON response uses a
  `{"data":[...]}` envelope.
- Credentials are never stored in the repository. Set
  `SPOREKRANI_API_APP_ID` and `SPOREKRANI_API_KEY` in the environment, or put
  them in the gitignored `./.env` for local live runs (see
  [Usage](#usage)). The scheduled workflow reads the same names from GitHub
  Secrets, and only for the `sporekraniapi` matrix job. `scrape()` also
  accepts an optional `env` (default `process.env`) so tests can inject
  credentials; per-day warnings report a failed request as `HTTP <status>`
  only, and the transport redacts sensitive query values from error messages.
- One request covers all nine channels for one requested day. Events are
  retained for every exact curated owner in `channels[]`, so a listed
  simulcast is emitted on each participating tabii feed.
- The source publishes **start times only**. Stops are derived from the next
  start for that channel inside the same API response; the final start ends at
  that day's midnight. The adapter deliberately never chains across days.
- `sport_name` is emitted as the category. Channel logos come from each exact
  owning channel's `icon`; pipe-joined logo garbage is rejected.
- This is a JSON API, not a renderable HTML page, so it is not browser-compatible.

```bash
# Local live run: credentials come from ./.env (gitignored) — copy the tracked
# template once and fill in the two values
cp .env.example .env

# All 9 channels for a seven-day window
node bin/epg-scraper.js --provider sporekraniapi --date 2026-09-30

# CI equivalent: the same names arrive from GitHub Secrets
export SPOREKRANI_API_APP_ID='<app id>'
export SPOREKRANI_API_KEY='<api key>'
```

### Retained benchmark baseline: `sporekrani`

The original `sporekrani` adapter remains registered for reproducible
provider-to-provider comparisons. It reads the rolling ~30-day
`window.__INITIAL_STATE__` event list from
`https://www.sporekrani.com/home/channel/{slug}`. It uses nine page requests
for a full guide and chains each start to the next listed event across day
boundaries.

That rolling-list policy is no longer used by daily CI: sparse event lists can
leave a programme open for days when the channel has no known broadcast. Run a
live comparison with:

```bash
node bin/epg-scraper.js \
  --provider sporekrani,sporekraniapi \
  --compare --date 2026-09-30 --out /tmp/sporekrani-benchmark
```

Verified live on 2026-09-24: both adapters returned 9 channels, the same two
S Sport Plus starts, and zero request failures; the first slot matched exactly.
For `Panathinaikos - Asvel Villeurbanne`, the SSR baseline ended at
`2026-10-09T19:30:00+03:00` (the next event nine days later), while the API
adapter ended at `2026-10-01T00:00:00+03:00`. The API adapter is therefore the
active CI and sports-merge source. A 7-day run the same day (credentials from
a local `.env`) returned 52 programmes across the nine channels with zero
failed requests and every stop inside its own day.

## Provider: tivibu

- Source: `https://www.tivibu.com.tr/kanallar/{slug}` (Tivibu GO, Türk
  Telekom) — covers **Tivibu Spor 1-4** (the old `tivibu.com.tr/yayin-akisi`
  path is dead; the new site moved to `/kanallar/<slug>`).
- Transport: the day-grid's date switcher is client-side, but behind it is a
  plain-HTTP JSON API (discovered via chrome-devtools): one GET of the
  channel page captures the ASP.NET antiforgery cookie, the hidden-input
  request token, and the channel's code (`ch…` in the `/rv?i=2|ch…` links);
  a `POST /Channel/GetPrevueList` per channel-day then returns
  `mobilPrevueViewModel[]` with `{ prevueName, genre, beginTime, endTime,
  description }` — **explicit start/stop on every slot**, so no stop
  derivation is needed, and any past/future date works.
- Each programme belongs to the day it starts on: the response for a day
  also carries the previous day's cross-midnight tail (e.g. 23:30 → 01:15),
  which is dropped so programmes are never duplicated across day requests.
- The `genre` (e.g. "Spor Programı") is emitted as the category and
  `description` as `<desc>`.
- Tivibu Spor 2-4 often carry only a repeating "Tivibu Spor Tanıtım" promo
  loop (idle feeds) — those slots are emitted as-is.
- **Plain HTTP only** — this provider POSTs form data + antiforgery cookies,
  so it cannot run under `--browser`.

```bash
# All 4 channels, today
node bin/epg-scraper.js --provider tivibu --date 2026-09-08
```

## Provider: idmantv

- Source: `https://idmantv.az/az/program` — the official weekly programme of
  **İdman TV** (İdman Televiziyası, Azerbaijan's first sports channel).  The
  old `idmantv.com.tr` domain is dead; the real site is `idmantv.az`.
- Page anatomy: static server-rendered HTML (Webflow) — no JS, no API, no
  login.  Each `div.day-card` holds one day of the current Mon–Sun week:
  `<h3 class="day-title">Bazar ertəsi / 07.09.2026</h3>` followed by
  `.prog-row` entries of `<span class="prog-time">HH:MM</span>` +
  `<span class="prog-name">Title</span>` (Azerbaijani titles).
- Like beinsports, the site publishes exactly one Mon–Sun week, so any
  requested window is served from it and dates outside are skipped with a
  warning.  **One fetch** covers all seven days.  Programme stop times are
  derived from the next programme's start (24:00 for the last slot).
- The page occasionally appends a stray cross-channel note to the last
  Sunday slots (e.g. "… (canlı) Mədəniyyət TV") — emitted verbatim, as
  published.
- Offset caveat: the site's HH:MM are Baku wall times (UTC+4 year-round
  in 2026 — Azerbaijan abolished DST in 2016). The provider stamps them with
  the fixed `+04:00` offset, so emitted instants match the source times.
  A merged guide legitimately carries both `+03:00` (Turkish channels) and
  `+04:00` (İdman TV) stamps; consumers must compare instants, not strings —
  which the scraper's writer and reader already do.

```bash
# Any day inside the published week (fixture dates: 2026-09-07 .. 2026-09-13)
node bin/epg-scraper.js --provider idmantv --date 2026-09-12
```

## Provider: beinsports

- Source: `https://beinsports.com.tr/yayin-akisi/{channel}/{day}` where
  `{channel}` ∈ `beinsports`, `beinsports-2`, `beinsports-3`, `beinsports-4`
  and `{day}` is a weekday slug (`pazartesi`..`pazar`).
- Page anatomy: server-rendered Next.js with the whole guide embedded in a
  `__NEXT_DATA__` JSON script tag — `props.pageProps.activeLeagues` lists the
  channels and `props.pageProps.data.listTvGuides` holds
  `{ channel_id, event_time: "HH:MM:SS", name }` entries for the selected
  channel.
- Coverage: beIN Sports 1-4 (the site does not publish beIN Sports 5 or the
  Max feeds — those live behind Digiturk's login; see `UNSUCCESSFUL.md`).
- Like Hürriyet, the site publishes exactly one Mon–Sun week, so any
  requested window is clamped to the week containing its first date.
  Programme stop times are derived from the next programme's start
  (24:00 for the last slot).

```bash
# All four beIN Sports feeds, current week
node bin/epg-scraper.js --provider beinsports --date 2026-09-08
```

## Provider: mynet

- Source: `https://www.mynet.com/tv-rehberi`
  — the main page lists 87+ channels as cards.  Each channel has three
  day pages with flat `<ul>` schedules:
  - `/tv-rehberi/{slug}-yayin-akisi-bugun` — today
  - `/tv-rehberi/{slug}-yayin-akisi-yarin` — tomorrow
  - `/tv-rehberi/{slug}-yayin-akisi-sonraki-gun` — day after tomorrow
- Coverage: exactly **3 days** (today + 2 forward).  Dates outside this
  window are silently skipped.
- Page anatomy: each day page has `<li>` items with
  `<strong class="program-time">HH:MM</strong>` and
  `<p class="program-name">Name</p>`.  Programme stop times are derived
  from the next programme's start (or 24:00 for the last slot).
- Channel discovery: the main page is fetched once to extract all channel
  slugs, display names, and logos (card `<img data-original>`, falling back
  to `src`; `data:` placeholders ignored).  The `--max-channels N` flag limits how many
  channels are scraped (useful for testing or faster runs).
- The provider supports `maxChannels` in `scrape()` options.

```bash
# Scrape all 87 channels for today only
node bin/epg-scraper.js --provider mynet --date 2026-09-08

# Scrape 3-day window, limit to 10 channels
node bin/epg-scraper.js --provider mynet --date 2026-09-08 --days-forward 2 --max-channels 10

# Slow down further when scraping from a datacenter IP
node bin/epg-scraper.js --provider mynet --delay-ms 1000
```

## Provider: tvnu (Sweden)

- Source: `https://www.tv.nu/kanal/{slug}?datum=YYYY-MM-DD` — tv.nu (Schibsted)
  is Sweden's biggest TV guide.  Every channel page ships the whole day's
  schedule inside the HTML as a JSON string assignment
  (`__INITIAL_STATE__ = "…"`), so no browser/JS rendering is needed.
- Coverage: **69 channels** — the Swedish nationals (SVT 1/2, SVT 24,
  SVT Barn, Kunskapskanalen, TV3, TV4 + Film/Guld/Fakta, Kanal 5/9/10/11,
  TV6, Sjuan, TV8, TV10, TV12), nine TV4 sports feeds (Fotboll, Hockey,
  Motor, Sportkanalen, Tennis, Sport Live 1–4), the Viaplay/V Sport block
  (V Sport 1/Extra/Premium/Golf/Motor/Vinter, Fight Sports, V Sport Live 1–5,
  Viaplay Sport) plus Eurosport 1–2, the Nordic pay-TV feeds
  (SkyShowtime 1-2, SF Kanalen, TLC, Animal Planet, BBC Nordic, BBC Earth,
  Discovery Channel/Science,
  Investigation Discovery, H2, History, National Geographic, Nat Geo Wild,
  Paramount Network, Trace Urban) and the kids/music channels (Cartoon
  Network, Cartoonito, Disney Channel, Nickelodeon, Nick Jr., Nicktoons,
  MTV, MTV Live, MTV 00s, MTV Hits).
- Both `startTime` and `endTime` are published as **absolute epoch
  milliseconds**, so stops are never guessed from the next slot.
- Day pages run **06:00 → 06:00 local**, so the provider fetches the day
  before the window too and buckets every slot by the date it starts on.
  This includes available small-hours slots, but does not guarantee complete
  coverage: tv.nu prunes already-aired slots from the current day, and the
  lookback cannot recover data removed upstream. A later scrape may therefore
  contain fewer of today's programmes, not a more complete day.
- Timestamps carry the **Stockholm offset in force at that instant**
  (`+01:00` winter, `+02:00` summer) because Sweden observes DST; the
  instants are absolute either way.  Swedish titles are emitted as
  `<title lang="sv">`, with the first genre as `<category lang="sv">` and
  the description as `<desc lang="sv">`.
- Channel logos are each page's own `themedLogo` image.
- Channel ids are normalized to epgshare01's Swedish guide
  (`epg_ripper_SE1.xml.gz`), e.g. `[SVT1HD].SVT1.HD.se`; the few channels it
  does not carry yet use a generic `.se` slug (e.g. `SVT.BARN.se`) and are
  acknowledged in `test/fixtures/epgshare01/reference-se.json` `knownGaps`.
- The provider supports `maxChannels` in `scrape()` options.

```bash
# Today's Swedish guide (default window: today, Stockholm time)
node bin/epg-scraper.js --provider tvnu

# A week, output epg_tvnu_SE.xml.gz
node bin/epg-scraper.js --provider tvnu --days-forward 6

# Quick smoke run: 3 channels for one day
node bin/epg-scraper.js --provider tvnu --days-forward 0 --max-channels 3
```

Because one request is made per channel **and day** (plus one extra day for
the small hours), a 7-day run of all 69 channels is 552 fetches — raise
`--delay-ms` if you run it often.

Not available from tv.nu (verified 2026-09-17 — no such channel page,
HTTP 404): TV4 Nyheterna, Dagens Industri TV, Barnmusik, Disney Junior,
Discovery World, Food Network and BBC First (see `UNSUCCESSFUL.md`).

### Matching tvnu's ids to your playlist

A playlist usually carries several quality variants per channel (FHD/HD/SD)
and its own `tvg-id` values.  The guide collapses those variants onto one
canonical id per feed; where your `tvg-id`s differ, remap them with an alias
map — the key is the id the scraper emits, the value the id your player
expects:

```json
{
  "[SVT1HD].SVT1.HD.se": "SVT1.se",
  "[TV3HD].TV3.HD.se": "TV3.se"
}
```

```bash
# A merge run applies the alias map (and keeps the _SE country/language)
node bin/epg-scraper.js --provider tvnu --alias-map aliases.tvnu.json --merge --out epg_tvnu_SE.xml.gz
```


### Sports guide from the sports providers
```bash
# One guide with all 38 scrapeable sports channels
node bin/epg-scraper.js --provider tvplus,beinsports,digiturkburada,sporekraniapi,tivibu,idmantv --merge --out epg_sports_merged_TR.xml.gz
```

`tvplus` wins conflicts; `beinsports` fills beIN Sports 1-4;
`digiturkburada` adds beIN Sports 1-5, Max 1-2 and GS TV (5 / Max / GS TV
exist nowhere else); `sporekraniapi` adds
tabii spor 1-8 and S Sport Plus; `tivibu` adds Tivibu Spor 1-4; `idmantv`
adds İdman TV (Azerbaijani titles; not in the Turkish epgshare01 reference).
(The workflow publishes this same file as `epg_sports_merged_TR.xml.gz`.)

## Scheduled scrapes (GitHub Actions)

`.github/workflows/scrape.yml` builds its matrix and sports-merge inputs
from `src/provider-catalog.js`, then runs the configured providers daily at
00:30 UTC (03:30 TRT) and publishes XMLTV guides as assets on a rolling
`latest` GitHub Release. The matrix excludes beinsports because
DigiturkBurada already covers its beIN 1–4 feeds with full-day schedules, and
`sporekraniapi` supersedes the rolling SSR Spor Ekranı adapter because its
day-scoped responses bound the final event at midnight. The API job requires
the `SPOREKRANI_API_APP_ID` and `SPOREKRANI_API_KEY` GitHub Secrets.
Mynet runs with an explicit `--delay-ms 500` because a full run is ~260
page fetches; tvnu uses `--days-forward 2 --delay-ms 400`: 69 channels ×
(3 requested days + 1 lookback day) = 276 requests before retries.
The sports-merge job reuses per-provider artifacts via offline merge
(`--merge --from`), rather than performing a second scrape for merging.
Transport retries and whole-provider retry attempts can still repeat requests.
Outputs are gitignored, so nothing is
committed — and if a day's scrape fails, the previous release stays live.

Resilience: each provider scrape is retried (3 attempts with backoff, plus
hardened `--retries 4 --timeout-ms 30000` transport flags), one provider
failing never blocks the others (`fail-fast: false`, `if-no-files-found:
warn`), and the merge/publish jobs run with `if: !cancelled()` so they
merge and publish whatever guides survived — guides are validated
(size, gzip integrity, `<tv>` root) before they can overwrite the release,
and a run with zero valid guides leaves the previous release untouched.

### Using the guide in an IPTV app

Paste one of these stable URLs into your app's XMLTV/EPG source field
(replace `OWNER/REPO` with this repository's path; the URLs start working
after the first successful workflow run, which you can trigger manually via
"Run workflow"):

```
https://github.com/OWNER/REPO/releases/latest/download/epg_hurriyet_TR.xml.gz
https://github.com/OWNER/REPO/releases/latest/download/epg_mynet_TR.xml.gz
https://github.com/OWNER/REPO/releases/latest/download/epg_tvnu_SE.xml.gz
```

The repository must be **public** — release assets on private repos require
authentication, which IPTV apps can't do. Workflow run artifacts (the run's
"Artifacts" section) are *not* usable here: they need a GitHub login and
expire after 7 days.

## Output shape

Matches the epgshare01 reference exactly:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="epg-scraper (hurriyet)" generator-info-url="none">
  <channel id="KANAL.D.tr">
    <display-name lang="tr">KANAL D</display-name>
    <icon src="https://.../94.png" />
    <url>https://www.hurriyet.com.tr/tv-rehberi/yayin-akisi/94/1/kanal-d/</url>
  </channel>
  <programme start="20260907150000 +0300" stop="20260907170000 +0300" channel="KANAL.D.tr">
    <title lang="tr">Program Adı</title>
    <category lang="tr">Dizi</category>
  </programme>
</tv>
```

Programmes are sorted by channel (codepoint order), then start instant;
equal instants are ordered by their ISO strings for deterministic output.
The writer keeps the first occurrence per `(channel, start, stop)`, even if
titles differ. Turkish providers stamp one
`+0300` offset like the Turkish reference file. Exceptions: the Swedish tvnu
guide, whose timestamps carry the Stockholm offset in force at each instant
(`+0100` winter / `+0200` summer) and whose titles carry `lang="sv"`; and
İdman TV, stamped `+0400` (Baku, no DST) — a merged guide may carry
`+0300` and `+0400` side by side.

## Tests

`npm test` (vitest, node environment). All network-dependent behavior is
tested against **fixtures** captured from the real pages (`test/fixtures/`)
and stubbed `fetchImpl` — never against live sites. The live scrape is a
manual step (`npm run scrape`).

Browser tests mock `playwright` via `vi.mock()` — no real browser is
launched during `npm test`.

Channel ids are normalized to epgshare01's guides.  The upstream id lists are
vendored as `test/fixtures/epgshare01/reference.json`
(`epg_ripper_TR1.xml.gz`, the Turkish providers) and
`test/fixtures/epgshare01/reference-se.json` (`epg_ripper_SE1.xml.gz`, the
Swedish `tvnu` provider), and enforced by `test/reference.test.mjs`, which
fails if a snapshot is older than 7 days — refresh both weekly with
`npm run update:reference` (re-downloads the upstream files, preserves each
snapshot's `knownGaps`, reports added/removed ids).

## Layout

```
bin/epg-scraper.js      CLI
src/browser.js          Playwright browser fetcher (optional)
src/compare.js          http-vs-browser / provider-vs-provider comparison
src/merge.js            multi-provider merge for --merge
src/aliases.js          optional channel-id alias map (--alias-map)
src/http.js             fetch helper (UA, timeout, retries)
src/entities.js         HTML entity decoder
src/slug.js             generic channel-id slug (country suffix, default .tr)
src/model.js            guide-result normalization + strict writer validation
src/time.js             wall-clock, guide-instant, and XMLTV timestamp semantics
src/registry.js         provider registry + date-range helper
src/provider-catalog.js authored provider, reference, CI, and sports inventory
src/xmltv.js            XMLTV writer + reader (plain + gzip; parseXmltv powers --merge --from)
src/cli.js              CLI implementation (testable)
src/providers/          provider adapters (hurriyet, mynet, tvplus, beinsports, digiturkburada, sporekrani, sporekraniapi, tivibu, idmantv, tvnu)
scripts/dev-tools.js    lifecycle manager for browser + server
scripts/provider-inventory.js  print provider/CI/sports inventory projections
scripts/update-reference-ids.js  refresh the vendored epgshare01 TR + SE id snapshots
scripts/scraper-server.js  static file server for EPG output
test/                   vitest suites + fixtures
```
