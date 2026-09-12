# epg-scraper

Universal EPG (electronic programme guide) scraper. Provider adapters scrape
different TV-guide sources; the pipeline normalizes them into one internal
model and writes **XMLTV** files matching the shape of epgshare01's
`epg_ripper_TR1.xml.gz` reference, optionally gzipped.

```
source site ──> provider adapter ──> internal model ──> XMLTV writer ──> epg_<provider>_TR.xml.gz
                (src/providers/)     (src/model.js)      (src/xmltv.js)
```

Zero runtime dependencies (Node built-ins only); vitest is a dev dependency.
Playwright is an **optional** runtime dependency for JS-rendered providers.

## Usage

```bash
npm install                  # dev dependencies (vitest) only
npm run scrape               # hurriyet provider, epg_hurriyet_TR.xml.gz
npm run scrape:gz            # same (gzip is the default)
node bin/epg-scraper.js --list-providers
node bin/epg-scraper.js --provider hurriyet --no-gzip --out out/guide.xml
node bin/epg-scraper.js --provider hurriyet --date 2026-09-14   # anchor week
npm test
```

Options: `--provider`, `--out`, `--gzip/--no-gzip`, `--date YYYY-MM-DD`,
`--days-back N`, `--days-forward N`, `--delay-ms N`, `--retries N`,
`--timeout-ms N`, `--retry-delay-ms N`, `--browser`, `--stealth`, `--compare`,
`--merge`, `--from <files>`, `--alias-map <path>`, `--quiet`, `--list-providers`.

`--delay-ms` overrides the per-request politeness delay (ms between page
fetches; defaults: hurriyet 250, mynet 500, tvplus 400, beinsports 300,
digiturkburada 400, sporekrani 500, tivibu 400 —
mynet fetches ~90 channel pages per day, so keep this polite).

Transport failsafes are tunable: `--retries N` sets the retry attempts per
request after the first (defaults: 2 for plain-HTTP page GETs, 1 for the
JSON/form API POSTs), `--timeout-ms N` the per-request hard timeout
(default 20000), and `--retry-delay-ms N` the base backoff between
attempts (default 400, scaled linearly per attempt).  Transient failures
(HTTP 5xx/429, network errors, timeouts) are retried; other statuses fail
immediately.  Raise `--retries` for unreliable links, lower `--timeout-ms`
 to fail fast on dead hosts.

Sports channels are covered by the `tvplus`, `beinsports`, `digiturkburada`,
`sporekrani`, `tivibu`, and `idmantv` providers (38 channels together); see
the dedicated sections below and `UNSUCCESSFUL.md` for the channels that still
have no public scrapeable source.

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
  `epg_<provider>_TR.http.xml[.gz]` and `epg_<provider>_TR.browser.xml[.gz]`
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
- One file is written: `epg_merged_TR.xml[.gz]` (or `--out path`).
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
   - `id`-relevant constants (`BASE_URL`, …),
   - a pure parser `parse<X>(html) -> data` (no I/O — keep it fixture-testable),
   - `async scrape({ dates, fetchImpl, log, ... }) -> { channels, programmes }`.
2. Register it in `src/providers/index.js` (`registerProvider({ id, name, baseUrl, scrape })`).
   Set `requiresBrowser: true` if the source needs JS rendering.
3. Add fixtures under `test/fixtures/<id>/` and tests under `test/`.

Conventions every provider must follow:

- **Never eval scraped content.** Parse with regexes over known markup; a
  malformed or missing page must degrade to an empty/warned result, not a crash.
- **Fixed offset instants.** Programme `start`/`stop` are ISO 8601 strings with
  one fixed UTC offset (Turkey: `+03:00` year-round). Wall-clock slot times from
  the page are converted with that offset.
- **Curated channel-id map.** XMLTV channel ids follow the epgshare01
  convention (name uppercased, non-alphanumeric runs → `.`, `.tr` suffix;
  case-sensitive exceptions like `beIN.SPORTS.1.tr` are mapped explicitly).
  Ids are normalized to `epg_ripper_TR1.xml.gz` as the source of truth:
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
  scrape({                 // async
    dates,                 // YYYY-MM-DD[] — the week window
    fetchImpl,             // injected: HTTP fetch or browser fetcher
    log,                   // (line) => void — progress output
    politenessDelayMs,     // ms between page fetches
    fetchOptions,          // passed through to fetchText
  }) => Promise<{ channels, programmes, days, failures }>
}
```

When `requiresBrowser` is true (or `--browser` is passed), `fetchImpl` is
a Playwright-backed function that opens each URL in a headless Chromium tab,
waits for network idle, and returns the rendered HTML.  Provider code
that calls `fetchImpl(url)` works unchanged — the browser layer is
transparent.

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
- Programme slots after midnight roll into the next day (`wallToIso` handles
  minutes ≥ 1440 via date overflow).
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
  beIN Sports 1-4).  Covers the feeds no other free source has:
  **beIN Sports 5, beIN Sports Max 1, beIN Sports Max 2, GS TV**.
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
# beIN Sports 5 + Max 1-2 + GS TV for today and tomorrow
node bin/epg-scraper.js --provider digiturkburada --date 2026-09-08 --days-forward 1
```

## Provider: sporekrani

- Source: `https://www.sporekrani.com/home/channel/{slug}` (Spor Ekranı, the
  "hangi maç hangi kanalda" aggregator).  Covers the feeds no other free
  source carries: **tabii spor 1-8** (match-day simulcast channels) and
  **S Sport Plus** (D-Smart-only premium feed).
- Page anatomy: a Quasar SSR page with the schedule embedded in a
  `window.__INITIAL_STATE__` JSON script tag — `common.events` holds the
  channel's rolling ~30-day event list
  (`{ name, date_time: "YYYY-MM-DD HH:MM:SS" (Istanbul wall time),
  sport_name, channels: [...] }`).  An event often airs on several channels
  (e.g. a Champions League match on tabii Spor 1 AND CBC Sport), so only
  events whose `channels[].name` matches the page's channel are kept.
- Each page covers the whole ~30-day window, so **one fetch per channel**
  serves any requested dates inside it (dates outside are silently skipped).
- **Events-only:** the source publishes start times but no end times.
  Programme stops are derived from the next event on the page, chained
  across day boundaries (24:00 for the last event) — the same convention as
  beinsports/mynet/digiturkburada.
- The `sport_name` (e.g. "Futbol", "Basketbol") is emitted as the category.
- tabii spor 1-8 are match-day simulcast feeds — most days most of them
  carry no events at all, which is correct, not a scrape failure.

```bash
# All 9 channels (tabii spor 1-8 + S Sport Plus)
node bin/epg-scraper.js --provider sporekrani --date 2026-09-08
```

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
- Offset caveat: the site's HH:MM are Baku wall times (UTC+4, UTC+5 during
  Azerbaijan's late-March → late-October DST).  Timestamps are stamped with
  the repo's fixed `+03:00` like every provider so the merged guide keeps a
  single offset.

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

### Sports guide from the sports providers

```bash
# One guide with all 38 scrapeable sports channels
node bin/epg-scraper.js --provider tvplus,beinsports,digiturkburada,sporekrani,tivibu,idmantv --merge --out epg_sports_merged_TR.xml.gz
```

`tvplus` wins conflicts; `beinsports` fills beIN Sports 1-4;
`digiturkburada` adds beIN Sports 5, Max 1-2 and GS TV; `sporekrani` adds
tabii spor 1-8 and S Sport Plus; `tivibu` adds Tivibu Spor 1-4; `idmantv`
adds İdman TV (Azerbaijani titles; not in the Turkish epgshare01 reference).
(The workflow publishes this same file as `epg_sports_merged_TR.xml.gz`.)

## Scheduled scrapes (GitHub Actions)

`.github/workflows/scrape.yml` scrapes every provider daily at 00:30 UTC
(03:30 TRT) and publishes the XMLTV guides as assets on a rolling `latest`
GitHub Release. Mynet runs with an explicit `--delay-ms 500` because a
full run is ~260 page fetches. Each provider is scraped **exactly once**:
the sports-merge job downloads the per-provider artifacts and merges them
offline (`--merge --from`), so the sports sources are never hit twice.
Outputs are gitignored, so nothing is
committed — and if a day's scrape fails, the previous release stays live.

### Using the guide in an IPTV app

Paste one of these stable URLs into your app's XMLTV/EPG source field
(replace `OWNER/REPO` with this repository's path; the URLs start working
after the first successful workflow run, which you can trigger manually via
"Run workflow"):

```
https://github.com/OWNER/REPO/releases/latest/download/epg_hurriyet_TR.xml.gz
https://github.com/OWNER/REPO/releases/latest/download/epg_mynet_TR.xml.gz
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

Programmes are sorted by channel then start time; duplicates on
`(channel, start, stop, title)` are removed; timestamps carry a single
`+0300` offset like the reference file.

## Tests

`npm test` (vitest, node environment). All network-dependent behavior is
tested against **fixtures** captured from the real pages (`test/fixtures/`)
and stubbed `fetchImpl` — never against live sites. The live scrape is a
manual step (`npm run scrape`).

Browser tests mock `playwright` via `vi.mock()` — no real browser is
launched during `npm test`.

Channel ids are normalized to epgshare01's `epg_ripper_TR1.xml.gz`. Its id
list is vendored at `test/fixtures/epgshare01/reference.json` and enforced
by `test/reference.test.mjs`, which fails if the snapshot is older than 7
days — refresh it weekly with `npm run update:reference` (re-downloads the
upstream file, preserves `knownGaps`, reports added/removed ids).

## Layout

```
bin/epg-scraper.js      CLI
src/browser.js          Playwright browser fetcher (optional)
src/compare.js          http-vs-browser / provider-vs-provider comparison
src/merge.js            multi-provider merge for --merge
src/aliases.js          optional channel-id alias map (--alias-map)
src/http.js             fetch helper (UA, timeout, retries)
src/entities.js         HTML entity decoder
src/slug.js             generic channel-id slug
src/model.js            channel/programme model + validation
src/registry.js         provider registry + date-range helper
src/xmltv.js            XMLTV writer + reader (plain + gzip; parseXmltv powers --merge --from)
src/cli.js              CLI implementation (testable)
src/providers/          provider adapters (hurriyet, mynet, tvplus, beinsports, digiturkburada, sporekrani, tivibu, …)
scripts/dev-tools.js    lifecycle manager for browser + server
scripts/scraper-server.js  static file server for EPG output
test/                   vitest suites + fixtures
```
