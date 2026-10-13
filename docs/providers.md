# Provider adapters

Per-provider transport, coverage window, curated channel ids and gotchas — one
entry per adapter registered in `src/provider-catalog.js`.  Read the entry for
the provider you are changing, and add one when you add a provider (see
"Adding a provider" in `../AGENTS.md`).

Shared plumbing — `wallToIso`, `weekDays`, `weekdayIndex`,
`normalizeChannelKey`, `defaultDates`, `finishResult`, and
`stripQualityQualifier()` (drops a redundant trailing `HD`/`FHD`/`UHD`/`SD` from
a channel display name at `finishResult()`) — lives in
`src/providers/shared.js`; `wallToIso`/`weekDays` are re-exported from
`hurriyet.js` for compatibility.

- `hurriyet.js` — Hürriyet TV Rehberi: `parseDayPage(html)`, `scrape()`, day
  slug/date mapping, curated channel-id map.  Uses positional rail/row
  pairing; handles the `passive` class added by client-side JS.  Channel
  logos come from the rail `<img src>` with the `?v=…` query stripped.
- `mynet.js` — Mynet TV Rehberi: `parseMainPage(html)` discovers channels
  (slug, name, logo from card `data-original`/`src`);
  `parseChannelPage(html)` extracts time/name slots.  3-day coverage
  (today + 2 forward), anchored on the first requested date so `--date`
  is honored regardless of the real clock; supports `maxChannels`
  option.  Default `politenessDelayMs` is 500 (vs hurriyet's 250)
  because a full run is ~90 channel pages per day (~260 requests for 3
  days).
- `trt.js` — TRT Yayın Akışı (`trthaber.com`): the 11 TRT channels
  (TRT 1, TRT 2, TRT Haber, TRT Spor, TRT Spor Yıldız, TRT Belgesel,
  TRT Çocuk, TRT Müzik, TRT Türk, TRT Avaz, TRT Kurdî), one static SSR
  page per channel **and** date
  (`/yayin-akisi/{channel}/{DD-MM-YYYY}`, plain HTTP, no JS/API/login).
  Unlike hurriyet it is **per-date, not week-shaped** — any date serves
  (past and future), so the requested window is honoured as given and
  `--days-back` works; the index publishes today..+6, the default CLI
  window, and is also the only place the per-channel logos
  (`kanal-logo/…`) are published. `parseServedDate()` verifies each page's
  `<title>` against the request and skips a mismatch instead of misdating
  it (channels are published at different times, so a channel's "tomorrow"
  can 404 in the morning). `parseDayPage()` reads the `epg-list` items,
  `parseChannelLogos()` the index cards, `dayPageUrl()`/`daySlug()` the
  URL shape. Ids are curated in final form (`TRTCOCUK.tr`,
  `TRTKURDI.tr`, `TRTAVAZ.tr` — no id carries a quality qualifier, not
  even for the HD-only TRT Avaz). Stops chain
  from the next slot (24:00 for the last one).
  Authoritative for every TRT channel, which is why the merged
  `hurriyetTrt` feed lists it first. Browser-compatible (GET pages only).
- `tvplus.js` — TV+ (Turkcell) Yayın Akışı: a **plain-HTTP JSON API**
  provider curating **76 channels** — the platform's 172-channel lineup has
  155 with programme data (the other 17 are movie-collection VOD rails), and
  the table keeps every channel TV+ serves that hurriyet or mynet also
  curate (so this provider stands alone for that lineup) plus Viasat
  History, which closes the catalog's `HISTORY.tr` gap.  The sports feeds
  (TRT Spor/Yıldız, A Spor, HT Spor, FB TV, tabii spor, S Sport 1/2,
  Eurosport 1/2, Sports TV) are declared separately as `SPORTS_CHANNEL_IDS`
  because tvplus is in the sports profile.  Channel ids are the ones the
  other providers publish, never new spellings.  Flow:
  `POST /get-platform-info` → rotating API base,
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
  only — pipe-joined garbage some guides carry is rejected).
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
