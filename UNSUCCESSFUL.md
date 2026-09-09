# Unsuccessful channels — to fix later

This file tracks the sports-channel list entries that the current providers
could **not** scrape (as of 2026-09-09), the source(s) tried, and why they
failed.  Each entry is a fix-me note: the channel either needs a different
source, login/auth flow, or a bespoke scraper to be built later.
Statements about live sites below were re-verified on 2026-09-09 unless a
fixture/test is cited instead.

Covered today (37 channels):

| Provider | Channels |
| --- | --- |
| `tvplus` | TRT 1, TRT Spor, TRT Spor Yıldız, A Spor, HT Spor, FB TV, tabii spor, S Sport, S Sport 2, Eurosport 1, Eurosport 2, Sports TV, ATV, TV8, TV8,5, A2 |
| `beinsports` | beIN Sports 1, beIN Sports 2, beIN Sports 3, beIN Sports 4 |
| `digiturkburada` | beIN Sports 5, beIN Sports Max 1, beIN Sports Max 2, GS TV |
| `sporekrani` | tabii spor 1, tabii spor 2, tabii spor 3, tabii spor 4, tabii spor 5, tabii spor 6, tabii spor 7, tabii spor 8, S Sport Plus |
| `tivibu` | Tivibu Spor 1, Tivibu Spor 2, Tivibu Spor 3, Tivibu Spor 4 |

Run all five and merge into one guide:

```bash
node bin/epg-scraper.js --provider tvplus,beinsports,digiturkburada,sporekrani,tivibu --merge
```

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
  + DRM) and S Sport Plus is a D-Smart-only premium feed.  Both are now
  covered via the `sporekrani` provider (`sporekrani.com/home/channel/...`),
  an aggregator that publishes event start times for both — see the caveats
  below (events-only stops; simulcast channels are empty on non-match days).
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
| `sporekrani.com/home/channel/tabii-spor-{1..8}` | tabii spor 1-8 | **IMPLEMENTED** as the `sporekrani` provider (rolling multi-day event list — 5/3/2/0 events for spor 1/2/3/4 in the 2026-09-08 fixtures; events-only, stops derive from the next event; only channels with scheduled simulcast events carry entries — an empty result is correct, not a failure). |
| `sporekrani.com/home/channel/s-sport-plus` | S Sport Plus | **IMPLEMENTED** as the `sporekrani` provider (rolling multi-day event list — 120 events over 14 distinct days in the 2026-09-08 fixture, incl. FIBA Women's World Cup, Saudi Pro League, Bundesliga/Serie A/La Liga, MotoGP practice sessions; events-only, stops derive from the next event). |
| `tivibu.com.tr/kanallar/tivibu-spor-{1,2,3,4}` | Tivibu Spor 1-4 | **IMPLEMENTED** as the `tivibu` provider (session GET for cookie/token/channel-code, then `POST /Channel/GetPrevueList` per channel-day; explicit start/stop, any date).  Spor 2-4 carry only a repeating "Tivibu Spor Tanıtım" promo loop in the 2026-09-09 fixtures (5 slots each, emitted as-is).  The general grid `tivibu.com.tr/canli-tv/spor` (re-verified live 2026-09-09: date chips 02–16.09.2026 plus Dün/Bugün/Yarın, per-slot `start → stop` ranges for the same four channels) uses the same backend but the provider drives the per-channel `/kanallar/<slug>` pages + `GetPrevueList` API directly. |
| `idmantv.az/az/program` | iDMAN TV | Candidate — re-verified live 2026-09-09: static SSR weekly programme "Həftənin bütün günlərinin TV proqramları (07.09.2026 - 13.09.2026)" with HH:MM start times per weekday (Bazar ertəsi / 07.09.2026, Ç. axşamı / 08.09.2026, … Bazar / 13.09.2026), Azerbaijani titles, no login wall. No provider yet. (The old `idmantv.com.tr` domain is dead; the real site is `idmantv.az`.) |
| `cbcsport.az/teleproqram/` | CBC Sport | Re-check result (2026-09-09): page is live (165 KB HTML) but the fetched markup contains the `Teleproqram` heading/nav and news/verilişler lists with **no dated programme rows** — schedule content is not in the static HTML (JS-rendered or auth-gated: page also embeds a login form "Sizin hesabınıza daxil"). Still needs `--browser` verification before trusting it; the old "no TR feed page found" note is dropped (there is exactly one CBC Sport feed; the strikethrough was misleading). |
| `trt.net.tr/yayin-akisi` | tabii spor (joint TRT feed, already via tvplus) | First-party sanity check, re-verified live 2026-09-09: the page renders full dated grids for TRT 1/2/Belgesel/Haber/Spor/Spor Yıldız/Çocuk/… **and** a "Tabii Spor Yayın Akışı" grid (09.30 Futbolun En Büyük Sahnesi, 10.20 CLUB BRUGGE - ASTON VILLA, 12.00 AEK - LASK, …) matching the same UCL fixtures the `sporekrani` tabii-spor-1/2/3 fixtures carry. Confirms tvplus id 4399 covers the joint feed; per-feed tabii spor 1-8 detail still comes only from `sporekrani`. |

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
| ~~S Sport Plus~~ | ~~ssportplus.com.tr~~ (timeout / TLS drop — wrong domain, the real one is `.com`) | **NOW COVERED** via the `sporekrani` provider (rolling event list, events-only).  The official `ssportplus.com/yayin-akisi/` page also renders a schedule (re-verified live 2026-09-09: dated day chips 9–15 Eylül with timed rows, e.g. MotoGP practice sessions, FIBA Women's World Cup, LaLiga/Serie A/Bundesliga) — it was kept out of the pipeline as a *second* source for the same feed, not for data-quality reasons (no data-quality defect is evidenced in the repo). (`ssport.tv` TLS failure not re-verified 2026-09-09.) |
| ~~Tivibu Spor 1~~ | ~~tivibu.com.tr/yayin-akisi~~ (404 — old path; the new site moved to `/kanallar/<slug>`) | **NOW COVERED** via the `tivibu` provider (first-party JSON API, explicit start/stop). |
| ~~Tivibu Spor 2~~ | ~~tivibu.com.tr/yayin-akisi~~ (404 — old path) | **NOW COVERED** via the `tivibu` provider (fixture 2026-09-09: 5× "Tivibu Spor Tanıtım" promo loop, emitted as-is — idle feed, not a failure). |
| ~~Tivibu Spor 3~~ | ~~tivibu.com.tr/yayin-akisi~~ (404 — old path) | **NOW COVERED** via the `tivibu` provider (fixture 2026-09-09: 5× promo loop, same as Spor 2). |
| ~~Tivibu Spor 4~~ | ~~tivibu.com.tr/yayin-akisi~~ (404 — old path) | **NOW COVERED** via the `tivibu` provider (fixture 2026-09-09: 5× promo loop, same as Spor 2). |
| Smart Spor 1 | smartspor.com.tr (no response — not re-verified 2026-09-09), sporekrani.com/home/channel/smart-spor-1 | Re-verified live 2026-09-09: aggregator page exists but renders "Etkinlik Bulunamadı — Önümüzdeki 30 gün içerisinde aradığınız kriterlere uygun etkinlik bulunmamaktadır". "Looks defunct" is an inference from the empty window, not a verified shutdown — treat as no-current-events unless a future scrape shows data. |
| Smart Spor 2 | smartspor.com.tr (not re-verified), sporekrani.com/home/channel/smart-spor-2 (not re-fetched 2026-09-09) | Same status as Smart Spor 1 by analogy only — smart-spor-2 page not re-verified; do not claim emptiness without fetching it. Likely no-current-events. |
| iDMAN TV | ~~idmantv.com.tr~~ (dead domain) | **SOURCE FOUND, NO PROVIDER YET** — official weekly programme at `idmantv.az/az/program` (re-verified live 2026-09-09, see "New sources" row above). |
| TJK TV (TAY TV) | tjktv.org.tr (no response), tjk.org/TR/Kurumsal/Query/Page/YayinAkisi, sporekrani.com legacy path `/tv-yayin-akisi/kanallar/tjk-tv`, tvyayinakisi.com/tjk-tv-yayin-akisi/ | tjk.org's Yayın Akışı page is live but data loads via an AJAX query (empty on plain fetch — needs the underlying API + `--browser`); the legacy sporekrani path renders "Yayın bilgisi bulunamadı" (re-verified live 2026-09-09); tvyayinakisi.com not re-verified. Still no scrapeable EPG. |
| NBA TV | nba.com/tv (404) | Aggregator coverage not re-verified (macrehberi page not fetched 2026-09-09; sporekrani NBA TV page not fetched either). Off-season hypothesis stands but is unconfirmed — re-check at season start (October) on sporekrani/macrehberi. |
| ~~Tabii Spor 1~~ | ~~tabii.com~~ (live pages 404), ~~tvplus.com.tr~~ (only the joint "tabii spor" feed, id 4399) | **NOW COVERED** via the `sporekrani` provider (fixture: 5 UCL events 08–10.09.2026). |
| ~~Tabii Spor 2~~ | tabii.com, tvplus.com.tr | **NOW COVERED** via the `sporekrani` provider (fixture: 3 UCL events 08–10.09.2026). |
| ~~Tabii Spor 3~~ | tabii.com, tvplus.com.tr | **NOW COVERED** via the `sporekrani` provider (fixture: 2 UCL events 08/10.09.2026). |
| ~~Tabii Spor 4~~ | tabii.com, tvplus.com.tr | **NOW COVERED** via the `sporekrani` provider (fixture: empty page 2026-09-08 — idle off-event, empty result is correct). |
| ~~Tabii Spor 5~~ | tabii.com, tvplus.com.tr | **NOW COVERED** via the `sporekrani` provider (idle off-event — no 2026-09-08 fixture; only spor 1-4 have fixtures). |
| ~~Tabii Spor 6~~ | tabii.com, tvplus.com.tr | **NOW COVERED** via the `sporekrani` provider (idle off-event — no 2026-09-08 fixture). |
| ~~Tabii Spor 7~~ | tabii.com, tvplus.com.tr | **NOW COVERED** via the `sporekrani` provider (idle off-event — no 2026-09-08 fixture). |
| ~~Tabii Spor 8~~ | tabii.com, tvplus.com.tr | **NOW COVERED** via the `sporekrani` provider (idle off-event — no 2026-09-08 fixture). |
| CBC Sport | official `cbcsport.az/teleproqram/` only | **NO PROVIDER YET** — live page carries no static schedule rows (re-verified 2026-09-09); needs `--browser` verification. Un-struck: the old strikethrough implied coverage that does not exist. |
| ~~GS TV~~ | ~~gstv.com.tr/yayin-akisi~~ (no response) | **NOW COVERED** via `digiturkburada` (fixture `gs-tv-2026-09-08.html`: 15 programmes). |
| Exxen TV | exxen.com (200 but 2.4 KB JS shell, login-walled), sporekrani.com/home/channel/exxen | Re-verified live 2026-09-09: aggregator page exists and renders "Etkinlik Bulunamadı — Önümüzdeki 30 gün içerisinde aradığınız kriterlere uygun etkinlik bulunmamaktadır". Exxen is a subscription streaming service; the EPG lives behind authentication. Empty aggregator page is consistent with no linear sports scheduled, not proof of death. |
| Exxen Sports 1 | exxen.com, sporekrani.com/home/channel/exxen-sports-1 | Re-verified live 2026-09-09: aggregator page exists but renders "Etkinlik Bulunamadı — Önümüzdeki 30 gün içerisinde aradığınız kriterlere uygun etkinlik bulunmamaktadır" (empty window, not proof of login-wall). exxen.com itself (JS shell) not re-fetched 2026-09-09. Same as Exxen TV above. |
| Exxen Sports 2 | exxen.com | Login-walled, same as above (aggregator page not re-verified 2026-09-09 — do not claim emptiness without fetching it). |
| Exxen Sports 3 | exxen.com | Login-walled, same as above (aggregator page not re-verified). |
| Exxen Sports 4 | exxen.com | Login-walled, same as above (aggregator page not re-verified). |
| Exxen Sports 5 | exxen.com | Login-walled, same as above (aggregator page not re-verified). |
| Exxen Sports 6 | exxen.com | Login-walled, same as above (aggregator page not re-verified). |
| Exxen Sports 7 | exxen.com | Login-walled, same as above (aggregator page not re-verified). |
| Exxen Sports 8 | exxen.com | Login-walled, same as above (aggregator page not re-verified). |

## Likely next steps (in rough order of effort)

1. **iDMAN TV** — `idmantv.az/az/program` is a static weekly page; a small
   parser turns it into 7 days of programmes (Azerbaijani titles).
2. **CBC Sport** — verify `cbcsport.az/teleproqram/` renders under
   `--browser`; if the schedule is there, it is one more small provider.
3. **TJK TV (TAY TV)** — reverse-engineer the AJAX query behind
   `tjk.org/TR/Kurumsal/Query/Page/YayinAkisi` (medium effort; the page
   itself loads no data server-side).
4. **Exxen / NBA TV / Smart Spor** — Exxen's aggregator pages are live but
   show an empty 30-day window (re-verified 2026-09-09 for `exxen` and
   `exxen-sports-1`); exxen.com itself is login-walled. NBA TV coverage was
   not re-verified — re-check at season start (October) on
   sporekrani/macrehberi. Smart Spor 1's aggregator page is live but empty
   (re-verified 2026-09-09); smart-spor-2 not re-verified — "defunct" is an
   inference, not a verified shutdown.  Would need a licensed/aggregated data
   source (e.g. a commercial EPG provider) rather than a scraper.

## Notes for future work

- The **TV+ JSON API** (`POST /EPG/JSON/PlayBillList`) returns full-day
  schedules for any channel id TV+ carries — if a channel above appears on
  TV+ later, adding it is one row in `src/providers/tvplus.js` `CHANNELS`.
- beinsports.com.tr's embedded `activeLeagues` array is the source of truth
  for which beIN feeds are public — check it when BeIN Sports 5 appears.
- **tabii spor 1-8 are match-day simulcast channels** — most days most of
  them carry nothing, so an empty `sporekrani` result for a given
  channel/day is correct, not a scrape failure.
- **sporekrani publishes event start times only** — the provider derives
  stops from the next event on the page (24:00 for the last), matching the
  beinsports/mynet/digiturkburada convention.  The same site (and its data
  mirror `yayinekrani.com`) keeps pages for every channel in this file, so it
  is worth re-probing when a channel's status changes. (`macrehberi.com`
  parallels not re-verified 2026-09-09.)
- **Tivibu Spor 2-4 were idle in the fixtures** (2026-09-09: repeating "Tivibu
  Spor Tanıtım" promo loop, 5 slots each); Tivibu Spor 1 carries the real
  content in the fixtures.  The `tivibu` provider emits the promo slots as-is
  — they are what the channel actually airs, and merge/dedupe keeps the guide
  clean.
- **Tivibu's API needs an ASP.NET antiforgery session** (cookie + hidden
  input token + channel code from the page) before any `GetPrevueList` POST;
  the provider refreshes the session per channel on every run.
- All uncovered channels keep their epgshare01-style ids unmapped; when a
  source lands, add the id to `CHANNEL_ID_MAP` and (if missing upstream)
  to `knownGaps` in `test/fixtures/epgshare01/reference.json`.