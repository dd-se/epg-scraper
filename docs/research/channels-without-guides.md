# Channels the playlist ships that no guide served — findings

**Date:** 2026-10-13 · **Scope:** the eleven catalog channels recorded in
`CATALOG_EPG_GAPS` (`src/m3u/channels.js`)

This is the research note the gap list points at. It records what each provider
actually lists. **Update:** checking by display name rather than by id found that
four of the eleven were served after all — mynet lists Baby TV, Discovery
Channel, Minika Go and Nickelodeon (as `NICKELODEON SD`) — and they are now
curated in mynet, which took the gap list from eleven to seven and made the
shipped alias map unnecessary. The findings and reasoning below are kept as
written, with the corrections appended.

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

## The four the gap list got wrong (and how the check missed them)

All four are served by mynet, with real programme slots. Three of the four were
missed because they reach the guide through the **generic-slug fallback** rather
than a curated id, so an id-based comparison could not see them; one was missed
because the source spells it `MİNİKAGO`, whose Turkish dotted capital
survives a naive fold.

| Channel | mynet slug | mynet display name | Slots today | Fallback id | Catalog id |
| --- | --- | --- | --- | --- | --- |
| Baby TV | `baby-tv` | BABY TV | 287 | `BABYTV.tr` | `babytv.tr` — matched |
| Discovery Channel | `discovery-channel` | DISCOVERY CHANNEL | 31 | `DISCOVERYCHANNEL.tr` | `discoverychannel.tr` — matched |
| Minika Go | `minikago` | MİNİKAGO | 232 | `MNKAGO.tr` | `minika.go.tr` — mismatched |
| Nickelodeon | `nickelodeon-sd` | NICKELODEON SD | 93 | `NICKELODEONSD.tr` | `nickelodeon.tr` — mismatched |

### Applied

All four are now curated in mynet's `CHANNEL_ID_MAP`, so their ids are
final-form (`BABYTV.tr`, `DISCOVERYCHANNEL.tr`, `MINIKAGO.tr`,
`NICKELODEON.tr`), and the four gap entries are gone. For Minika Go and
Nickelodeon this **changes the published id** (the fallback spellings were
mismatched); for Baby TV and Discovery Channel the id is unchanged, only now
curated.

### The lesson: compare by channel, not by id

Two checks had to be made name-based to get a true answer — one against each
live guide's display names, one across the providers' curated maps
(`test/channel-id.test.mjs`). Matching ids alone answers "is this spelling
curated?", which is not the question; "does a guide serve this channel at all?"
was the question, and the `SD`/`MİNİKAGO` qualifiers hid the answer.

### A second same-channel disagreement, found on the way

The cross-provider check also caught **TV2**: hurriyet publishes TV2 and teve2 as
separate rows carrying byte-identical schedules on every day of the week, and
collapses them onto `TEVE2.tr`; mynet curated the same row as `TV2.tr`. Both now
pin the pair to `TEVE2.tr`, which is what removed the last entry in the shipped
alias map.

## Caveats

- A live snapshot: a source can add or drop a channel between runs, so re-check
  before acting on a single observation. The two findings above were confirmed
  by parsing actual programme slots, not just a channel card.
- hurriyet's inventory is the union over its seven day pages for the requested
  window; mynet's is one day's index.

## TV+ probe follow-up (2026-10-13, later the same day)

A full `ChannelList` probe found 155 channels with programme data, of which TV+
now curates 70.  Comparing the shared channels slot-by-slot against the live
hürriyet guide settled the accuracy question: titles agree 89–100% on 24 of the
26 shared channels, and the residual difference is boundary handling (tvplus
returns the tail of the previous day's programme where hürriyet shows a repeats
block).  Details: `docs/research/tvplus-lineup.md`.
