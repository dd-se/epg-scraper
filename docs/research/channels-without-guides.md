# Channels the playlist ships that no guide served — findings

**Date:** 2026-10-13 · **Scope:** the eleven catalog channels recorded in
`CATALOG_EPG_GAPS` (`src/m3u/channels.js`) · **Changes made:** none

This is the research note the gap list points at. Nothing here changed a channel
id, a catalog entry or a published artifact; it only records what each provider
actually lists, so a later decision to serve or drop one of these channels is
made from evidence.

## How this was checked

| Provider | Channel inventory | How |
| --- | --- | --- |
| hurriyet | 30 channels | live guide scraped for the current window; the union of its day-page channel rails |
| mynet | 87 channels | live index parsed with the adapter's own `parseMainPage()` |
| tvplus | 16 channels | live API run for the current day |
| trt | 11 channels | live index parsed with the adapter's own `parseChannelLogos()` |
| beinsports, digiturkburada, tivibu, sporekrani, sporekraniapi, idmantv | 4, 8, 4, 9, 9, 1 | curated closed channel lists in the adapters — sports-only feeds plus one Azerbaijani channel; none can carry a general-interest, children's or documentary channel |
| tvnu | Swedish | different country; not applicable |

Every id below is what the adapter would emit: the curated map first, then the
generic-slug fallback folded at the guide-result seam.

## The nine that no provider lists

Verified **absent** from mynet's live 87-channel index and from hurriyet's live
30-channel guide — not merely spelled differently. None of the curated
sports-only providers can carry them, and TRT's live index serves 11 channels
with no 4K feed.

| Channel | Catalog id | Guide id if served | Verdict |
| --- | --- | --- | --- |
| Show Türk | `showturk.tr` | `SHOWTRK.tr` (note the dropped `ü`) | no provider lists it |
| Show Max | `showmax.tr` | `SHOWMAX.tr` | no provider lists it; Show TV is the only Show-family channel served |
| TV8 Haber | `tv8haber.tr` | `TV8HABER.tr` | no provider lists it; TV8 itself is served |
| TRT 4K | `trt4k.tr` | `TRT4K.tr` | no provider lists it |
| Minika Go | `minika.go.tr` | `MINIKAGO.tr` | no provider lists it |
| Nickelodeon | `nickelodeon.tr` | `NICKELODEON.tr` | no provider lists it |
| Flash TV | `flashtv.tr` | `FLASHTV.tr` | no provider lists it |
| Investigation | `investigation.tr` | `INVESTIGATION.tr` | no provider lists it (nor `Investigation Discovery`) |
| History | `history.tr` | `HISTORY.tr` | no provider lists it |

Serving any of these needs new source work: the fallback path already emits the
right id, so a provider that starts listing the channel would satisfy the
agreement assertion with no curation change at all.

## The two the gap list gets wrong

**`babytv.tr` (Baby TV) and `discoverychannel.tr` (Discovery Channel) are served
by mynet, today, with programme data.** Their two gap entries in
`CATALOG_EPG_GAPS` ("no guide lists Baby TV" / "no guide lists Discovery
Channel") are false and are left in place pending a decision.

Evidence, fetched live on 2026-10-13:

| Channel | mynet slug | Slots parsed for today | Emitted id |
| --- | --- | --- | --- |
| Baby TV | `baby-tv` | 287 | `BABYTV.tr` |
| Discovery Channel | `discovery-channel` | 31 | `DISCOVERYCHANNEL.tr` |

Both ids already equal the catalog ids, and the slots are real, so a viewer
picking either channel from `playlist.m3u` gets NOW/NEXT from the published
mynet guide.

### Why the assertion did not catch it

`test/channel-id.test.mjs` compares the catalog against the **curated** guide
ids (`CHANNEL_ID_MAP` values). These two channels reach the guide through the
generic-slug fallback, which no curated id represents, so the assertion read
them as orphans and the entries were written to silence it. The hole is
documented in the test's own comment: the check covers curation, not coverage.

### The fix, when someone applies it

1. Curate the two ids in mynet's `CHANNEL_ID_MAP` — `'BABY TV': 'BABYTV.tr'`
   and `'DISCOVERY CHANNEL': 'DISCOVERYCHANNEL.tr'`. The values are exactly
   what the fallback already emits, so **no published output changes**; the
   assertion then sees the channels and fails on the stale gap entries.
2. Delete the `babytv.tr` and `discoverychannel.tr` rows from
   `CATALOG_EPG_GAPS`, leaving nine gaps.

## Caveats

- A live snapshot: a source can add or drop a channel between runs, so re-check
  before acting on a single observation. The two findings above were confirmed
  by parsing actual programme slots, not just a channel card.
- hurriyet's inventory is the union over its seven day pages for the requested
  window; mynet's is one day's index.
