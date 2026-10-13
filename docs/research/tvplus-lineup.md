# What TV+ offers, and how accurate it is

**Date:** 2026-10-13 · **Source:** the TV+ (Turkcell) EPG JSON API, probed live
· **Changes made:** yes — the curated lineup and the sports merge (see the
changelog entry); this note records the evidence.

## Method

1. `POST /get-platform-info` → the rotating API base.
2. `POST {base}/EPG/JSON/Authenticate` → session cookie.
3. `POST {base}/EPG/JSON/ChannelList {"fromIndex":"0","toIndex":"400"}` → the
   platform's lineup (172 channels).
4. `POST {base}/EPG/JSON/PlayBillList` for **every one of the 172** channels,
   today, saved to `/tmp/opencode/tvplus-schedules.json`.
5. Compare the 26 channels the platform shares with the live hürriyet guide,
   slot by slot: title and start time.

Raw dumps: `/tmp/opencode/tvplus-channellist.json` (lineup),
`/tmp/opencode/tvplus-schedules.json` (every channel's day), and the two probe
scripts (`pull-tvplus-all.mjs`, `probe-tvplus.mjs`).  Nothing in the repository
depends on them.

## The platform's lineup

| | count |
|---|---|
| channels in `ChannelList` | 172 |
| with programme data | **155** |
| empty (movie-collection VOD rails) | 17 |
| already served by hurriyet / mynet / trt | 65 |
| **new to us** | **90** |

The 17 empty ones are the movie collections (`AVRUPA SİNEMASI`,
`FANTASTİK DÜNYALAR`, …) — the rails the adapter's own comment already noted.

The 90 not previously covered split into a mainstream Turkish set (TRT Diyanet
Çocuk, TRT Genç, TRT EBA, Flash Haber, TURKHABER, Nickelodeon, Nicktoons,
Minika Çocuk, Viasat History, Viasat Explore, Nat Geo Wild, tabii TV, the nine
Sinema channels, Akıt/Dream Türk/Power Türk, 24, TV 4, ON6, GZT, AS TV, KONTV)
and a large international/pay block (BBC News/Earth, France 24 ×2, Al Jazeera
×2, Sky News Arabia, Deutsche Welle, TV5 ×2, CNBC-E, FX, Love Nature, Spacetoon,
BRT 1/2, the Kıbrıs channels, and ~20 regional channels).  Two entries,
`TV+ Keşfet Aksiyon/Drama`, are promo shelves with 771 and 759 slots — a VOD
rail, not a channel.

## Accuracy against hürriyet (26 shared channels)

| channel | hürriyet slots | tvplus slots | titles | starts |
|---|---|---|---|---|
| Cartoon Network, NTV, 360, Habertürk, TV2, TV8, A Haber, Bloomberg HT, Nat Geo, Disney Junior, Beyaz TV, TRT Belgesel | — | — | 100% | 87–100% |
| ATV, NOW, Kanal D, TRT 1, TRT Spor, CNN Türk, DMAX, Show TV, Eurosport 1, Sinema TV, Star TV, TLC | — | — | 89–97% | 82–94% |
| Kanal 7 | — | — | 67% | 92% |
| Sports TV | — | — | 44% | 89% |

Polled at one day, so read the percentages as "of one day's slots". The
agreement is close enough to trust, and the recurring differences are
systematic rather than random:

1. **The overnight carry-over.** tvplus returns 23:00's programme as the first
   slot of the day; hürriyet shows a "Tekrarlar" repeats block. Every shared
   channel is exactly one slot ahead of hürriyet for this reason.
2. **Block granularity.** Show TV's evening block is one 20:00 slot at
   hürriyet and split at 21:45 by tvplus.
3. **±5 min drift.** Kanal 7: 12:40 (hürriyet) vs 12:45 (tvplus).

The two headline outliers are the same effects concentrated. Sports TV's 06:00
slot is "İtalya Erkek Basketbol Ligi" at hürriyet and "İtalya Basketbol Ligi" at
tvplus — the same event; Kanal 7's 67% is the overnight block plus one 5-minute
shift.

## What was curated

70 channels: every channel the platform serves that hurriyet or mynet also
curate (so this provider stands alone for that lineup, which was the point of
the request), plus Viasat History, which closes the playlist catalog's
`history.tr` gap. The ids are the ones the other providers publish — the
cross-provider agreement test in `test/channel-id.test.mjs` fails if two
providers ever curate one channel differently, which is what makes this
mechanical rather than a risk.

Deliberately **not** curated: the 17 empty VOD rails, the two promo shelves, the
pay/international block and the ~20 regional channels. That is the line between
"covers everything our other guides cover" and "triples the request count for
channels nobody else carries".

## Follow-up

- TV+ publishes 90 channels no other provider carries. A later pass could add
  the mainstream Turkish subset if there is demand; the ids would be new
  spellings (so a collision check and a fresh agreement decision each time).
- The two probe scripts are scratch. They live in `/tmp`, so re-probe with a
  fresh `ChannelList` call when looking for newly added channels; the adapter's
  header comment records the 172/155/17 numbers.
