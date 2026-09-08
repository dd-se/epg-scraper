# Unsuccessful channels — to fix later

This file tracks the sports-channel list entries that the current providers
could **not** scrape (as of 2026-09-08), the source(s) tried, and why they
failed.  Each entry is a fix-me note: the channel either needs a different
source, login/auth flow, or a bespoke scraper to be built later.

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
| `sporekrani.com/home/channel/tabii-spor-{1..8}` | tabii spor 1-8 | **IMPLEMENTED** as the `sporekrani` provider (30-day event list; events-only, stops derive from the next event; 1-3 carry events on UCL match days, 4-8 are usually empty — correct, they are simulcast feeds). |
| `sporekrani.com/home/channel/s-sport-plus` | S Sport Plus | **IMPLEMENTED** as the `sporekrani` provider (30-day list incl. MotoGP practice sessions etc.). |
| `tivibu.com.tr/kanallar/tivibu-spor-{1,2,3,4}` (+ the all-sports grid `tivibu.com.tr/canli-tv/spor`, which has date navigation and per-slot `start → stop`) | Tivibu Spor 1-4 (and Tivibu Spor) | **IMPLEMENTED** as the `tivibu` provider (session GET for cookie/token/channel-code, then `POST /Channel/GetPrevueList` per channel-day; explicit start/stop, any date).  Spor 2-4 often carry only a repeating "Tivibu Spor Tanıtım" promo loop (idle feeds) — those slots are emitted as-is. |
| `idmantv.az/az/program` | iDMAN TV | Candidate.  Official weekly programme (7 days, HH:MM starts, Azerbaijani titles).  The dead `idmantv.com.tr` is gone; İdman TV's real site is `idmantv.az`. |
| `cbcsport.az/teleproqram/` | CBC Sport | Promising.  First-party teleproqram page is live but the schedule did not render in a plain fetch (JS-rendered — needs `--browser` verification before trusting it). |
| `trt.net.tr/yayin-akisi` | tabii spor (joint TRT feed, already via tvplus) | First-party sanity check for the joint feed tvplus already covers. |

Aggregators worth knowing: `sporekrani.com` and `macrehberi.com` both carry
per-channel pages for every channel in this file (Tivibu Spor, tabii Spor,
S Sport Plus, Smart Spor, Exxen, NBA TV, CBC Sport, İdman TV, TJK TV) —
empty page ≠ dead channel, it means no events scheduled in their 30-day
window.  `yayinekrani.com` serves the same data as sporekrani.

## Channels with no working source

| Channel | Sources tried | Result |
| --- | --- | --- |
| ~~BeIN Sports 5~~ | ~~beinsports.com.tr~~ (no 5), ~~digiturk.com.tr~~ (Azure WAF 403 on every path, even with `--browser --stealth`) | **NOW COVERED** via `digiturkburada` — static per-channel pages with real match titles. |
| ~~BeIN Sports Max 1~~ | ~~digiturk.com.tr~~ (403) | **NOW COVERED** via `digiturkburada`. |
| ~~BeIN Sports Max 2~~ | ~~digiturk.com.tr~~ (403) | **NOW COVERED** via `digiturkburada`. |
| ~~S Sport Plus~~ | ~~ssportplus.com.tr~~ (timeout / TLS drop — wrong domain, the real one is `.com`) | **NOW COVERED** via the `sporekrani` provider (30-day list, events-only).  Official `ssportplus.com/yayin-akisi/` also works but has data-quality issues; `ssport.tv` fails TLS verification. |
| ~~Tivibu Spor 1~~ | ~~tivibu.com.tr/yayin-akisi~~ (404 — old path; the new site moved to `/kanallar/<slug>`) | **NOW COVERED** via the `tivibu` provider (first-party JSON API, explicit start/stop). |
| ~~Tivibu Spor 2~~ | tivibu.com.tr/yayin-akisi (404) | **NOW COVERED** via the `tivibu` provider (idle — promo loop emitted as-is). |
| ~~Tivibu Spor 3~~ | tivibu.com.tr/yayin-akisi (404) | **NOW COVERED** via the `tivibu` provider (idle — promo loop emitted as-is). |
| ~~Tivibu Spor 4~~ | tivibu.com.tr/yayin-akisi (404) | **NOW COVERED** via the `tivibu` provider (idle — promo loop emitted as-is). |
| ~~Smart Spor 1~~ | smartspor.com.tr (no response), sporekrani.com/home/channel/smart-spor-1 (page exists) | Page exists on both sporekrani and macrehberi but **no events in 30 days** — the D-Smart channel looks defunct.  Treat as dead unless a future scrape shows data. |
| ~~Smart Spor 2~~ | smartspor.com.tr, sporekrani.com/home/channel/smart-spor-2 | Same as above — empty on every aggregator.  Likely defunct. |
| ~~iDMAN TV~~ | ~~idmantv.com.tr~~ (no public EPG) | **SOURCE FOUND** — official weekly programme at `idmantv.az/az/program` (Azerbaijani; no provider yet). |
| TJK TV (TAY TV) | tjktv.org.tr (no response), tjk.org/TR/Kurumsal/Query/Page/YayinAkisi, sporekrani.com/tv-yayin-akisi/kanallar/tjk-tv, tvyayinakisi.com/tjk-tv-yayin-akisi/ | tjk.org's Yayın Akışı page is live but data loads via an AJAX query (empty on plain fetch — needs the underlying API + `--browser`); both aggregator pages render "yayın akışı bulunamadı".  Still no scrapeable EPG. |
| NBA TV | nba.com/tv (404), macrehberi.com/kanal/nba-tv (page exists) | Aggregator page is empty — NBA season hasn't started (off-season).  Re-check at season start (October); macrehberi/sporekrani may then carry it. |
| ~~Tabi Spor 1~~ | ~~tabii.com~~ (live pages 404), ~~tvplus.com.tr~~ (only the joint "tabii spor" feed, id 4399) | **NOW COVERED** via the `sporekrani` provider (active on UCL match days). |
| ~~Tabi Spor 2~~ | tabii.com, tvplus.com.tr | **NOW COVERED** via the `sporekrani` provider (active on UCL match days). |
| ~~Tabi Spor 3~~ | tabii.com, tvplus.com.tr | **NOW COVERED** via the `sporekrani` provider (active on UCL match days). |
| ~~Tabi Spor 4~~ | tabii.com, tvplus.com.tr | **NOW COVERED** via the `sporekrani` provider (idle off-event — empty result is correct). |
| ~~Tabi Spor 5~~ | tabii.com, tvplus.com.tr | **NOW COVERED** via the `sporekrani` provider (idle off-event). |
| ~~Tabi Spor 6~~ | tabii.com, tvplus.com.tr | **NOW COVERED** via the `sporekrani` provider (idle off-event). |
| ~~Tabi Spor 7~~ | tabii.com, tvplus.com.tr | **NOW COVERED** via the `sporekrani` provider (idle off-event). |
| ~~Tabi Spor 8~~ | tabii.com, tvplus.com.tr | **NOW COVERED** via the `sporekrani` provider (idle off-event). |
| ~~CBC Sport~~ | ~~cbcsport.az~~ (no TR feed page found) | **PROMISING** — official teleproqram at `cbcsport.az/teleproqram/` is live but JS-rendered; needs `--browser` verification. |
| ~~GS TV~~ | ~~gstv.com.tr/yayin-akisi~~ (no response) | **NOW COVERED** via `digiturkburada` (15+ programmes/day with real matches). |
| Exxen TV | exxen.com (200 but 2.4 KB JS shell, login-walled), sporekrani.com/home/channel/exxen (page exists) | Exxen is a subscription streaming service; the EPG lives behind authentication.  Aggregator page is empty — no linear sports scheduled this week. |
| Exxen Sports 1 | exxen.com, sporekrani.com/home/channel/exxen-sports-1 | Login-walled; aggregator page empty.  Same as above. |
| Exxen Sports 2 | exxen.com | Login-walled, same as above. |
| Exxen Sports 3 | exxen.com | Login-walled, same as above. |
| Exxen Sports 4 | exxen.com | Login-walled, same as above. |
| Exxen Sports 5 | exxen.com | Login-walled, same as above. |
| Exxen Sports 6 | exxen.com | Login-walled, same as above. |
| Exxen Sports 7 | exxen.com | Login-walled, same as above. |
| Exxen Sports 8 | exxen.com | Login-walled, same as above. |

## Likely next steps (in rough order of effort)

1. **iDMAN TV** — `idmantv.az/az/program` is a static weekly page; a small
   parser turns it into 7 days of programmes (Azerbaijani titles).
2. **CBC Sport** — verify `cbcsport.az/teleproqram/` renders under
   `--browser`; if the schedule is there, it is one more small provider.
3. **TJK TV (TAY TV)** — reverse-engineer the AJAX query behind
   `tjk.org/TR/Kurumsal/Query/Page/YayinAkisi` (medium effort; the page
   itself loads no data server-side).
4. **Exxen / NBA TV / Smart Spor** — Exxen stays login-walled; NBA TV needs
   a re-check when the season starts (October); Smart Spor looks defunct on
   every aggregator.  Would need a licensed/aggregated data source (e.g. a
   commercial EPG provider) rather than a scraper.

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
  mirror `yayinekrani.com`, plus `macrehberi.com`) keeps pages for every
  channel in this file, so it is worth re-probing when a channel's status
  changes.
- **Tivibu Spor 2-4 are usually idle** (repeating "Tivibu Spor Tanıtım"
  promo loop); only Tivibu Spor 1 typically carries real content.  The
  `tivibu` provider emits the promo slots as-is — they are what the channel
  actually airs, and merge/dedupe keeps the guide clean.
- **Tivibu's API needs an ASP.NET antiforgery session** (cookie + hidden
  input token + channel code from the page) before any `GetPrevueList` POST;
  the provider refreshes the session per channel on every run.
- All uncovered channels keep their epgshare01-style ids unmapped; when a
  source lands, add the id to `CHANNEL_ID_MAP` and (if missing upstream)
  to `knownGaps` in `test/fixtures/epgshare01/reference.json`.