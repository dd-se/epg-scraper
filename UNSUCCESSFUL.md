# Unsuccessful channels — to fix later

This file tracks the sports-channel list entries that the current providers
could **not** scrape (as of 2026-09-09), the source(s) tried, and why they
failed.  Each entry is a fix-me note: the channel either needs a different
source, login/auth flow, or a bespoke scraper to be built later.
Statements about live sites below were re-verified on 2026-09-09 unless a
fixture/test is cited instead; the `idmantv.az` weekly page was re-fetched
live on 2026-09-12 when the `idmantv` provider landed, the Swedish
`tv.nu` channel pages on 2026-09-17 when the `tvnu` provider landed, and the
Exxen rows exhaustively re-probed on 2026-10-16 (platform CMS, the Erstream
EPG backend, and the aggregators — see the Exxen row).

Covered today (34 sports channels — TV+'s general-interest channels are excluded,
because the sports merge takes only each provider's sports subset):

| Provider | Channels |
| --- | --- |
| `tvplus` | TRT Spor, TRT Spor Yıldız, A Spor, HT Spor, FB TV, tabii spor, S Sport, S Sport 2, Eurosport 1, Eurosport 2, Sports TV |
| `beinsports` | beIN Sports 1, beIN Sports 2, beIN Sports 3, beIN Sports 4 |
| `digiturkburada` | beIN Sports 5, beIN Sports Max 1, beIN Sports Max 2, GS TV |
| `sporekraniapi` | tabii spor 1, tabii spor 2, tabii spor 3, tabii spor 4, tabii spor 5, tabii spor 6, tabii spor 7, tabii spor 8, S Sport Plus |
| `tivibu` | Tivibu Spor, Tivibu Spor 1, Tivibu Spor 2, Tivibu Spor 3, Tivibu Spor 4 |
| `idmantv` | İdman TV |

Run all six and merge into one guide:

```bash
node bin/epg-scraper.js --provider tvplus,beinsports,digiturkburada,sporekraniapi,tivibu,idmantv --merge --sports-only
```

(The offline rebuild from the CI artifacts is `npm run merge:sports`, which
already carries `--sports-only`.)

Notes:
- **beIN Sports 5, Max 1-2** were originally unsupported: digiturk.com.tr is
  blocked at the network level (Azure Application Gateway WAF, 403 on every
  path — verified with the project's `--browser --stealth` fetcher, the block
  happens before any page logic), and beinsports.com.tr only publishes
  beIN Sports 1-4 + Haber (the `beinsports-5` / `beinsports-max-*` slugs are
  empty Next.js fallbacks).  They are now covered via
  `digiturkburada.com.tr`, a static mirror of the Digiturk guide.
- **GS TV** (club channel) is now covered via digiturkburada too — its own
  site (gstv.com.tr) is unreachable.
- **tabii spor 1-8 and S Sport Plus** were unsupported until 2026-09-08:
  tabii's feeds are match-day simulcast channels inside the tabii app (login
  + DRM) and S Sport Plus is a D-Smart-only premium feed. Both are now covered
  by the active `sporekraniapi` provider, which reads Spor Ekranı's day-scoped
  `GET /v3/events?day=YYYY-MM-DD` JSON API. It emits the source's start-only
  events and bounds the last event for each channel at that day's midnight.
  The original rolling-page `sporekrani` adapter remains registered only as a
  benchmark baseline.
- **Tivibu Spor 1-4** were unsupported until 2026-09-08: the old
  `tivibu.com.tr/yayin-akisi` path returned 404.  They are now covered via
  the `tivibu` provider, which drives the new `/kanallar/<slug>` pages'
  plain-HTTP JSON API (`POST /Channel/GetPrevueList`, explicit start/stop).

## New sources found on 2026-09-08 (verified live)

Re-checked every channel below with fresh lookups.  Several channels that
had "no public EPG" a day ago now have a concrete, working source.  Where
no provider exists yet, the row is a verified candidate for future work:

| Source | Channels it covers | Status |
| --- | --- | --- |
| `api.sporekrani.com/v3/events?day=` | tabii spor 1-8, S Sport Plus | **IMPLEMENTED** as the active `sporekraniapi` provider (one JSON request per requested day, all nine exact channel owners filtered locally, start-only slots bounded at the response day's midnight). The original `sporekrani` SSR adapter remains registered as a benchmark baseline. |
| `tivibu.com.tr/kanallar/tivibu-spor{-1,-2,-3,-4}` | Tivibu Spor and Tivibu Spor 1-4 | **IMPLEMENTED** as the `tivibu` provider (session GET for cookie/token/channel-code, then `POST /Channel/GetPrevueList` per channel-day; explicit start/stop, any date). The unnumbered page was verified live on 2026-10-13 and returned 19 slots for that day. Spor 2-4 carry only a repeating "Tivibu Spor Tanıtım" promo loop in the 2026-09-09 fixtures (5 slots each, emitted as-is). The general grid `tivibu.com.tr/canli-tv/spor` uses the same backend but the provider drives the per-channel pages + API directly. |
| `idmantv.az/az/program` | iDMAN TV | **IMPLEMENTED** as the `idmantv` provider (re-verified live 2026-09-09 + fixture 2026-09-07: static SSR weekly programme "Həftənin bütün günlərinin TV proqramları (07.09.2026 - 13.09.2026)" with HH:MM start times per weekday (Bazar ertəsi / 07.09.2026, Ç. axşamı / 08.09.2026, … Bazar / 13.09.2026), Azerbaijani titles, no login wall).  One fetch covers the whole Mon–Sun week; dates outside it are skipped with a warning (the site only publishes the current week, like beinsports).  Stops derive from the next slot (24:00 for the last).  (The old `idmantv.com.tr` domain is dead; the real site is `idmantv.az`.) |
| `cbcsport.az/teleproqram/` | CBC Sport | Re-check result (2026-09-09): page is live (165 KB HTML) but the fetched markup contains the `Teleproqram` heading/nav and news/verilişler lists with **no dated programme rows** — schedule content is not in the static HTML (JS-rendered or auth-gated: page also embeds a login form "Sizin hesabınıza daxil"). Still needs `--browser` verification before trusting it; the old "no TR feed page found" note is dropped (there is exactly one CBC Sport feed; the strikethrough was misleading). |
| `trt.net.tr/yayin-akisi` | tabii spor (joint TRT feed, already via tvplus) | First-party sanity check, re-verified live 2026-09-09: the page renders full dated grids for TRT 1/2/Belgesel/Haber/Spor/Spor Yıldız/Çocuk/… **and** a "Tabii Spor Yayın Akışı" grid (09.30 Futbolun En Büyük Sahnesi, 10.20 CLUB BRUGGE - ASTON VILLA, 12.00 AEK - LASK, …) matching the same UCL fixtures the `sporekrani` tabii-spor-1/2/3 fixtures carry. Confirms tvplus id 4399 covers the joint feed; per-feed tabii spor 1-8 detail still comes only from `sporekraniapi`. |

Aggregators worth knowing: `sporekrani.com` carries per-channel pages for
every channel in this file (re-verified live 2026-09-09: `/home/channel/exxen`
renders "Etkinlik Bulunamadı — Önümüzdeki 30 gün içerisinde aradığınız
kriterlere uygun etkinlik bulunmamaktadır"; the legacy
`/tv-yayin-akisi/kanallar/tjk-tv` path renders "Yayın bilgisi bulunamadı").
Empty page ≠ dead channel on an event aggregator — it means no events
scheduled in its 30-day window.  `yayinekrani.com` serves the same data as
sporekrani; `macrehberi.com` keeps parallel per-channel pages (not
re-verified here — treat macrehberi claims below as stale until re-checked).

## Channels with no working source

| Channel | Sources tried | Result |
| --- | --- | --- |
| ~~BeIN Sports 5~~ | ~~beinsports.com.tr~~ (no 5), ~~digiturk.com.tr~~ (Azure WAF 403 on every path, even with `--browser --stealth`) | **NOW COVERED** via `digiturkburada` — static per-channel pages with real match titles. |
| ~~BeIN Sports Max 1~~ | ~~digiturk.com.tr~~ (403) | **NOW COVERED** via `digiturkburada`. |
| ~~BeIN Sports Max 2~~ | ~~digiturk.com.tr~~ (403) | **NOW COVERED** via `digiturkburada`. |
| ~~S Sport Plus~~ | ~~ssportplus.com.tr~~ (timeout / TLS drop — wrong domain, the real one is `.com`) | **NOW COVERED** via the active `sporekraniapi` provider (day-scoped Spor Ekranı API, start-only slots bounded at midnight).  The official `ssportplus.com/yayin-akisi/` page also renders a schedule (re-verified live 2026-09-09: dated day chips 9–15 Eylül with timed rows, e.g. MotoGP practice sessions, FIBA Women's World Cup, LaLiga/Serie A/Bundesliga) — it was kept out of the pipeline as a *second* source for the same feed, not for data-quality reasons (no data-quality defect is evidenced in the repo). (`ssport.tv` TLS failure not re-verified 2026-09-09.) |
| ~~Tivibu Spor~~ | ~~not previously configured~~ | **NOW COVERED** via the `tivibu` provider (`/kanallar/tivibu-spor`, live probe 2026-10-13: 19 programme slots). |
| ~~Tivibu Spor 1~~ | ~~tivibu.com.tr/yayin-akisi~~ (404 — old path; the new site moved to `/kanallar/<slug>`) | **NOW COVERED** via the `tivibu` provider (first-party JSON API, explicit start/stop). |
| ~~Tivibu Spor 2~~ | ~~tivibu.com.tr/yayin-akisi~~ (404 — old path) | **NOW COVERED** via the `tivibu` provider (fixture 2026-09-09: 5× "Tivibu Spor Tanıtım" promo loop, emitted as-is — idle feed, not a failure). |
| ~~Tivibu Spor 3~~ | ~~tivibu.com.tr/yayin-akisi~~ (404 — old path) | **NOW COVERED** via the `tivibu` provider (fixture 2026-09-09: 5× promo loop, same as Spor 2). |
| ~~Tivibu Spor 4~~ | ~~tivibu.com.tr/yayin-akisi~~ (404 — old path) | **NOW COVERED** via the `tivibu` provider (fixture 2026-09-09: 5× promo loop, same as Spor 2). |
| Smart Spor 1 | smartspor.com.tr (no response — not re-verified 2026-09-09), sporekrani.com/home/channel/smart-spor-1 | Re-verified live 2026-09-09: aggregator page exists but renders "Etkinlik Bulunamadı — Önümüzdeki 30 gün içerisinde aradığınız kriterlere uygun etkinlik bulunmamaktadır". "Looks defunct" is an inference from the empty window, not a verified shutdown — treat as no-current-events unless a future scrape shows data. |
| Smart Spor 2 | smartspor.com.tr (not re-verified), sporekrani.com/home/channel/smart-spor-2 (not re-fetched 2026-09-09) | Same status as Smart Spor 1 by analogy only — smart-spor-2 page not re-verified; do not claim emptiness without fetching it. Likely no-current-events. |
| ~~iDMAN TV~~ | ~~idmantv.com.tr~~ (dead domain) | **NOW COVERED** via the `idmantv` provider (`idmantv.az/az/program`, fixture 2026-09-07: static weekly page, one fetch = 7 days, Azerbaijani titles; 133 programme rows in the fixture). |
| TJK TV (TAY TV) | tjktv.org.tr (no response), tjk.org/TR/Kurumsal/Query/Page/YayinAkisi, sporekrani.com legacy path `/tv-yayin-akisi/kanallar/tjk-tv`, tvyayinakisi.com/tjk-tv-yayin-akisi/ | tjk.org's Yayın Akışı page is live but data loads via an AJAX query (empty on plain fetch — needs the underlying API + `--browser`); the legacy sporekrani path renders "Yayın bilgisi bulunamadı" (re-verified live 2026-09-09); tvyayinakisi.com not re-verified. Still no scrapeable EPG. |
| NBA TV | nba.com/tv (404) | Aggregator coverage not re-verified (macrehberi page not fetched 2026-09-09; sporekrani NBA TV page not fetched either). Off-season hypothesis stands but is unconfirmed — re-check at season start (October) on sporekrani/macrehberi. |
| ~~Tabii Spor 1~~ | ~~tabii.com~~ (live pages 404), ~~tvplus.com.tr~~ (only the joint "tabii spor" feed, id 4399) | **NOW COVERED** via `sporekraniapi` (`sporekrani` SSR fixture: 5 UCL events 08–10.09.2026). |
| ~~Tabii Spor 2~~ | tabii.com, tvplus.com.tr | **NOW COVERED** via `sporekraniapi` (`sporekrani` SSR fixture: 3 UCL events 08–10.09.2026). |
| ~~Tabii Spor 3~~ | tabii.com, tvplus.com.tr | **NOW COVERED** via `sporekraniapi` (`sporekrani` SSR fixture: 2 UCL events 08/10.09.2026). |
| ~~Tabii Spor 4~~ | tabii.com, tvplus.com.tr | **NOW COVERED** via `sporekraniapi` (`sporekrani` SSR fixture: empty page 2026-09-08 — idle off-event, empty result is correct). |
| ~~Tabii Spor 5~~ | tabii.com, tvplus.com.tr | **NOW COVERED** via `sporekraniapi` (idle off-event — no 2026-09-08 fixture; only spor 1-4 have fixtures). |
| ~~Tabii Spor 6~~ | tabii.com, tvplus.com.tr | **NOW COVERED** via `sporekraniapi` (idle off-event — no 2026-09-08 fixture). |
| ~~Tabii Spor 7~~ | tabii.com, tvplus.com.tr | **NOW COVERED** via `sporekraniapi` (idle off-event — no 2026-09-08 fixture). |
| ~~Tabii Spor 8~~ | tabii.com, tvplus.com.tr | **NOW COVERED** via `sporekraniapi` (idle off-event — no 2026-09-08 fixture). |
| CBC Sport | official `cbcsport.az/teleproqram/` only | **NO PROVIDER YET** — live page carries no static schedule rows (re-verified 2026-09-09); needs `--browser` verification. Un-struck: the old strikethrough implied coverage that does not exist. |
| ~~GS TV~~ | ~~gstv.com.tr/yayin-akisi~~ (no response) | **NOW COVERED** via `digiturkburada` (fixture `gs-tv-2026-09-08.html`: 15 programmes). |
| Exxen TV / Exxen Sports 1-8 | exxen.com (CMS `LiveChannel` filter + canlı-TV list + sitemaps), the Exxen EPG backend `global-epg-dev.erstream.com` / `global-epg-prod.erstream.com`, `sporekrani.com/home/channel/exxen[-tv]`, `macrehberi.com/kanal/exxen`, `beyazelma78.com/kanal/exxen-spor`, `tvplus.com.tr/canli-tv/yayin-akisi/exxen-tv--4330` | **NO LINEAR CHANNEL / NO PUBLIC EPG** (exhaustively re-probed 2026-10-16). Exxen's own platform carries only **TV8** (cmsId 1315243) and **TV8,5** (1340062) as live channels — the `Exxen + Reklamsız[ + Spor]` CMS entries are subscription *packages*, not channels, and no Exxen-branded linear channel exists in the CMS, the canlı-TV list, or the sitemaps (`livechannel-tr.xml` lists only those two). Exxen's daily-guide UI is served by Erstream's EPG service (`servicesConfig.contentConfig.epg` = `global.epg.erstream` → `https://global-epg-dev.erstream.com`, `apiKey: null`), which returns **only hourly placeholders** (`name:"Program bilgisi bulunmuyor."`, `statusCode:300`) for any `cmsId`/`channelId`/`date` on both the dev host and the prod mirror `global-epg-prod.erstream.com`; `GET /Channel/GetChannels` is HTTP 204 (empty) and the live-channel custom fields carry `HasReverseEpg=false` with no EPG payload. The aggregators that list "Exxen" show no events: `sporekrani` and `macrehberi` `/kanal/exxen` render an empty event list (`common.events: []`), and Spor Ekranı's Exxen channels (783 Exxen, 991 Exxen TV, 1113 Exxenspor YouTube) carry zero events across every sampled day. The TV+ `exxen-tv--4330` SEO URL is a broken/undefined page (TV+ `ChannelList` has no Exxen). Exxen streams live sports as one-off in-app event cards (only 2 `LiveEvent`s exist, both past friendlies), not as a scheduled linear feed. |

## Likely next steps (in rough order of effort)

1. **CBC Sport** — verify `cbcsport.az/teleproqram/` renders under
   `--browser`; if the schedule is there, it is one more small provider.
2. **TJK TV (TAY TV)** — reverse-engineer the AJAX query behind
   `tjk.org/TR/Kurumsal/Query/Page/YayinAkisi` (medium effort; the page
   itself loads no data server-side).
3. **NBA TV / Smart Spor** — NBA TV coverage was not re-verified — re-check
   at season start (October) on sporekrani/macrehberi. Smart Spor 1's
   aggregator page is live but empty (re-verified 2026-09-09); smart-spor-2
   not re-verified — "defunct" is an inference, not a verified shutdown.
   Would need a licensed/aggregated data source (e.g. a commercial EPG
   provider) rather than a scraper.
   **Exxen is now closed out as unscrapeable** (re-probed 2026-10-16): it
   publishes no Exxen-branded linear channel and its own EPG service returns
   only placeholders, so there is no public schedule to scrape — see the
   Exxen row above.

## Notes for future work

- The **TV+ JSON API** (`POST /EPG/JSON/PlayBillList`) returns full-day
  schedules for any channel id TV+ carries — if a channel above appears on
  TV+ later, adding it is one row in `src/providers/tvplus.js` `CHANNELS`.
  The platform's full channel universe was enumerated live on 2026-09-09
  via `POST {apiBase}/EPG/JSON/ChannelList` (body
  `{"fromIndex":"0","toIndex":"200"}`, after the same
  get-platform-info → Authenticate handshake PlayBillList needs): it
  carries exactly **171 entries** — the 154 channels of the public
  `tvplus.com.tr/canli-tv` directory, the "TV+" promo channel (id 177,
  8 promo slots/day, no provider serves it), and 16 VOD genre
  rails (FANTASTİK DÜNYALAR, SAVAŞ FİLMLERİ, … ids 2004–2439) whose
  PlayBillList responses are empty.  **None of the channels above
  (beIN Sports 1-5/Max, S Sport Plus, Smart Spor 1-2, Tivibu Spor and 1-4,
  tabii spor 1-8, GS TV, iDMAN TV, TJK TV, NBA TV, CBC Sport, Exxen*)
  is carried** — unknown ids (1, 4, 9, 33, 150, 200, 4395, 4397, 4398,
  4401, 4402, …) also return `{"counttotal":"0","playbilllist":[]}`, so
  there is no hidden EPG beyond the directory.  Re-probe after any TV+
  lineup change with the ChannelList call above; a new sports channel
  would then need its display name + curated id in `CHANNELS`.
- beinsports.com.tr's embedded `activeLeagues` array is the source of truth
  for which beIN feeds are public — check it when BeIN Sports 5 appears.
- **tabii spor 1-8 are match-day simulcast channels** — most days most of
  them carry nothing, so an empty `sporekraniapi` result for a given
  channel/day is correct, not a scrape failure.
- **Spor Ekranı publishes event start times only** — `sporekraniapi` derives
  stops from the next start for the same channel inside that day's response
  and uses midnight for the final start. The retained `sporekrani` SSR
  baseline chains across its rolling multi-day list and is not used in CI.
  The same site (and its data mirror `yayinekrani.com`) keeps pages for every
  channel in this file, so it is worth re-probing when a channel's status
  changes. (`macrehberi.com` parallels re-checked 2026-10-16: its
  `/kanal/exxen` page carries an empty `common.events` list, matching
  sporekrani.)
- **Exxen's own EPG backend is a stub** (verified 2026-10-16).  Its
  daily-guide UI calls the Erstream service named by
  `servicesConfig.contentConfig.epg` (`global.epg.erstream` →
  `https://global-epg-dev.erstream.com`, `apiKey: null`); the client's requests
  are `GET /Epg/GetChannelEpg?key=&cmsId=…&date=…&timezone=…&lang=…`,
  `GET /Epg/GetChannelEpgWithRange?includeEnding=true&fillResponse=true&…` and
  `POST /Epg/GetAllChannelsCurrentShow?cmsId=…`.  Every one returns only
  hourly placeholders (`name:"Program bilgisi bulunmuyor."`, `statusCode:300`)
  for any channel, on both the `-dev` host and the prod mirror
  `global-epg-prod.erstream.com`; `GET /Channel/GetChannels` is HTTP 204 and no
  service key is populated (`apiKey: null`).  A logged-in Exxen session would
  not help — the service holds no EPG data at all.  Only TV8 / TV8,5 are live
  channels on the platform, and both are already covered by `tvplus`
  (`TV8.tr`, `TV85.tr`).
- **Tivibu Spor 2-4 were idle in the fixtures** (2026-09-09: repeating "Tivibu
  Spor Tanıtım" promo loop, 5 slots each); Tivibu Spor 1 carries the real
  content in the fixtures.  The `tivibu` provider emits the promo slots as-is
  — they are what the channel actually airs, and merge/dedupe keeps the guide
  clean.
- **Tivibu's API needs an ASP.NET antiforgery session** (cookie + hidden
  input token + channel code from the page) before any `GetPrevueList` POST;
  the provider refreshes the session per channel on every run.
- **idmantv publishes one static Mon–Sun week** — a single fetch of
  `idmantv.az/az/program` covers all seven days; dates outside the
  published week are skipped with a warning (no server-side week
  navigation).  Programme titles are Azerbaijani, and the site occasionally
  appends a stray cross-channel note (e.g. "Mədəniyyət TV", "AZTV") to the
  last Sunday slots — emitted verbatim.  **Baku offset caveat:** the site's
  wall times are Baku time (UTC+4 year-round in 2026 — Azerbaijan abolished
  DST in 2016), and the provider stamps them with the fixed `+04:00`, so
  emitted instants match the source times. A merged guide legitimately
  carries both `+03:00` and `+04:00` stamps; compare instants, not strings.
- **idmantv's channel id** `IDMANTV.tr` is curated in
  `src/providers/idmantv.js`; its `CHANNEL_ID_MAP` maps both "İdman TV" and the
  site's "İDMAN TELEVİZİYASI" heading onto it.
- **Swedish channels outside tv.nu** (probed 2026-09-17 when the `tvnu`
  provider landed — no such channel page, HTTP 404): TV4 Nyheterna
  (`/kanal/tv4-nyheterna`), Dagens Industri TV (`/kanal/di-tv`,
  `/kanal/dagens-industri`), Barnmusik, Disney Junior
  (`/kanal/disney-junior`), Discovery World (`/kanal/discovery-world`),
  Food Network (`/kanal/food-network`) and BBC First (`/kanal/bbc-first`).
  The `tvnu` provider covers 69 Swedish/Nordic channels, including the TV4
  and Viaplay/V Sport sports blocks; those seven need another source
  (or do not exist as linear tv.nu feeds) before they can be scraped.
  Additionally, V Sport Fotboll (`[VIAFOHD].V.Sport.Fotboll.HD.se` upstream)
  has no tv.nu channel page — 7 spellings probed 2026-09-17 (`v-fotboll`,
  `v-sport-fotboll`, `v-sport-fotboll-hd`, `viasat-fotboll`,
  `viasat-fotboll-hd`, `viasat-sport-fotboll`, `viaplay-fotboll`), all
  HTTP 404 — and the user-listed "V Ultra" and "Viaplay Sport 1 / Extra /
  Premium / Football / Golf / Motor / Vinter" numbered variants do not exist
  on tv.nu (tv.nu carries the combined `viaplay-sport` feed; football,
  golf and motor ride V Sport Fotboll/Golf/Motor).
- All uncovered channels stay unmapped; when a source lands, add its display
  name + final-form id (`TRTCOCUK.tr`, `TRTSPORT1.tr`, …) to the provider's
  `CHANNEL_ID_MAP` and let `test/channel-id.test.mjs` prove the map is
  canonical and collision-free.
